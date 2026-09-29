#!/usr/bin/env node
// Reproduce finding 17: buildMergePlan merges each task's PARENT branch.
//
// The gate resolves a task's branch as `placement.base`:
//
//   const branchOf = (id) => view.folded.tasks.find((t) => t.id === id)?.placement?.base ?? null
//
// `placement.base` is where a task forked FROM. The branch a task landed ON is nowhere in the
// ledger: normalizeEntry has no `branch` field at all. So on any ledger written the way the
// wave-plan compiler and the coordinator write them, the plan names the parent branch for every
// task — one link up the chain from what should be merged.
//
// The 56-test suite does not catch this, because its fixtures fill `placement.base` with the
// LANDING branch (`base: 'feature/a'`), which is the opposite of what a real writer puts there.
// The fixture mirrors the code's assumption, so the suite is green on the wrong behaviour.
//
// This script runs both shapes through the real functions and prints both plans side by side.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = '/Users/xutaohuang/workspace/ai/orca-wt-orca2'
const { buildView, parseLedger } = await import(join(REPO, 'config/scripts/orchestration-schedule-ledger.mjs'))
const { buildMergePlan } = await import(join(REPO, 'config/scripts/orchestration-merge-gate.mjs'))

const root = mkdtempSync(join(tmpdir(), 'p4-branch-resolution-'))
mkdirSync(join(root, 'src'), { recursive: true })

// A one-commit chain: impl -> test, exactly the shape the five-wave plan produces.
const CHAIN = [
  ['impl_a', 'feature/impl', 'feature/impl'],
  ['test_a', 'feature/impl', 'feature/test']
]

function ledger(shape) {
  return CHAIN.map(([id, forkFrom, landedOn]) => ({
    run: 'run_repro',
    task: id,
    event: 'worker-start',
    role: id.startsWith('impl') ? 'implementer' : 'test-author',
    agent: 'opencode',
    state: 'ready',
    deps: id === 'test_a' ? ['impl_a'] : [],
    // `shape` is the only thing that differs between the two runs below.
    placement: { worktree: id, base: shape === 'fork-from' ? forkFrom : landedOn, isolation: 'worktree' }
  }))
    .map((entry) => JSON.stringify(entry))
    .join('\n')
}

function planFor(shape) {
  const view = buildView(parseLedger(ledger(shape)))
  // An empty audit means the plan is refused, but buildMergePlan still resolves the branches, and
  // the printed ORDER is exactly what `merge --execute` would act on.
  const plan = buildMergePlan(view, root, 'main')
  return plan.steps.map((step) => `${step.task} -> ${step.branch}`)
}

const real = planFor('fork-from')
const fixture = planFor('landed-on')

console.log('ground truth in the repository:')
for (const [id, forkFrom, landedOn] of CHAIN) {
  console.log(`  ${id}: forked from ${forkFrom}, landed on ${landedOn}`)
}
console.log()
console.log('MERGE PLAN when placement.base means "forked from" (what a real writer emits):')
for (const line of real) console.log(`  ${line}`)
console.log()
console.log('MERGE PLAN when placement.base means "landed on" (what the test fixtures emit):')
for (const line of fixture) console.log(`  ${line}`)
console.log()

const wrong = real[0].endsWith('feature/impl') && !real[0].endsWith('feature/test')
const fixtureWorks = fixture[1]?.endsWith('feature/test')
console.log(`real-ledger plan names the parent branch: ${wrong ? 'YES — bug reproduced' : 'no'}`)
console.log(`test-fixture plan names the landed branch: ${fixtureWorks ? 'yes' : 'no'}`)
console.log()
console.log('Conclusion: the same code, fed by the two shapes, produces two different plans. The suite')
console.log('only ever exercises the second shape, so it passes while the first — the one real ledgers')
console.log('have — merges the wrong refs.')
process.exitCode = wrong && fixtureWorks ? 0 : 1
