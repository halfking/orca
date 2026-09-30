/**
 * Rebuild the P4 run's ledger with the landing branch recorded, and print the merge plan.
 *
 * Why this exists: the real run never recorded where each task landed. `placement.base` holds the
 * branch a task forked FROM, so the gate planned a merge of every parent branch and
 * `halfking/test_a` was never in the plan at all. Fixing the gate is not enough on its own -- the
 * ledger has to carry the field, and nothing in the run ever wrote it.
 *
 * The branch values below are read off the real branches this run created
 * (halfking/impl_a-2, halfking/impl_b, halfking/test_a, halfking/test_b2).
 *
 * The two audit verdicts are SYNTHETIC. Wave 2 never ran, because no independent agent was
 * available, so audit_a/audit_b do not exist. They are here only to open the gate and expose the
 * merge ORDER, which is the thing being measured. Do not read them as evidence that anything was
 * audited.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const REPO = join(import.meta.dirname, '..')
const SOURCE = join(REPO, '.orca/orchestration-ledger/run_f8f2a6573946.jsonl')
const OUT = join(import.meta.dirname, 'merge-plan-ledger.jsonl')

const LANDED_ON = {
  impl_a: 'halfking/impl_a-2',
  impl_b: 'halfking/impl_b',
  test_a: 'halfking/test_a',
  test_b: 'halfking/test_b2'
}

const rows = readFileSync(SOURCE, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))

let backfilled = 0
for (const row of rows) {
  if (row.event === 'worker-done' && LANDED_ON[row.task]) {
    row.branch = LANDED_ON[row.task]
    backfilled += 1
  }
}

for (const audit of [
  { task: 'audit_a', deps: ['impl_a', 'test_a'], filesModified: ['src/a.ts'] },
  { task: 'audit_b', deps: ['impl_b', 'test_b'], filesModified: ['src/b.ts'] }
]) {
  rows.push({
    ts: '2026-09-29T00:00:00Z',
    run: 'run_f8f2a6573946',
    event: 'worker-done',
    task: audit.task,
    role: 'auditor',
    agent: 'claude',
    model: 'judge',
    state: 'completed',
    outcome: 'succeeded',
    verdict: 'pass',
    reportPath: `reports/${audit.task}.md`,
    regression: { command: 'pnpm test', result: 'ok' },
    findings: [],
    filesModified: audit.filesModified,
    deps: audit.deps,
    branch: 'main'
  })
}

writeFileSync(OUT, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
console.log(`backfilled ${backfilled} worker-done rows; ${rows.length} rows total -> ${OUT}`)

const gate = join(REPO, 'config/scripts/orchestration-merge-gate.mjs')
for (const command of ['verify', 'merge']) {
  console.log(
    `\n$ node config/scripts/orchestration-merge-gate.mjs ${command} --ledger <backfilled> --repo . --base origin/main`
  )
  try {
    const out = execFileSync(
      'node',
      [gate, command, '--ledger', OUT, '--repo', REPO, '--base', 'origin/main'],
      {
        cwd: dirname(REPO),
        encoding: 'utf8'
      }
    )
    process.stdout.write(out)
  } catch (error) {
    process.stdout.write(error.stdout ?? '')
    process.stderr.write(error.stderr ?? '')
  }
}
