#!/usr/bin/env node
// Merge gate for parallel task orchestration: validate audit verdicts, then merge audit-passing
// branches in the order the scheduling ledger implies.
//
// Why this exists: Orca's Run ends when every Dispatch settles. Nothing upstream turns a finished
// run into a change in the base branch, and nothing binds an audit verdict to the merge that
// follows it — a change can reach main having never been reviewed, and two branches can collide at
// merge time in a way nobody planned for. This is the endpoint of the run, and it fails closed.
//
// Why a script rather than an agent: a merge is a deterministic sequence of git operations with a
// contract attached. Handing it to a model would trade a checkable decision for an unpredictable
// one. Conflicts are reported, never resolved: only a human owns a conflict.
//
// Usage:
//   orchestration-merge-gate.mjs verify --ledger <path> [--json]
//   orchestration-merge-gate.mjs merge  --ledger <path> --repo <path> --base <ref> [--execute] [--json]

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import {
  buildView,
  appendEntry,
  defaultLedgerPath,
  normalizeEntry,
  readLedger
} from './orchestration-schedule-ledger.mjs'

const PASSING_VERDICTS = new Set(['pass', 'pass_with_findings'])
const ALL_VERDICTS = new Set(['pass', 'pass_with_findings', 'fail'])

export function runGit(args, cwd) {
  // stderr is captured, not inherited: git's progress chatter ("Already on 'main'") would land
  // inside a report that an operator has to read, and it still reaches a caller through the error.
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

export function gitSucceeds(args, cwd) {
  try {
    runGit(args, cwd)
    return true
  } catch {
    return false
  }
}

/**
 * The verdict contract, in one place, so the gate that reads a verdict and the writer that records
 * one cannot drift apart. A verdict is only as good as the evidence behind it, and contradictions
 * between the two are the failure this exists to catch.
 */
export function verdictContractProblems(verdict, findings, reportCount, regression) {
  const problems = []
  if (!verdict) {
    problems.push('no verdict recorded')
  } else if (!ALL_VERDICTS.has(verdict)) {
    problems.push(`unknown verdict "${verdict}"; expected pass | pass_with_findings | fail`)
  }
  if (verdict === 'pass' && findings.length > 0) {
    problems.push('verdict is pass but findings are present')
  }
  if (verdict === 'pass_with_findings' && findings.length === 0) {
    problems.push('verdict is pass_with_findings but no finding is recorded')
  }
  if (verdict === 'fail' && !findings.some((finding) => finding.severity === 'blocker')) {
    problems.push('verdict is fail but no finding is marked as a blocker')
  }
  for (const finding of findings) {
    if (!finding.file || finding.line == null) {
      problems.push(`a finding is missing its location: ${JSON.stringify(finding)}`)
    } else if (!finding.evidence) {
      problems.push(`${finding.file}:${finding.line} has no reproducible evidence`)
    }
  }
  if (verdict && reportCount === 0) {
    problems.push('no report path recorded, so the audit cannot be re-read')
  }
  // A verdict with no command and no output behind it is a claim about testing, not evidence of it.
  // The result may be a failure — that is exactly what a fail verdict is for — but it must exist.
  if (verdict && (!regression || !regression.command)) {
    problems.push('no regression recorded, so nothing proves the change was tested')
  }
  return problems
}

function normalizeFindings(findings) {
  if (!Array.isArray(findings)) {
    return []
  }
  return findings.map((finding) =>
    typeof finding === 'string'
      ? { file: finding, line: null, severity: 'blocker', evidence: '' }
      : finding
  )
}

/**
 * Validate every audit verdict against the contract in the plan. The point of an audit is that
 * someone can check it later, so a verdict with no retrievable report is not a pass — it is an
 * unrecorded claim, and it blocks the merge exactly like a missing audit does.
 */
export function validateVerdicts(folded) {
  const rows = []
  for (const task of folded.tasks) {
    const audited = task.role === 'auditor' || task.verdict != null
    if (!audited) {
      continue
    }
    const findings = normalizeFindings(task.findings)
    rows.push({
      id: task.id,
      role: task.role,
      verdict: task.verdict,
      findings: findings.length,
      regression: task.regression ?? null,
      reports: task.reportPaths,
      problems: verdictContractProblems(
        task.verdict,
        findings,
        task.reportPaths.length,
        task.regression
      )
    })
  }
  return rows
}

/**
 * Audits that did not pass, plus landable work nobody audited. Anything here blocks a merge.
 *
 * An audit covers the tasks it depends on, so coverage is read off the DAG rather than off naming:
 * `audit_a` exists in the ledger whether or not anyone remembers that it audited `impl_a`.
 */
export function computeMergeReadiness(folded) {
  const rows = validateVerdicts(folded)
  const problemsByTask = new Map(rows.map((row) => [row.id, row]))
  const auditors = folded.tasks.filter((task) => task.role === 'auditor')
  const blockers = []

  for (const row of rows) {
    if (row.problems.length > 0) {
      blockers.push(`${row.id}: ${row.problems.join('; ')}`)
    } else if (!PASSING_VERDICTS.has(row.verdict)) {
      blockers.push(`${row.id}: verdict is ${row.verdict}`)
    }
  }

  for (const task of folded.tasks) {
    if (task.role === 'merger' || task.role === 'coordinator' || task.role === 'auditor') {
      continue
    }
    if (task.state !== 'completed') {
      blockers.push(`${task.id}: state is ${task.state}, not completed`)
    }
    const covering = auditors.filter((auditor) => auditor.deps.has(task.id))
    if (covering.length === 0) {
      blockers.push(`${task.id}: landed without an audit verdict`)
      continue
    }
    const passing = covering.filter((auditor) => {
      const row = problemsByTask.get(auditor.id)
      return row && row.problems.length === 0 && PASSING_VERDICTS.has(row.verdict)
    })
    if (passing.length === 0) {
      blockers.push(
        `${task.id}: no covering audit passed (${covering.map((a) => a.id).join(', ')})`
      )
    }
  }

  for (const task of folded.tasks) {
    for (const gate of task.gates.values()) {
      if (!gate.resolved) {
        blockers.push(`${task.id}: gate ${gate.id} is unresolved`)
      }
      if (gate.resolved && gate.choice && !PASSING_VERDICTS.has(gate.choice)) {
        blockers.push(`${task.id}: gate ${gate.id} was resolved "${gate.choice}"`)
      }
    }
  }

  return { rows, blockers, ready: blockers.length === 0 }
}

/**
 * Read what the real repository says, so the plan is built on branches that exist and a base that
 * is not moving under the merge. `behind` is the number of base commits a branch has not picked up,
 * which is the whole reason a dispatch-time staleness check cannot be the merge-time check.
 */
export function inspectRepository(repo, base, branches) {
  const status = gitSucceeds(['status', '--porcelain'], repo)
    ? runGit(['status', '--porcelain'], repo)
    : null
  const info = {
    base,
    baseExists: gitSucceeds(['rev-parse', '--verify', `${base}^{commit}`], repo),
    worktreeClean: status === '',
    worktreeStatus: status,
    branches: []
  }
  for (const branch of branches) {
    const entry = { name: branch, exists: false, behind: 0, ahead: 0, merged: false }
    if (gitSucceeds(['rev-parse', '--verify', `${branch}^{commit}`], repo)) {
      entry.exists = true
      entry.merged = gitSucceeds(['merge-base', '--is-ancestor', branch, base], repo)
      const counts = runGit(['rev-list', '--left-right', '--count', `${base}...${branch}`], repo)
        .split('s+')
        .map((value) => Number.parseInt(value, 10))
      entry.behind = counts[0] ?? 0
      entry.ahead = counts[1] ?? 0
    }
    info.branches.push(entry)
  }
  return info
}

/**
 * Build the ordered merge plan. The order comes from the ledger's write-set analysis, so the
 * branches that touch unrelated files land first and the conflict surface stays small.
 */
export function buildMergePlan(view, repo, base) {
  const readiness = computeMergeReadiness(view.folded)
  const branchOf = (id) => view.folded.tasks.find((task) => task.id === id)?.placement?.base ?? null
  const ordered = view.order
    .map((id) => {
      const task = view.folded.tasks.find((candidate) => candidate.id === id)
      return { id, branch: branchOf(id), files: [...(task?.files ?? [])] }
    })
    .filter((item) => item.branch && item.branch !== base)

  const inspection = inspectRepository(repo, base, [...new Set(ordered.map((item) => item.branch))])
  const conflicts = view.matrix.conflicts.map((conflict) => ({
    ...conflict,
    owner: null
  }))

  const steps = []
  for (const [index, item] of ordered.entries()) {
    const branchInfo = inspection.branches.find((entry) => entry.name === item.branch)
    const touchedByOthers = conflicts
      .filter((conflict) => conflict.a === item.id || conflict.b === item.id)
      .map((conflict) => (conflict.a === item.id ? conflict.b : conflict.a))
    steps.push({
      order: index + 1,
      task: item.id,
      branch: item.branch,
      files: item.files,
      exists: branchInfo?.exists ?? false,
      behind: branchInfo?.behind ?? 0,
      alreadyMerged: branchInfo?.merged ?? false,
      sharesFilesWith: touchedByOthers,
      commands: [
        `git -C ${repo} checkout ${base}`,
        `git -C ${repo} merge --no-ff ${item.branch}`,
        ...(branchInfo?.behind > 0
          ? [
              `# ${item.branch} is ${branchInfo.behind} commits behind; rebase it first if you accept the rewrite:`,
              `# git -C ${repo} checkout ${item.branch} && git -C ${repo} rebase ${base}`
            ]
          : [])
      ]
    })
  }

  return {
    readiness,
    inspection,
    conflicts,
    steps,
    ready: readiness.ready && inspection.worktreeClean
  }
}

/**
 * Perform the merges in plan order. A conflict aborts and restores the repository rather than being
 * resolved here: picking a side automatically is exactly the decision this gate exists to force a
 * human to make.
 *
 * Rebasing is opt-in (`rebase: true`) because it rewrites the feature branch, and that branch is
 * often already pushed. The default merges without touching branch history and reports how far
 * behind each branch is, so the operator decides whether a rewrite is worth it.
 */
export function executeMerge(plan, repo, { rebase = false } = {}) {
  const base = plan.inspection.base
  const merged = []
  const todo = plan.steps.filter((step) => !step.alreadyMerged)
  if (todo.length === 0) {
    // Saying "all branches merged" for an empty plan would be a success claim about nothing.
    return {
      merged,
      conflict: null,
      outcome: plan.steps.length === 0 ? 'nothing to merge' : 'already merged'
    }
  }
  for (const step of todo) {
    if (!step.exists) {
      return {
        merged,
        conflict: { branch: step.branch, reason: 'branch is missing', detail: '' },
        outcome: 'conflict'
      }
    }
    try {
      if (rebase) {
        runGit(['checkout', step.branch], repo)
        runGit(['rebase', base], repo)
      }
      runGit(['checkout', base], repo)
      runGit(
        ['merge', '--no-ff', '-m', `merge ${step.branch} (task ${step.task})`, step.branch],
        repo
      )
      merged.push(step.branch)
    } catch (error) {
      gitSucceeds(['merge', '--abort'], repo)
      gitSucceeds(['rebase', '--abort'], repo)
      // Leave the repository on the base branch, mid-nothing, whoever won the race to fail.
      gitSucceeds(['checkout', base], repo)
      return {
        merged,
        conflict: { branch: step.branch, reason: 'conflict', detail: String(error.message) },
        outcome: 'conflict'
      }
    }
  }
  return { merged, conflict: null, outcome: 'merged' }
}

/**
 * Record a worker's own completion into the ledger.
 *
 * This closes the loop the merge gate depends on: the gate reads verdicts, findings, reports and
 * touched files out of the ledger, and without a writer for `worker_done` those fields are never
 * there, so every real run would report "landed without an audit verdict" forever. The contract is
 * checked here, where the data enters, so a contradictory verdict is refused at the moment it is
 * written rather than surfacing as a closed gate three steps later.
 */
export function buildDoneEntry(input) {
  const findings = input.finding.map((raw) => {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return {
      file: parsed.file ?? null,
      line: parsed.line ?? null,
      severity: parsed.severity ?? null,
      evidence: parsed.evidence ?? null
    }
  })
  const regression =
    input.regression == null
      ? null
      : {
          command: input.regression.command ?? null,
          result: input.regression.result ?? null
        }
  const entry = {
    run: input.run,
    event: 'worker-done',
    task: input.task,
    role: input.role ?? null,
    dispatch: input.dispatch ?? null,
    state: input.state ?? 'completed',
    outcome: input.outcome ?? null,
    verdict: input.verdict ?? null,
    findings,
    regression,
    reportPath: input.report ?? null,
    filesModified: input.file,
    deps: input.dep
  }
  if (entry.verdict || input.role === 'auditor') {
    const problems = verdictContractProblems(
      entry.verdict,
      findings,
      input.report ? 1 : 0,
      regression
    )
    if (problems.length > 0) {
      throw new Error(`verdict contract violated: ${problems.join('; ')}`)
    }
  }
  return entry
}

export function renderVerify(result) {
  const lines = ['AUDIT VERDICTS']
  if (result.rows.length === 0) {
    lines.push('  (no audit recorded)')
  }
  for (const row of result.rows) {
    lines.push(
      `  ${row.id.padEnd(14)} ${String(row.verdict ?? 'none').padEnd(20)} findings=${row.findings}` +
        ` reports=${row.reports.length} tested=${row.regression?.command ? 'yes' : 'NO'}`
    )
    for (const problem of row.problems) {
      lines.push(`      ! ${problem}`)
    }
  }
  lines.push('')
  lines.push(result.ready ? 'MERGE GATE: OPEN' : 'MERGE GATE: CLOSED')
  for (const blocker of result.blockers) {
    lines.push(`  blocked by ${blocker}`)
  }
  return lines.join('\n')
}

export function renderMerge(plan, repo) {
  const lines = []
  lines.push(`MERGE PLAN  base=${plan.inspection.base}  repo=${repo}`)
  lines.push(`  worktree ${plan.inspection.worktreeClean ? 'clean' : 'DIRTY — refusing to merge'}`)
  lines.push(`  gate ${plan.readiness.ready ? 'OPEN' : 'CLOSED'}`)
  lines.push('')
  lines.push('ORDER')
  for (const step of plan.steps) {
    const flags = [
      step.alreadyMerged ? 'already-merged' : null,
      step.behind > 0 ? `behind ${step.behind}` : null,
      step.sharesFilesWith.length > 0
        ? `shares files with ${step.sharesFilesWith.join(',')}`
        : null,
      !step.exists ? 'BRANCH MISSING' : null
    ]
      .filter(Boolean)
      .join(' | ')
    lines.push(`  ${step.order}. ${step.task.padEnd(14)} ${step.branch.padEnd(28)} ${flags}`)
  }
  if (plan.conflicts.length > 0) {
    lines.push('')
    lines.push('CONFLICTS NEED AN OWNER')
    for (const conflict of plan.conflicts) {
      lines.push(`  ${conflict.a} <-> ${conflict.b}: ${conflict.shared.join(', ')}`)
    }
  }
  return lines.join('\n')
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) {
      continue
    }
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    const value = next === undefined || next.startsWith('--') ? true : next
    if (value !== true) {
      i++
    }
    // Repeated flags collect: --file a --file b has to mean two files, not the last one twice.
    args[key] = key in args ? [].concat(args[key], value) : value
  }
  return args
}

