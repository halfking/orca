#!/usr/bin/env node
// Finish the P4 pilot: audit -> verdict -> gate -> merge -> replay.
//
// Why this exists as a script: the pilot stopped one step short, and the step it stopped on is
// blocked by something outside the repo (an agent that cannot run). The blocked step had been
// re-entered by hand each time, and each hand-entered attempt failed late — a dispatch that dies at
// agent_readiness looks identical to a dispatch that was never made. `preflight` answers that first,
// so the next attempt costs a second and says exactly what is missing.
//
//   node p4-finish.mjs preflight            # is the audit wave runnable at all?
//   node p4-finish.mjs audit                # dispatch the two audits
//   node p4-finish.mjs verdicts             # validate each audit's worker_done, record it
//   node p4-finish.mjs gate                 # merge-gate verify
//   node p4-finish.mjs merge                # merge --execute --record-to
//   node p4-finish.mjs replay               # the whole run, from the ledger alone
//
// Every step is read-only except `audit` and `merge`, and both refuse to run unless preflight passes.

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = '/Users/xutaohuang/workspace/ai/orca-wt-orca2'
const RUN = process.env.P4_RUN ?? 'run_f8f2a6573946'
const COORDINATOR = process.env.P4_COORDINATOR ?? 'term_30379b7c-b7a4-4d7a-8ffe-3889c6eed754'
const AUDIT_AGENT = process.env.P4_AUDIT_AGENT ?? 'claude'
const LEDGER = join(REPO, '.orca/orchestration-ledger', `${RUN}.jsonl`)
const GATE_LEDGER = join(REPO, '.p4-evidence', 'merge-gate-ledger.jsonl')
const PLAN = JSON.parse(readFileSync(join(REPO, 'p4-pilot-plan.json'), 'utf8'))

