#!/usr/bin/env node
// Wait until the wave's dispatches settle, printing only state changes.
//
// Why not `orchestration check --wait`: check names its caller with --terminal, and the coordinator
// here is a shell, not the terminal the Run is bound to. Polling worker-list is the reading this
// situation supports, and printing transitions keeps the log to what actually changed.

import { execFileSync } from 'node:child_process'

const run = process.argv[2]
const deadline = Date.now() + Number(process.env.P4_WAIT_MS ?? 1500000)
const seen = new Map()

while (Date.now() < deadline) {
  const raw = execFileSync('orca', ['orchestration', 'worker-list', '--run', run, '--json'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  })
  const { result } = JSON.parse(raw)
  for (const worker of result.workers ?? []) {
    const key = `${worker.stage?.activity ?? '-'}|${worker.outcome ?? '-'}`
    if (seen.get(worker.dispatchId) !== key) {
      seen.set(worker.dispatchId, key)
      process.stdout.write(
        `${new Date().toISOString()} ${worker.dispatchId} ${worker.taskId} ` +
          `state=${worker.workerState}/${worker.dispatchStatus} activity=${worker.stage?.activity} ` +
          `outcome=${worker.outcome ?? '-'} attention=${JSON.stringify(worker.attention?.categories ?? [])}\n`
      )
    }
  }
  const settled = (result.workers ?? []).every((worker) =>
    ['completed', 'failed', 'abandoned', 'stopped'].includes(worker.workerState)
  )
  if (settled && (result.workers ?? []).length > 0) {
    process.stdout.write('all dispatches settled\n')
    process.exit(0)
  }
  await new Promise((resolve) => setTimeout(resolve, 15000))
}
process.stdout.write('deadline reached before every dispatch settled\n')
