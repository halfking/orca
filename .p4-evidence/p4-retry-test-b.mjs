#!/usr/bin/env node
// Re-dispatch test_b after its first attempt was rejected.
//
// Why this is not `p4-wave1.mjs` again: that file dispatches the whole wave, and test_a already landed.
// Re-running it would open a second test_a on top of a branch that is done.
//
// Why a new runtime Task instead of `worker-start --retry-of`: the runtime records a task as `completed`
// as soon as the agent process exits cleanly, which it did — the rejection was the coordinator's verdict on
// the deliverable, not a runtime failure. `--retry-of` needs a *failed* Task and does not take a new --spec,
// so a retry would have re-sent the same spec that caused the rejection. Marking the old Task `failed`
// first is not bookkeeping for its own sake: it is the only way the runtime's own dependency graph stops
// reporting a rejected deliverable as done, and audit_b depends on it.
//
//   node p4-retry-test-b.mjs <runId> [coordinatorHandle]

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = '/Users/xutaohuang/workspace/ai/orca-wt-orca2'
const RUN = process.argv[2] ?? 'run_f8f2a6573946'
const COORDINATOR = process.argv[3] ?? 'term_30379b7c-b7a4-4d7a-8ffe-3889c6eed754'
const WORKTREE_NAME = 'test_b2'
const LEDGER = join(REPO, '.orca/orchestration-ledger', `${RUN}.jsonl`)
const PLAN = JSON.parse(readFileSync(join(REPO, 'p4-pilot-plan.json'), 'utf8'))

function orca(args, label) {
  let out
  try {
    out = execFileSync('orca', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`
    throw new Error(`orca ${args.slice(0, 3).join(' ')} failed: ${out.replace(/\s+/g, ' ').slice(0, 400)}`)
  }
  process.stdout.write(`[${label}] ok\n`)
  return JSON.parse(out)
}

orca(['orchestration', 'run-use', '--id', RUN, '--from', COORDINATOR, '--json'], 'run-use')

const tasks = orca(['orchestration', 'task-list', '--run', RUN, '--json'], 'task-list').result.tasks ?? []
const implB = tasks.find((task) => task.task_title === 'record what the merge actually did')
if (!implB) throw new Error('no runtime task for impl_b; the run is not the bound one')
const oldTestB = tasks.find((task) => task.task_title === 'tests for the merge record')
if (!oldTestB) throw new Error('no runtime task for the first test_b attempt')
if (oldTestB.status !== 'failed') {
  orca(
    ['orchestration', 'task-update', '--id', oldTestB.id, '--status', 'failed', '--run', RUN,
      '--from', COORDINATOR, '--json'],
    'task-update: first test_b -> failed'
  )
}

// A fresh worktree, not the old one: the rejected work is the evidence for why this retry exists, and
// reusing it would quietly destroy the only record of the first attempt.
const created = orca(
  ['worktree', 'create', '--name', WORKTREE_NAME, '--repo', `path:${REPO}`,
    '--base-branch', 'halfking/impl_b', '--setup', 'run', '--json'],
  `worktree create ${WORKTREE_NAME}`
)
const worktreePath =
  created.result?.worktree?.path ?? created.result?.worktreePath ?? created.result?.path
if (!worktreePath) {
  throw new Error(`worktree create returned no path: ${JSON.stringify(created.result).slice(0, 300)}`)
}

const spec = PLAN.tasks.find((task) => task.id === 'test_b').spec
const createdTask = orca(
  ['orchestration', 'task-create', '--spec', spec,
    '--task-title', 'tests for the merge record (attempt 2)',
    '--deps', JSON.stringify([implB.id]), '--json'],
  'task-create'
)
const taskId = createdTask.result.task?.id ?? createdTask.result.id ?? createdTask.result.taskId

const started = orca(
  ['orchestration', 'worker-start', '--task', taskId, '--run', RUN,
    '--worktree', `path:${worktreePath}`, '--agent', 'opencode', '--from', COORDINATOR, '--json'],
  'worker-start'
)
const dispatchId = started.result?.dispatchId ?? null

appendFileSync(
  LEDGER,
  `${JSON.stringify({
    run: RUN,
    task: 'test_b',
    attempt: 2,
    event: 'worker-start',
    role: 'test-author',
    agent: 'opencode',
    model: null,
    effort: null,
    deps: ['impl_b'],
    placement: { worktree: WORKTREE_NAME, base: 'halfking/impl_b', isolation: 'worktree' },
    state: 'ready',
    dispatch: dispatchId,
    runtimeTaskId: taskId,
    supersedes: { dispatch: 'ctx_27c778786539', runtimeTaskId: oldTestB.id },
    note:
      'attempt 2. attempt 1 rewrote this test file from vitest to node:test, so `node --test` passed while ' +
      'the repository runner found no tests at all. The acceptance command in the spec named the wrong ' +
      'runner; it now names vitest with the repository config, and the spec forbids swapping the runner.',
    nextAction: ['orca', 'orchestration', 'worker-show', '--dispatch', dispatchId ?? '', '--json']
  })}\n`
)

process.stdout.write(
  `test_b attempt 2: task=${taskId} dispatch=${dispatchId} worktree=${worktreePath}\n`
)
