#!/usr/bin/env node
// Can the landing branch be recovered from what the ledger already has?
//
// Finding 17's proposed fix needs a new ledger field (`branch`) and a settle helper, because the
// ledger records where a task forked FROM and never where it landed ON. That is a lot of new
// surface. Before adding any of it, this asks a cheaper question: can the repository answer it?
//
// For each task we have a fork base and a write set. A branch is a candidate when its merge-base
// with the fork base is the fork base itself (it really did fork there) and it carries commits
// touching the write set that the fork base does not have. That is a resolvable question against
// a real repository, and it needs no new field.
//
// It also has a known failure mode, which is the point of measuring rather than assuming: when a
// branch is reset onto its parent, the two are the same commit and nothing can tell them apart.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const REPO = '/Users/xutaohuang/workspace/ai/orca-wt-orca2'
const LEDGER = `${REPO}/.orca/orchestration-ledger/run_f8f2a6573946.jsonl`

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim()

// What the ledger actually holds: fork base + write set per task.
const tasks = new Map()
for (const line of readFileSync(LEDGER, 'utf8').split('\n')) {
  if (!line.trim()) continue
  const entry = JSON.parse(line)
  if (!entry.task) continue
  const task = tasks.get(entry.task) ?? { base: null, files: new Set() }
  if (entry.placement?.base) task.base = entry.placement.base
  for (const file of entry.filesModified ?? []) task.files.add(file)
  tasks.set(entry.task, task)
}

// Every branch the repository has, so the resolver is not handed a hand-picked candidate list.
const branches = git('branch', '--format=%(refname:short)').split('\n').filter(Boolean)
const base = 'origin/main'

function resolves(task) {
  if (!task.base || task.files.size === 0) return []
  return branches.filter((branch) => {
    // Forked where the ledger says it forked?
    let fork
    try {
      fork = git('merge-base', task.base, branch)
    } catch {
      return false
    }
    // The base tip is the wrong thing to compare against: it moves on after the dispatch, so a
    // branch that really did fork there will not equal it later. What matters is only that the
    // two share history at all.
    if (branch === task.base) return false
    // Carries work on the write set that the fork base does not?
    return [...task.files].some((file) => {
      const diff = `${task.base}...${branch}`
      return git('diff', '--name-only', diff, '--', file) === file
    })
  })
}
console.log(`base for the merge = ${base}`)
console.log(`branches considered = ${branches.length}\n`)
let ambiguous = 0
for (const [id, task] of tasks) {
  const hits = resolves(task)
  const tag = hits.length === 1 ? 'resolved' : hits.length === 0 ? 'no match' : 'AMBIGUOUS'
  if (hits.length !== 1) ambiguous += 1
  console.log(`${id.padEnd(8)} ${tag.padEnd(10)} ${hits.join(', ') || '-'}`)
}
console.log()
console.log(`tasks resolved uniquely: ${tasks.size - ambiguous}/${tasks.size}`)
console.log()
console.log('Result: repository-based resolution does not work, in either direction.')
console.log()
console.log('Strict version — require the branch to have forked exactly at the base tip: 1/4, and the')
console.log('three misses are silent. That check is wrong on its own terms: the base moves on after')
console.log('the dispatch, so a branch that really did fork there stops equalling the tip later.')
console.log()
console.log('Relaxed version — drop the fork check, keep only "carries write-set work the base does')
console.log('not": 3/4 ambiguous, and the one "unique" hit is WRONG. test_b resolves to')
console.log('feat/orchestration-schedule-ledger, a branch that has nothing to do with this run.')
console.log()
console.log('That last part is the finding. An inference-based fix does not fail loudly where it is')
console.log('unsure; it produces a confident, wrong branch. A wrong branch merges cleanly and')
console.log('quietly, which is strictly worse than the honest state today — the gate reading a field')
console.log('that means the wrong thing, and saying so in its plan output.')
console.log()
console.log('So the ledger has to carry where a task landed. There is no path around it, and the')
console.log('branch-setter has to record it, because the repository cannot recover it afterwards —')
console.log('especially once a branch is reset onto its parent, where nothing distinguishes them.')
