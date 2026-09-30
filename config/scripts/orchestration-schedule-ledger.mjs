#!/usr/bin/env node
// Orchestration scheduling ledger: an append-only record of every scheduling decision for one
// Run, plus the single command that renders the whole path from that record.
//
// Why: Orca persists the *state* of a Run (runs / tasks / worker_dispatches) but has no command
// that renders the *path* — which worker was dispatched for which task, in which role, on which
// model, into which worktree off which base, and what blocks it now. `worker-start --json` returns
// that information only in the instant it is produced, and nothing persists it as a reviewable
// trail. This tool fills that gap from the outside, using only `orca ... --json` receipts, so it
// needs no change to the runtime.
//
// Usage:
//   orchestration-schedule-ledger.mjs record --ledger <path> [--entry '<json>' | --receipts <file>]
//   orchestration-schedule-ledger.mjs view   --ledger <path> [--json]

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** Events the ledger understands. Anything else is stored verbatim and only affects the tree. */
export const LEDGER_EVENTS = ['worker-start', 'worker-done', 'gate-create', 'gate-resolve', 'note']

/** Task states that end a Task's lifecycle; everything else can still block a dependant. */
const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'circuit_broken'])

const ROLE_ORDER = ['coordinator', 'implementer', 'test-author', 'auditor', 'merger']

export function defaultLedgerPath(runId) {
  return resolve(process.cwd(), '.orca', 'orchestration-ledger', `${runId}.jsonl`)
}

/**
 * Normalize one raw entry into the ledger contract. Unknown fields are dropped rather than
 * passed through so a later reader cannot mistake an unverified shape for a recorded fact.
 */
export function normalizeEntry(raw) {
  const entry = {
    ts: raw.ts ?? new Date().toISOString(),
    run: requireString(raw.run, 'run'),
    event: raw.event ?? 'note',
    task: raw.task ?? null,
    dispatch: raw.dispatch ?? null,
    wave: Number.isInteger(raw.wave) ? raw.wave : null,
    role: raw.role ?? null,
    agent: raw.agent ?? null,
    model: raw.model ?? null,
    effort: raw.effort ?? null,
    placement: raw.placement ?? null,
    // The branch this task's work landed on. Distinct from placement.base, which is the branch it
    // forked from. Nothing in the tree recorded the landing branch until this field existed, and
    // buildMergePlan therefore merged every task's parent.
    branch: raw.branch ?? null,
    state: raw.state ?? null,
    stage: raw.stage ?? null,
    liveness: raw.liveness ?? null,
    outcome: raw.outcome ?? null,
    verdict: raw.verdict ?? null,
    findings: raw.findings ?? null,
    regression: raw.regression ?? null,
    nextAction: Array.isArray(raw.nextAction) ? raw.nextAction : null,
    runtimeTaskId: raw.runtimeTaskId ?? null,
    deps: Array.isArray(raw.deps) ? raw.deps : [],
    filesModified: Array.isArray(raw.filesModified) ? raw.filesModified : [],
    reportPath: raw.reportPath ?? null,
    gate: raw.gate ?? null
  }
  if (!LEDGER_EVENTS.includes(entry.event)) {
    throw new Error(`Unknown ledger event: ${entry.event}`)
  }
  return entry
}

