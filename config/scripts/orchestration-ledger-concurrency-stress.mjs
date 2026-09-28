#!/usr/bin/env node
// Stress the shared ledger with concurrent writers, at two payload sizes.
//
// Why: the ledger is the one artifact every worker shares, so a torn line from
// two workers appending at once would corrupt the run's whole audit trail — and
// a run whose audit trail is corrupt is indistinguishable from a run with no
// audit trail. Small entries are almost certainly fine; the question is whether
// a wide entry (an audit with many findings) crosses the atomic-append threshold.

import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LEDGER = join(import.meta.dirname, 'orchestration-schedule-ledger.mjs')
const { parseLedger } = await import(LEDGER)

function run(args, stdin) {
  return new Promise((resolve) => {
    const child = execFile('node', [LEDGER, ...args], (error) => resolve(error))
    child.stdin.end(stdin)
  })
}

function bigEntry(index, findings) {
  return `${JSON.stringify({
    run: `stress_${findings}`,
    event: 'worker-done',
    task: `impl_${index}`,
    role: 'implementer',
    state: 'completed',
    filesModified: Array.from({ length: 20 }, (_, f) => `src/${findings}_${index}_${f}.ts`),
    findings: Array.from({ length: findings }, (_, n) => ({
      file: `src/deep/nested/path/to/file_${n}.ts`,
      line: n + 1,
      severity: 'major',
      evidence: `reproduction steps for finding ${n} in task ${index}, run ${findings}`
    })),
    reportPath: `reports/stress_${findings}_${index}.md`
  })}\n`
}

async function stress(findings, writers) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-stress-'))
  const ledger = join(dir, 'run.jsonl')
  await Promise.all(
    Array.from({ length: writers }, (_, index) =>
      run(['record', '--stdin', '--ledger', ledger], bigEntry(index, findings))
    )
  )
  const text = readFileSync(ledger, 'utf8')
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  let parsed = null
  let error = null
  try {
    parsed = parseLedger(text)
  } catch (err) {
    error = err.message
  }
  const tasks = new Set(parsed?.map((entry) => entry.task) ?? [])
  return {
    findings,
    bytes: text.length,
    lineCount: lines.length,
    parsedCount: parsed?.length ?? 0,
    distinctTasks: tasks.size,
    error,
    ok: parsed?.length === writers && tasks.size === writers
  }
}

const results = []
for (const findings of [0, 5, 40]) {
  const result = await stress(findings, 25)
  results.push(result)
  const status = result.ok ? 'OK  ' : 'FAIL'
  process.stdout.write(
    `${status} findings=${String(result.findings).padEnd(3)} ` +
      `lines=${result.lineCount} parsed=${result.parsedCount} distinct=${result.distinctTasks} ` +
      `bytes=${result.bytes}${result.error ? ` error=${result.error}` : ''}\n`
  )
}
process.exitCode = results.every((result) => result.ok) ? 0 : 1
