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
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  buildView,
  appendEntry,
  defaultLedgerPath,
  normalizeEntry,
  readLedger
} from './orchestration-schedule-ledger.mjs'
import { buildDoneEntry, computeMergeReadiness } from './orchestration-verdict-contract.mjs'

// Re-exported so importers of the gate keep one import site; the contract has its own module for
// callers that only care about verdicts.
export {
  ALL_VERDICTS,
  PASSING_VERDICTS,
  buildDoneEntry,
  computeMergeReadiness,
  normalizeFindings,
  validateVerdicts,
  verdictContractProblems
} from './orchestration-verdict-contract.mjs'

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
 * The directory that actually has the base branch checked out, or null when nothing holds it.
 *
 * Why this exists: a parallel run is built on git worktrees, so the base branch is normally
 * checked out in one of them and a bare `git checkout <base>` from anywhere else fails outright —
 * git refuses to check out a branch twice. Merging into the worktree that already holds the base is
 * both the thing git permits and the thing an operator expects.
 */
export function findBaseWorktree(repo, base) {
  let listed
  try {
    listed = runGit(['worktree', 'list', '--porcelain'], repo)
  } catch {
    return null
  }
  let current = null
  for (const line of listed.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = line.slice('worktree '.length)
    } else if (line.startsWith('branch ') && current) {
      const ref = line.slice('branch '.length).trim()
      if (ref === `refs/heads/${base}`) {
        return current
      }
      current = null
    }
  }
  return null
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
  // Merge where the base branch already lives rather than trying to check it out and failing.
  const target = findBaseWorktree(repo, base) ?? repo
  const merged = []
  const todo = plan.steps.filter((step) => !step.alreadyMerged)
  if (todo.length > 0 && !plan.inspection.worktreeClean) {
    return {
      merged,
      conflict: null,
      outcome: `refused: the worktree holding ${base} has uncommitted changes`
    }
  }
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
        runGit(['checkout', step.branch], target)
        runGit(['rebase', base], target)
      }
      runGit(['checkout', base], target)
      runGit(
        ['merge', '--no-ff', '-m', `merge ${step.branch} (task ${step.task})`, step.branch],
        target
      )
      merged.push(step.branch)
    } catch (error) {
      gitSucceeds(['merge', '--abort'], target)
      gitSucceeds(['rebase', '--abort'], target)
      // Leave the repository on the base branch, mid-nothing, whoever won the race to fail.
      gitSucceeds(['checkout', base], target)
      return {
        merged,
        conflict: { branch: step.branch, reason: 'conflict', detail: String(error.message) },
        outcome: 'conflict'
      }
    }
  }
  return { merged, conflict: null, outcome: 'merged' }
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
    agent: asList(args.agent).at(-1) ?? null,
    model: asList(args.model).at(-1) ?? null,
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
  // A missing file and an empty file both fold to "no tasks", and both used to read as a pass.
  // Saying which one it was costs nothing and stops a typo'd --ledger from looking like approval.
  if (!existsSync(ledgerPath)) {
    process.stderr.write(`no such ledger: ${ledgerPath}\n`)
    process.exitCode = 1
    return
  }
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