function requireString(value, field) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Ledger entry requires a non-empty "${field}"`)
  }
  return value
}

/** Parse a JSONL ledger body, skipping blank lines and reporting the line number on bad JSON. */
export function parseLedger(text) {
  const entries = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '') {
      continue
    }
    try {
      entries.push(normalizeEntry(JSON.parse(line)))
    } catch (error) {
      throw new Error(`ledger line ${i + 1}: ${error.message}`)
    }
  }
  return entries
}

export function readLedger(path) {
  return existsSync(path) ? parseLedger(readFileSync(path, 'utf8')) : []
}

export function appendEntry(path, entry) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8')
}

/**
 * Fold the append-only trail into current state: one row per Task, its latest Dispatch, the wave
 * implied by the dependency DAG, and the union of every file any of its workers touched.
 */
export function foldLedger(entries) {
  const tasks = new Map()
  for (const entry of entries) {
    const id = entry.task ?? entry.dispatch
    if (!id) {
      continue
    }
    if (!tasks.has(id)) {
      tasks.set(id, {
        id,
        title: null,
        role: null,
        agent: null,
        model: null,
        effort: null,
        placement: null,
        branch: null,
        state: 'pending',
        dispatch: null,
        runtimeTaskId: null,
        liveness: null,
        stage: null,
        outcome: null,
        verdict: null,
        findings: null,
        regression: null,
        nextAction: null,
        files: new Set(),
        reportPaths: [],
        gates: new Map(),
        deps: new Set()
      })
    }
    const task = tasks.get(id)
    if (entry.dispatch) {
      task.dispatch = entry.dispatch
    }
    // The plan's own id is what the DAG, the merge order and every report are keyed on. The
    // runtime id is kept beside it, never instead of it: a view keyed on runtime ids fragments
    // the moment a task is re-created, and stops matching the plan that produced it.
    if (entry.runtimeTaskId) {
      task.runtimeTaskId = entry.runtimeTaskId
    }
    if (entry.role) {
      task.role = entry.role
    }
    if (entry.agent) {
      task.agent = entry.agent
    }
    if (entry.model) {
      task.model = entry.model
    }
    if (entry.effort) {
      task.effort = entry.effort
    }
    if (entry.placement) {
      task.placement = entry.placement
    }
    if (entry.branch) {
      task.branch = entry.branch
    }
    if (entry.state) {
      task.state = entry.state
    }
    if (entry.stage) {
      task.stage = entry.stage
    }
    if (entry.liveness) {
      task.liveness = entry.liveness
    }
    if (entry.outcome) {
      task.outcome = entry.outcome
    }
    if (entry.verdict) {
      task.verdict = entry.verdict
    }
    if (entry.findings != null) {
      task.findings = entry.findings
    }
    if (entry.regression != null) {
      task.regression = entry.regression
    }
    if (entry.nextAction) {
      task.nextAction = entry.nextAction
    }
    for (const dep of entry.deps) {
      task.deps.add(dep)
    }
    for (const file of entry.filesModified) {
      task.files.add(file)
    }
    if (entry.reportPath) {
      task.reportPaths.push(entry.reportPath)
    }
    if (entry.gate?.id) {
      task.gates.set(entry.gate.id, entry.gate)
    }
  }

  const list = [...tasks.values()]
  for (const task of list) {
    task.wave = waveOf(task, tasks)
  }
  return { run: entries[0]?.run ?? null, tasks: list }
}

function waveOf(task, tasks) {
  const deps = [...task.deps]
  if (deps.length === 0) {
    return 0
  }
  let depth = 0
  for (const dep of deps) {
    const parent = tasks.get(dep)
    depth = Math.max(depth, parent ? waveOf(parent, tasks) + 1 : 1)
  }
  return depth
}

/** Unmet dependencies and unresolved gates, per Task. Both are reasons a Task cannot start. */
export function computeBlocking(folded) {
  const rows = []
  for (const task of folded.tasks) {
    // A dependency counts as unmet when its own Task has not settled. A dependency absent from
    // the ledger fails closed: an unrecorded Task is unknown, and unknown is not satisfied.
    const unmetDeps = [...task.deps].filter((dep) => {
      const parent = folded.tasks.find((candidate) => candidate.id === dep)
      return !parent || !TERMINAL_TASK_STATES.has(parent.state)
    })
    const pendingGates = [...task.gates.values()].filter((gate) => !gate.resolved)
    rows.push({
      id: task.id,
      settled: TERMINAL_TASK_STATES.has(task.state),
      unmetDeps,
      pendingGates: pendingGates.map((gate) => gate.id),
      actionable:
        unmetDeps.length === 0 && pendingGates.length === 0 && !TERMINAL_TASK_STATES.has(task.state)
    })
  }
  return rows
}

/** Pairwise write-set overlap. Two tasks touching the same file are a merge conflict waiting. */
export function computeWriteSetMatrix(folded) {
  const rows = []
  const conflicts = []
  const ordered = [...folded.tasks].sort((a, b) => a.id.localeCompare(b.id))
  for (let i = 0; i < ordered.length; i++) {
    const row = { id: ordered[i].id, cells: {} }
    for (let j = 0; j < ordered.length; j++) {
      if (i === j) {
        row.cells[ordered[j].id] = 0
        continue
      }
      const shared = [...ordered[i].files].filter((file) => ordered[j].files.has(file))
      row.cells[ordered[j].id] = shared.length
      // Report each conflicting pair once: the matrix cell is symmetric, the owner list is not.
      if (shared.length > 0 && i < j) {
        conflicts.push({ a: ordered[i].id, b: ordered[j].id, shared })
      }
    }
    rows.push(row)
  }
  return { rows, conflicts }
}

/** Roles that produce no landable change of their own; they route and verify, they never merge. */
const NON_LANDABLE_ROLES = new Set(['coordinator', 'auditor', 'merger'])

/**
 * Suggested merge order for the tasks that actually carry a change into the baseline.
 *
 * Least-conflicting first, so conflict surface stays as small as possible. A task with no recorded
 * write set sorts last: unknown is not small, and merging blind is the exact failure this view
 * exists to prevent.
 */
export function suggestMergeOrder(folded, matrix) {
  const weight = new Map()
  for (const row of matrix.rows) {
    weight.set(
      row.id,
      Object.values(row.cells).reduce((sum, n) => sum + n, 0)
    )
  }
  return [...folded.tasks]
    .filter((task) => task.role == null || !NON_LANDABLE_ROLES.has(task.role))
    .sort((a, b) => {
      const known = Number(b.files.size > 0) - Number(a.files.size > 0)
      if (known !== 0) {
        return known
      }
      const wa = weight.get(a.id) ?? 0
      const wb = weight.get(b.id) ?? 0
      if (wa !== wb) {
        return wa - wb
      }
      return a.id.localeCompare(b.id)
    })
    .map((task) => task.id)
}

function pad(value, width) {
  const text = value == null || value === '' ? '-' : String(value)
  return text.length >= width ? text.slice(0, width) : text.padEnd(width)
}

/** Verdict and outcome are never truncated: `pass_with_findings` cut to `pass_with_` reads as pass. */
function padVerdict(value) {
  const text = value == null || value === '' ? '-' : String(value)
  return text.padEnd(20)
}

export function renderView(folded, blocking, matrix, order) {
  const lines = []
  lines.push(`RUN ${folded.run ?? '(unknown)'}  tasks=${folded.tasks.length}`)
  lines.push('')
  lines.push('SCHEDULING PATH')
  const maxWave = folded.tasks.reduce((max, task) => Math.max(max, task.wave), 0)
  for (let wave = 0; wave <= maxWave; wave++) {
    const tasks = folded.tasks.filter((task) => task.wave === wave)
    if (tasks.length === 0) {
      continue
    }
    lines.push(`  wave ${wave}`)
    for (const task of tasks) {
      const placement = task.placement
        ? `${task.placement.worktree ?? '?'}@${task.placement.base ?? '?'}`
        : '-'
      lines.push(
        `    ${pad(task.id, 14)} ${pad(task.role, 13)} ${pad(task.agent, 9)} ` +
          `${pad(task.model, 22)} ${pad(task.effort, 7)} ${pad(task.state, 11)} ` +
          `${padVerdict(task.verdict ?? task.outcome)} ${pad(placement, 28)} files=${task.files.size}`
      )
    }
  }

  lines.push('')
  lines.push('BLOCKING')
  const blocked = blocking.filter((row) => row.unmetDeps.length > 0 || row.pendingGates.length > 0)
  if (blocked.length === 0) {
    lines.push('  (nothing blocked)')
  }
  for (const row of blocked) {
    const why = [
      row.unmetDeps.length > 0 ? `deps:${row.unmetDeps.join(',')}` : null,
      row.pendingGates.length > 0 ? `gates:${row.pendingGates.join(',')}` : null
    ]
      .filter(Boolean)
      .join(' ')
    lines.push(`  ${pad(row.id, 14)} ${why}`)
  }

  lines.push('')
  lines.push('ACTIONABLE NOW')
  const ready = blocking.filter((row) => row.actionable)
  if (ready.length === 0) {
    lines.push('  (none)')
  }
  for (const row of ready) {
    const task = folded.tasks.find((t) => t.id === row.id)
    const argv = task?.nextAction ?? [
      'orca',
      'orchestration',
      'worker-start',
      '--task',
      task?.id ?? row.id,
      '--json'
    ]
    lines.push(`  ${row.id}: ${argv.join(' ')}`)
  }

  lines.push('')
  lines.push('WRITE-SET OVERLAP')
  if (matrix.rows.length === 0) {
    lines.push('  (none)')
  }
  for (const row of matrix.rows) {
    const cells = Object.entries(row.cells)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => `${id}=${n}`)
      .join(' ')
    lines.push(`  ${pad(row.id, 14)} ${cells === '' ? 'no overlap' : cells}`)
  }
  if (matrix.conflicts.length > 0) {
    lines.push('  conflicts needing an owner:')
    for (const conflict of matrix.conflicts) {
      lines.push(`    ${conflict.a} <-> ${conflict.b}: ${conflict.shared.join(', ')}`)
    }
  }

  lines.push('')
  lines.push('SUGGESTED MERGE ORDER')
  for (const [index, id] of order.entries()) {
    const task = folded.tasks.find((t) => t.id === id)
    lines.push(
      `  ${index + 1}. ${pad(id, 14)} verdict=${padVerdict(task?.verdict ?? task?.outcome ?? null)} ` +
        `files=${pad(task?.files.size ?? 0, 4)} report=${task?.reportPaths.at(-1) ?? '-'}`
    )
  }

  lines.push('')
  lines.push('ROLE COVERAGE')
  for (const role of ROLE_ORDER) {
    const members = folded.tasks.filter((task) => task.role === role)
    lines.push(
      `  ${pad(role, 13)} ${members.length === 0 ? '(none)' : members.map((t) => t.id).join(', ')}`
    )
  }
  return lines.join('\n')
}

export function buildView(entries) {
  const folded = foldLedger(entries)
  const blocking = computeBlocking(folded)
  const matrix = computeWriteSetMatrix(folded)
  const order = suggestMergeOrder(folded, matrix)
  return { folded, blocking, matrix, order }
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      i++
    }
  }
  return args
}

function runRecord(args) {
  const sources = []
  if (args.stdin) {
    for (const line of readFileSync(0, 'utf8').split('\n')) {
      if (line.trim() !== '') {
        sources.push(JSON.parse(line))
      }
    }
  }
  if (args.entry) {
    sources.push(JSON.parse(args.entry))
  }
  if (args.receipts) {
    for (const line of readFileSync(args.receipts, 'utf8').split('\n')) {
      if (line.trim() !== '') {
        sources.push(JSON.parse(line))
      }
    }
  }
  if (sources.length === 0) {
    throw new Error('record needs --stdin, --entry <json> or --receipts <jsonl>')
  }
  const run = requireString(args.run ?? sources[0].run, 'run')
  const ledgerPath = resolve(args.ledger ?? defaultLedgerPath(run))
  for (const source of sources) {
    appendEntry(ledgerPath, normalizeEntry({ run, ...source }))
  }
  process.stdout.write(
    `recorded ${sources.length} entr${sources.length === 1 ? 'y' : 'ies'} -> ${ledgerPath}\n`
  )
}

function runView(args) {
  const ledgerPath = resolve(args.ledger)
  if (!existsSync(ledgerPath)) {
    throw new Error(`ledger not found: ${ledgerPath}`)
  }
  const view = buildView(readLedger(ledgerPath))
  if (args.json) {
    const serialized = {
      run: view.folded.run,
      tasks: view.folded.tasks.map((task) => ({
        ...task,
        files: [...task.files],
        deps: [...task.deps],
        gates: [...task.gates.values()]
      })),
      blocking: view.blocking,
      writeSetMatrix: view.matrix,
      mergeOrder: view.order
    }
    process.stdout.write(`${JSON.stringify(serialized, null, 2)}\n`)
    return
  }
  process.stdout.write(`${renderView(view.folded, view.blocking, view.matrix, view.order)}\n`)
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  if (command === 'record') {
    return runRecord(args)
  }
  if (command === 'view') {
    return runView(args)
  }
  process.stderr.write('usage: orchestration-schedule-ledger.mjs <record|view> [options]\n')
  process.exitCode = 1
}

if (process.argv[1] && process.argv[1].endsWith('orchestration-schedule-ledger.mjs')) {
  main()
}
