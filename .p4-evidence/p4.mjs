#!/usr/bin/env node
// P4 pilot driver: runs the compiled plan's argv wave by wave against the live runtime.
//
// Why not just run the generated script: the script dispatches every wave back to back with no
// barrier (that missing barrier is exactly what impl_a is being paid to build), and its audit
// branch names are placeholders. So this executes the same argv, one wave at a time, with the repo
// pinned to the pilot worktree and the audit bases resolved from the real receipts.
//
// Every receipt is written to .p4-evidence/ so a post-mortem reads the runtime's own words.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const REPO = '/Users/xutaohuang/workspace/ai/orca-wt-orca2'
const EVIDENCE = join(REPO, '.p4-evidence')
// The Run is bound to one coordinator terminal; worker-start is fenced to it, so every dispatch
// from this driver must name that terminal. Without --from it answers consumer_fenced.
const COORDINATOR = 'term_30379b7c-b7a4-4d7a-8ffe-3889c6eed754'
const PLAN = JSON.parse(readFileSync(join(REPO, 'p4-pilot-plan.json'), 'utf8'))
const PLAN_TASK = new Map(PLAN.tasks.map((task) => [task.id, task]))
const STATE_FILE = join(EVIDENCE, 'pilot-state.json')
const LEDGER = join(REPO, '.orca/orchestration-ledger')

mkdirSync(LEDGER, { recursive: true })

