#!/usr/bin/env node
// Dispatch the test wave into the run that already exists.
//
// Why this is not "just run the generated script again": that script opens a new Run first, and
// re-running it dispatched a second pair of implementers on top of work already done. A wave
// continuation has to name the existing Run and reuse the runtime task ids its dependencies
// already have, which is exactly the part the generated script does not carry.

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = '/Users/xutaohuang/workspace/ai/orca-wt-orca2'
const COORDINATOR = 'term_30379b7c-b7a4-4d7a-8ffe-3889c6eed754'
const RUN = process.argv[2]
const PLAN = JSON.parse(readFileSync(join(REPO, 'p4-pilot-plan.json'), 'utf8'))
const LEDGER = join(REPO, '.orca/orchestration-ledger', `${RUN}.jsonl`)
// The runtime task ids wave 0 already produced. Read from the runtime rather than hard-coded, so a
// re-run of this file cannot quietly depend on ids from a previous attempt.
const existing = JSON.parse(
  execFileSync('orca', ['orchestration', 'task-list', '--run', RUN, '--json'], { encoding: 'utf8' })
).result.tasks
const byTitle = new Map(existing.map((task) => [task.task_title, task.id]))

function orca(args, label) {
  let out
  try {
    out = execFileSync('orca', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`
    throw new Error(`orca ${args.slice(0, 3).join(' ')} failed: ${out.replace(/\s+/g, ' ').slice(0, 300)}`)
  }
  process.stdout.write(`[${label}] ok\n`)
  return JSON.parse(out)
}

for (const [planId, depId, depTitle] of [
  ['test_a', 'impl_a', 'wave barriers between waves'],
  ['test_b', 'impl_b', 'record what the merge actually did']
]) {
  const task = PLAN.tasks.find((candidate) => candidate.id === planId)
  const depTaskId = byTitle.get(depTitle)
  if (!depTaskId) throw new Error(`no runtime task for ${depId} (looked for title ${depTitle})`)

  const created = orca(
    [
      'orchestration', 'task-create',
      '--spec', task.spec,
      '--task-title', task.title,
      '--deps', JSON.stringify([depTaskId]),
      '--json'
    ],
    `${planId}:task-create`
  )
  const taskId = created.result.task?.id ?? created.result.id ?? created.result.taskId

  const started = orca(
    [
      'orchestration', 'worker-start',
      '--task', taskId,
      '--run', RUN,
      '--worktree', 'new-child',
      '--name', planId,
      '--base-branch', task.base,
      '--setup', 'run',
      '--agent', task.agent,
      '--from', COORDINATOR,
      '--json'
    ],
    `${planId}:worker-start`
  )
  const dispatchId = started.result?.dispatchId ?? null
  appendFileSync(
    LEDGER,
    `${JSON.stringify({
      run: RUN,
      task: planId,
      event: 'worker-start',
      role: task.role,
      agent: task.agent,
      model: null,
      effort: null,
      deps: [depId],
      placement: { worktree: planId, base: task.base, isolation: 'worktree' },
      state: 'ready',
      dispatch: dispatchId,
      nextAction: ['orca', 'orchestration', 'worker-show', '--dispatch', dispatchId ?? '', '--json']
    })}\n`
  )
  process.stdout.write(`[${planId}] task=${taskId} dispatch=${dispatchId} base=${task.base}\n`)
}