function asList(value) {
  if (value === undefined) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

/** `--regression '{"command":"...","result":"..."}'`, or `--regression-command`/`-result` separately. */
function parseRegression(value) {
  if (value === undefined || value === true) {
    return null
  }
  const raw = Array.isArray(value) ? value.at(-1) : value
  try {
    return JSON.parse(raw)
  } catch {
    return { command: raw, result: null }
  }
}

/** Flags that repeat are the multi-value ones; everything else is taken last-wins. */
function doneInput(args) {
  return {
    run: args.run,
    task: args.task,
    role: asList(args.role).at(-1) ?? null,
    dispatch: asList(args.dispatch).at(-1) ?? null,
    state: asList(args.state).at(-1) ?? 'completed',
    outcome: asList(args.outcome).at(-1) ?? null,
    verdict: asList(args.verdict).at(-1) ?? null,
    report: asList(args.report).at(-1) ?? null,
    regression: parseRegression(args.regression),
    file: asList(args.file),
    finding: asList(args.finding),
    dep: asList(args.dep)
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)

  if (command === 'record-done') {
    const input = doneInput(args)
    try {
      const entry = buildDoneEntry(input)
      const ledgerPath = resolve(args.ledger ?? defaultLedgerPath(input.run))
      appendEntry(ledgerPath, normalizeEntry(entry))
      process.stdout.write(`recorded ${input.task} -> ${ledgerPath}\n`)
    } catch (error) {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    }
    return
  }

  if (!args.ledger) {
    process.stderr.write(
      'usage: orchestration-merge-gate.mjs <record-done|verify|merge> --ledger <path> [--repo <path> --base <ref>]\n'
    )
    process.exitCode = 1
    return
  }

  const ledgerPath = resolve(args.ledger)
  const view = buildView(readLedger(ledgerPath))

  if (command === 'verify') {
    const result = computeMergeReadiness(view.folded)
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      process.stdout.write(`${renderVerify(result)}\n`)
    }
    process.exitCode = result.ready ? 0 : 1
    return
  }

  if (command !== 'merge') {
    process.stderr.write('usage: orchestration-merge-gate.mjs <verify|merge> --ledger <path>\n')
    process.exitCode = 1
    return
  }

  const repo = resolve(args.repo ?? '.')
  const base = args.base ?? 'main'
  const plan = buildMergePlan(view, repo, base)

  if (args.json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  } else {
    process.stdout.write(`${renderMerge(plan, repo)}\n`)
  }

  if (!plan.ready) {
    process.stderr.write('merge gate is closed; nothing was merged\n')
    process.exitCode = 1
    return
  }
  if (!args.execute) {
    process.stderr.write('dry run only; pass --execute to perform the merges above\n')
    process.exitCode = 0
    return
  }

  const outcome = executeMerge(plan, repo, { rebase: args.rebase === true })
  for (const branch of outcome.merged) {
    process.stdout.write(`merged ${branch}\n`)
  }
  if (outcome.conflict) {
    process.stderr.write(
      `conflict merging ${outcome.conflict.branch} (${outcome.conflict.reason})\n` +
        'repository restored; assign the conflict to an owner and retry\n'
    )
    process.exitCode = 1
    return
  }
  if (outcome.outcome !== 'merged') {
    process.stderr.write(`${outcome.outcome}: the ledger names no landable branch past ${base}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`merged ${outcome.merged.length} branch(es) into ${base}\n`)
}

if (process.argv[1] && process.argv[1].endsWith('orchestration-merge-gate.mjs')) {
  main()
}