function state() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { run: null, tasks: {}, dispatches: {}, auditBase: {} }
  }
}
function save(next) {
  writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`)
}

function orca(args, label) {
  let stdout = ''
  try {
    stdout = execFileSync('orca', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    stdout = `${error.stdout ?? ''}${error.stderr ?? ''}`
    writeFileSync(join(EVIDENCE, `${label}.json`), stdout)
    throw new Error(`orca ${args.slice(0, 3).join(' ')} failed: ${stdout.replace(/\s+/g, ' ').slice(0, 300)}`)
  }
  writeFileSync(join(EVIDENCE, `${label}.json`), stdout)
  return JSON.parse(stdout)
}

function ledgerRecord(run, task, receipt, launch) {
  return {
    run,
    task,
    event: 'worker-start',
    role: PLAN_TASK.get(task).role,
    agent: launch.agent,
    model: launch.model ?? null,
    effort: launch.effort ?? null,
    deps: PLAN_TASK.get(task).deps ?? [],
    placement: { worktree: launch.worktree, base: launch.base, isolation: 'worktree' },
    state: 'ready',
    nextAction: [
      'orca', 'orchestration', 'worker-show', '--dispatch', receipt?.result?.dispatchId ?? '', '--json'
    ]
  }
}

const [command, ...rest] = process.argv.slice(2)

if (command === 'run-create') {
  const receipt = orca(
    ['orchestration', 'run-create', '--objective', PLAN.objective, '--json'],
    `${rest[0] ?? '00'}-run-create`
  )
  const next = state()
  next.run = receipt.result.run.id
  save(next)
  process.stdout.write(`${next.run}\n`)
} else if (command === 'task-create') {
  const planId = rest[0]
  const label = rest[1] ?? planId
  const task = PLAN_TASK.get(planId)
  if (!task) throw new Error(`unknown plan task ${planId}`)
  const next = state()
  const depIds = (rest.slice(2).length ? rest.slice(2) : task.deps ?? []).map((dep) => {
    const id = next.tasks[dep]
    if (!id) throw new Error(`dependency ${dep} has no runtime task id yet`)
    return id
  })
  const receipt = orca(
    [
      'orchestration', 'task-create',
      '--spec', task.spec,
      '--task-title', task.title ?? task.id,
      '--deps', JSON.stringify(depIds),
      '--json'
    ],
    label
  )
  const id = receipt.result.task?.id ?? receipt.result.id ?? receipt.result.taskId
  next.tasks[planId] = id
  save(next)
  process.stdout.write(`${id}\n`)
} else if (command === 'start') {
  const planId = rest[0]
  const label = rest[1] ?? planId
  const task = PLAN_TASK.get(planId)
  const next = state()
  const runtimeTaskId = next.tasks[planId]
  if (!runtimeTaskId) throw new Error(`${planId} has no runtime task id`)
  const base = planId.startsWith('audit_') ? next.auditBase[planId.replace('audit_', '')] : null
  if (planId.startsWith('audit_') && !base) {
    throw new Error(`audit base for ${planId} unresolved; the implementer branch is unknown`)
  }
  const name = planId.replace(/^impl_/, 'pilot-impl-').replace(/^test_/, 'pilot-test-')
    .replace(/^audit_/, 'pilot-audit-')
  const baseRef = base ?? 'pilot/p4-two-task-pilot'
  // `worker-start --worktree new-child` does not exist in orca 1.4.197: --worktree takes a repo
  // selector (path:/name:/branch:/active), and the rejected string comes back as selector_not_found.
  // The real shape is two steps — create the checkout, then start the worker against it by selector.
  // `name:` matched three worktrees at once and came back selector_ambiguous, so the created
  // checkout is addressed by its absolute path — the one selector form that cannot be ambiguous.
  const existing = orca(
    ['worktree', 'list', '--repo', `path:${REPO}`, '--json'],
    `${label}-worktree-list`
  )
  const found = (existing.result?.worktrees ?? []).find((w) => w.branch === `refs/heads/${name}`)
  const created = found
    ? { result: { worktree: found } }
    : orca(
        [
          'worktree', 'create',
          '--name', name,
          '--repo', `path:${REPO}`,
          '--base-branch', baseRef,
          '--setup', 'skip',
          '--json'
        ],
        `${label}-worktree-create`
      )
  const worktreePath = created.result?.worktree?.path
  if (!worktreePath) throw new Error(`no worktree path for ${name}`)
  const argv = [
    'orchestration', 'worker-start',
    '--task', runtimeTaskId,
    '--worktree', `path:${worktreePath}`,
    '--agent', task.agent,
    '--from', COORDINATOR,
    '--json'
  ]
  const receipt = orca(argv, label)
  const dispatchId = receipt.result?.dispatchId ?? receipt.result?.dispatch?.id ?? null
  next.dispatches[planId] = dispatchId
  next.branches = next.branches ?? {}
  next.branches[planId] = created.result?.worktree?.branch?.replace('refs/heads/', '') ?? base
  const entry = ledgerRecord(next.run, planId, receipt.result, {
    agent: task.agent,
    worktree: name,
    base: next.branches[planId]
  })
  writeFileSync(join(LEDGER, `${next.run}.jsonl`), `${JSON.stringify(entry)}\n`, { flag: 'a' })
  save(next)
  process.stdout.write(`${dispatchId ?? '(no dispatch id)'}\n`)
} else if (command === 'note-branch') {
  // The audit wave must check out the branch the implementer actually landed on; the compiled plan
  // can only carry a placeholder, so the real name is read off the dispatch receipt.
  const impl = rest[0]
  const branch = rest[1]
  const next = state()
  next.auditBase[impl] = branch
  save(next)
  process.stdout.write(`${impl} -> ${branch}\n`)
} else if (command === 'gate-create') {
  const planId = rest[0]
  const label = rest[1] ?? planId
  const next = state()
  const task = PLAN_TASK.get(planId)
  const receipt = orca(
    [
      'orchestration', 'gate-create',
      '--task', next.tasks[planId],
      '--question', 'Did every audit in this run return pass or pass_with_findings?',
      '--options', '["pass","fail"]',
      '--json'
    ],
    label
  )
  process.stdout.write(`${JSON.stringify(receipt.result?.gate ?? receipt.result)}\n`)
} else {
  process.stderr.write(
    'usage: p4.mjs <run-create|task-create|start|note-branch|gate-create> ...\n'
  )
  process.exitCode = 1
}
