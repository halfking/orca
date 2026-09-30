import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildMergePlan, renderMerge } from './orchestration-merge-gate.mjs'
import { computeMergeReadiness } from './orchestration-verdict-contract.mjs'
import { buildView, parseLedger } from './orchestration-schedule-ledger.mjs'

/**
 * Finding 17: buildMergePlan read a task's branch from `placement.base`, which is the branch it
 * forked FROM. The branch it landed ON was not in the ledger at all, so on a real five-wave run
 * the plan named every task's parent — halfking/test_a was never merged and halfking/impl_a-2 was
 * merged in its place, and the gate printed that plan with a clean ORDER beside it.
 *
 * These live in their own file because the sibling test file was already near the repository's
 * 600-line cap, and the two tests that could not be expressed there — a two-link impl→test chain,
 * and a task with no landing branch — are the whole point.
 */
const RUN = 'run_branch_test'

const IMPL = {
  run: RUN,
  task: 'impl_a',
  role: 'implementer',
  agent: 'opencode',
  event: 'worker-done',
  state: 'completed',
  filesModified: ['src/a.ts'],
  branch: 'feature/a',
  placement: { worktree: 'task-a', base: 'main', isolation: 'worktree' }
}

const AUDIT = {
  run: RUN,
  task: 'audit_a',
  role: 'auditor',
  agent: 'cursor',
  event: 'worker-done',
  state: 'completed',
  outcome: 'pass',
  verdict: 'pass',
  deps: ['impl_a'],
  findings: [],
  reportPath: 'reports/audit-a.md',
  regression: { command: 'npx vitest run', result: '37 passed' }
}

function viewOf(entries) {
  return buildView(parseLedger(entries.map((entry) => JSON.stringify(entry)).join('\n')))
}

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'merge-plan-'))
  const repo = join(dir, 'repo')
  mkdirSync(repo, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'gate@test')
  git('config', 'user.name', 'gate')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'a.ts'), 'base\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  return { repo, git }
}

function branchFrom(repo, git, name, files, from = 'main') {
  git('checkout', '-q', '-b', name, from)
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(repo, path), content)
  }
  git('add', '-A')
  git('commit', '-q', '-m', `work on ${name}`)
  git('checkout', '-q', 'main')
}

describe('merge plan branch resolution', () => {
  it('merges the branch each task landed on, not the one it forked from', () => {
    const { repo, git } = tempRepo()
    const testTask = {
      run: RUN,
      task: 'test_a',
      role: 'test-author',
      agent: 'opencode',
      event: 'worker-done',
      state: 'completed',
      filesModified: ['src/a.test.ts'],
      branch: 'feature/a-test',
      // Forked from the implementation, so placement.base is feature/a — the wrong ref to merge.
      placement: { worktree: 'task-at', base: 'feature/a', isolation: 'worktree' }
    }
    const audit = { ...AUDIT, task: 'audit_t', deps: ['test_a'], branch: 'feature/a-test' }

    branchFrom(repo, git, 'feature/a', { 'src/a.ts': 'a\n' })
    branchFrom(repo, git, 'feature/a-test', { 'src/a.test.ts': 'a\n' }, 'feature/a')

    const plan = buildMergePlan(viewOf([IMPL, testTask, AUDIT, audit]), repo, 'main')
    // Before the fix this read ['feature/a', 'main'] and the test branch was never merged.
    expect(plan.steps.map((step) => step.branch)).toEqual(['feature/a', 'feature/a-test'])
  })

  it('refuses to plan a merge for a task that never recorded where it landed', () => {
    const { repo, git } = tempRepo()
    branchFrom(repo, git, 'feature/a', { 'src/a.ts': 'a\n' })
    const { branch: _omitted, ...withoutBranch } = IMPL

    const plan = buildMergePlan(viewOf([withoutBranch, AUDIT]), repo, 'main')
    expect(plan.ready).toBe(false)
    expect(plan.steps).toHaveLength(0)
    expect(plan.unplaced).toContain('impl_a')
  })

  it('names the unplaced task in the rendered plan rather than shortening it silently', () => {
    const { repo, git } = tempRepo()
    branchFrom(repo, git, 'feature/a', { 'src/a.ts': 'a\n' })
    const { branch: _omitted, ...withoutBranch } = IMPL

    const rendered = renderMerge(buildMergePlan(viewOf([withoutBranch, AUDIT]), repo, 'main'), repo)
    expect(rendered).toContain('NOT PLANNED')
    expect(rendered).toContain('impl_a')
  })

  it('still opens the gate for a ledger that records its branches', () => {
    const { repo, git } = tempRepo()
    branchFrom(repo, git, 'feature/a', { 'src/a.ts': 'a\n' })
    const readiness = computeMergeReadiness(viewOf([IMPL, AUDIT]).folded)
    expect(readiness.ready).toBe(true)
    expect(readiness.blockers).toEqual([])
  })
})