function orca(args) {
  let out
  try {
    out = execFileSync('orca', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`
    throw new Error(`orca ${args.slice(0, 3).join(' ')}: ${out.replace(/\s+/g, ' ').slice(0, 300)}`)
  }
  return JSON.parse(out)
}

function gate(args) {
  try {
    return execFileSync('node', [join(REPO, 'config/scripts/orchestration-merge-gate.mjs'), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
}

const out = (line) => process.stdout.write(`${line}\n`)

/** Can the audit agent actually answer a trivial prompt? Not merely: is the binary on PATH. */
function agentAnswers(agent) {
  // The argv is the one thing that has to be right per agent: `-p` is not a flag these CLIs share,
  // and a wrong one produces a usage error that looks exactly like "agent is broken".
  const probe = {
    claude: ['claude', '-p', 'reply OK'],
    opencode: ['opencode', 'run', 'reply OK'],
    cursor: ['cursor-agent', '-p', 'reply OK']
  }
  const argv = probe[agent]
  if (!argv) return { ok: false, why: `no probe defined for agent "${agent}"` }
  try {
    const text = execFileSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 90_000
    })
    return text.trim().length > 0
      ? { ok: true }
      : { ok: false, why: `${agent} answered with nothing` }
  } catch (error) {
    const text = `${error.stdout ?? ''}${error.stderr ?? ''}`.replace(/\s+/g, ' ').trim()
    return { ok: false, why: `${agent}: ${text.slice(0, 200) || error.message}` }
  }
}

function preflight() {
  const problems = []
  const status = orca(['status', '--json'])
  if (!status.result?.runtime?.reachable) problems.push('Orca runtime is not reachable')

  const runTasks = orca(['orchestration', 'task-list', '--run', RUN, '--json']).result.tasks ?? []
  if (runTasks.length === 0) problems.push(`run ${RUN} has no task; the pilot run is not the bound one`)

  for (const branch of ['halfking/impl_a-2', 'halfking/impl_b']) {
    const found = execFileSync('git', ['rev-parse', '--verify', branch], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    if (!found) problems.push(`branch ${branch} does not exist`)
  }

  // The audit must be a different agent from the ones it audits, and that is enforced by the merge
  // gate rather than by good intentions — so an agent that cannot run fails here, before four
  // worker terminals have been spent on a dispatch that will die at agent_readiness.
  //
  // The agent is read from the LEDGER, not from task.result: that field carries the worker_report
  // envelope (provenance, messageId, subject, body) and has never held an agent. An earlier version
  // of this check read it anyway, found no agent, and quietly passed every time — the same shape as
  // the pilot's own finding that a stub can make a gate report success on data it never read.
  const auditedAgents = new Set(
    readLedgerEntries()
      .filter((entry) => entry.agent && entry.role !== 'auditor' && entry.role !== 'merger')
      .map((entry) => entry.agent)
  )
  if (auditedAgents.size > 0 && auditedAgents.has(AUDIT_AGENT)) {
    problems.push(
      `audit agent "${AUDIT_AGENT}" is the same agent that did the work (${[...auditedAgents].join(', ')}); ` +
        'the merge gate refuses an audit that is not independent'
    )
  }
  const probe = agentAnswers(AUDIT_AGENT)
  if (!probe.ok) problems.push(`audit agent cannot run a prompt — ${probe.why}`)

  if (problems.length > 0) {
    out('PREFLIGHT: NOT RUNNABLE')
    for (const problem of problems) out(`  - ${problem}`)
    return false
  }
  out('PREFLIGHT: runnable')
  return true
}

/** The ledger is the record of who ran what; a task's own result field is the worker's report. */
function readLedgerEntries() {
  if (!existsSync(LEDGER)) return []
  return readFileSync(LEDGER, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

function audit() {
  if (!preflight()) return
  orca(['orchestration', 'run-use', '--id', RUN, '--from', COORDINATOR, '--json'])
  const existing = orca(['orchestration', 'task-list', '--run', RUN, '--json']).result.tasks ?? []
  const byTitle = new Map(existing.map((task) => [task.task_title, task.id]))
  for (const [planId, depTitle] of [
    ['audit_a', 'tests for wave barriers'],
    ['audit_b', 'tests for the merge record']
  ]) {
    const task = PLAN.tasks.find((candidate) => candidate.id === planId)
    const depTaskId = byTitle.get(depTitle)
    if (!depTaskId) {
      out(`skip ${planId}: no runtime task for its dependency ("${depTitle}")`)
      continue
    }
    const created = orca([
      'orchestration', 'task-create',
      '--spec', task.spec,
      '--task-title', task.title,
      '--deps', JSON.stringify([depTaskId]),
      '--json'
    ])
    const taskId = created.result.task?.id ?? created.result.id ?? created.result.taskId
    const started = orca([
      'orchestration', 'worker-start',
      '--task', taskId,
      '--run', RUN,
      '--worktree', 'new-child',
      '--name', planId,
      '--base-branch', task.base,
      '--setup', 'run',
      '--agent', AUDIT_AGENT,
      '--from', COORDINATOR,
      '--json'
    ])
    appendFileSync(
      LEDGER,
      `${JSON.stringify({
        run: RUN,
        task: planId,
        event: 'worker-start',
        role: 'auditor',
        agent: AUDIT_AGENT,
        model: null,
        effort: null,
        deps: [depTitle],
        placement: { worktree: planId, base: task.base, isolation: 'worktree' },
        state: 'ready',
        dispatch: started.result?.dispatchId ?? null,
        nextAction: ['orca', 'orchestration', 'worker-show', '--dispatch', started.result?.dispatchId ?? '', '--json']
      })}\n`
    )
    out(`${planId}: task=${taskId} dispatch=${started.result?.dispatchId} base=${task.base}`)
  }
}

const [command] = process.argv.slice(2)

if (command === 'preflight') {
  preflight()
} else if (command === 'audit') {
  audit()
} else if (command === 'gate') {
  out(gate(['verify', '--ledger', GATE_LEDGER]))
} else if (command === 'merge') {
  out(gate(['merge', '--ledger', GATE_LEDGER, '--repo', REPO, '--base', 'main', '--record-to', LEDGER, '--execute']))
} else if (command === 'replay') {
  process.stdout.write(
    execFileSync('node', [join(REPO, 'config/scripts/orchestration-schedule-ledger.mjs'), 'view', '--ledger', LEDGER], {
      encoding: 'utf8'
    })
  )
} else {
  process.stderr.write('usage: p4-finish.mjs <preflight|audit|gate|merge|replay>\n')
  process.exitCode = 1
}
