import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildDoneEntry,
  buildMergePlan,
  computeMergeReadiness,
  executeMerge,
  inspectRepository,
  renderMerge,
  renderVerify,
  runGit
} from './orchestration-merge-gate.mjs'
import { buildView, normalizeEntry } from './orchestration-schedule-ledger.mjs'

/** The ledger's folding contract takes normalized entries, which is what a real ledger holds. */
function entryWithTs(overrides) {
  return normalizeEntry({
    ts: '2026-09-28T00:00:00Z',
    run: 'run_test',
    event: 'note',
    ...overrides
  })
}

function viewOf(entries) {
  return buildView(entries.map(entryWithTs))
}

const PASSING_AUDIT = {
  task: 'audit_a',
  role: 'auditor',
  event: 'worker-done',
  state: 'completed',
  verdict: 'pass',
  findings: [],
  deps: ['impl_a'],
  reportPath: 'reports/audit-a.md'
}

const PASSING_AUDIT_B = {
  ...PASSING_AUDIT,
  task: 'audit_b',
  deps: ['impl_b'],
  reportPath: 'reports/audit-b.md'
}

const IMPL_A = {
  task: 'impl_a',
  role: 'implementer',
  event: 'worker-done',
  state: 'completed',
  filesModified: ['src/a.ts'],
  placement: { worktree: 'task-a', base: 'feature/a', isolation: 'worktree' }
}

const IMPL_B = {
  ...IMPL_A,
  task: 'impl_b',
  filesModified: ['src/b.ts'],
  placement: { worktree: 'task-b', base: 'feature/b', isolation: 'worktree' }
}

describe('audit verdict contract', () => {
  it('opens the gate when every audit passed and produced a report', () => {
    const result = computeMergeReadiness(
      viewOf([IMPL_A, IMPL_B, PASSING_AUDIT, PASSING_AUDIT_B]).folded
    )
    expect(result.ready).toBe(true)
    expect(result.blockers).toEqual([])
  })

  it('refuses a pass that carries findings, because the two statements disagree', () => {
    const result = computeMergeReadiness(
      viewOf([
        IMPL_A,
        {
          ...PASSING_AUDIT,
          findings: [{ file: 'src/a.ts', line: 3, severity: 'major', evidence: 'x' }]
        }
      ]).folded
    )
    expect(result.blockers).toContain('audit_a: verdict is pass but findings are present')
    expect(result.ready).toBe(false)
  })

  it('refuses pass_with_findings with nothing recorded', () => {
    const result = computeMergeReadiness(
      viewOf([IMPL_A, { ...PASSING_AUDIT, verdict: 'pass_with_findings', findings: [] }]).folded
    )
    expect(result.blockers).toContain(
      'audit_a: verdict is pass_with_findings but no finding is recorded'
    )
  })

  it('refuses a fail whose findings are not marked as blockers', () => {
    const result = computeMergeReadiness(
      viewOf([
        IMPL_A,
        {
          ...PASSING_AUDIT,
          verdict: 'fail',
          findings: [{ file: 'src/a.ts', line: 3, severity: 'minor', evidence: 'x' }]
        }
      ]).folded
    )
    expect(result.blockers).toContain(
      'audit_a: verdict is fail but no finding is marked as a blocker'
    )
  })

  it('refuses a verdict with no report, because an audit nobody can re-read is a claim', () => {
    const result = computeMergeReadiness(
      viewOf([
        IMPL_A,
        {
          task: 'audit_a',
          role: 'auditor',
          event: 'worker-done',
          state: 'completed',
          verdict: 'pass',
          findings: []
        }
      ]).folded
    )
    expect(result.blockers).toContain(
      'audit_a: no report path recorded, so the audit cannot be re-read'
    )
  })

  it('refuses a finding that cannot be reproduced', () => {
    const result = computeMergeReadiness(
      viewOf([
        IMPL_A,
        {
          ...PASSING_AUDIT,
          verdict: 'pass_with_findings',
          findings: [{ file: 'src/a.ts', line: 3, severity: 'major', evidence: '' }]
        }
      ]).folded
    )
    expect(result.blockers.join(' ')).toContain('has no reproducible evidence')
  })

  it('blocks a change that landed without any audit', () => {
    const result = computeMergeReadiness(viewOf([IMPL_A, IMPL_B, PASSING_AUDIT]).folded)
    expect(result.blockers).toContain('impl_b: landed without an audit verdict')
    expect(result.blockers).not.toContain('impl_a: landed without an audit verdict')
  })

  it('blocks a change whose covering audit failed, naming the audit', () => {
    const result = computeMergeReadiness(
      viewOf([
        IMPL_A,
        {
          ...PASSING_AUDIT,
          verdict: 'fail',
          findings: [{ file: 'src/a.ts', line: 1, severity: 'blocker', evidence: 'reproduced' }]
        }
      ]).folded
    )
    expect(result.blockers).toContain('impl_a: no covering audit passed (audit_a)')
  })

  it('blocks a task that is not completed, even with a passing audit', () => {
    const result = computeMergeReadiness(
      viewOf([{ ...IMPL_A, state: 'dispatched' }, PASSING_AUDIT]).folded
    )
    expect(result.blockers).toContain('impl_a: state is dispatched, not completed')
  })

  it('blocks on an unresolved gate and on a gate resolved to fail', () => {
    const unresolved = computeMergeReadiness(
      viewOf([
        IMPL_A,
        PASSING_AUDIT,
        entryWithTs({
          task: 'impl_a',
          event: 'gate-create',
          gate: { id: 'gate_1', resolved: false }
        })
      ]).folded
    )
    expect(unresolved.blockers).toContain('impl_a: gate gate_1 is unresolved')

    const failed = computeMergeReadiness(
      viewOf([
        IMPL_A,
        PASSING_AUDIT,
        entryWithTs({
          task: 'impl_a',
          event: 'gate-resolve',
          gate: { id: 'gate_1', resolved: true, choice: 'fail' }
        })
      ]).folded
    )
    expect(failed.blockers).toContain('impl_a: gate gate_1 was resolved "fail"')
  })
})

describe('recording a worker completion', () => {
  it('accepts a well-formed pass and records the evidence the gate reads', () => {
    const entry = buildDoneEntry({
      run: 'run_x',
      task: 'audit_a',
      role: 'auditor',
      verdict: 'pass',
      report: 'reports/audit-a.md',
      finding: [],
      file: [],
      dep: ['impl_a']
    })
    expect(entry).toMatchObject({
      event: 'worker-done',
      task: 'audit_a',
      verdict: 'pass',
      reportPath: 'reports/audit-a.md',
      deps: ['impl_a']
    })
    expect(normalizeEntry(entry).verdict).toBe('pass')
  })

  it('refuses to record a pass that carries findings', () => {
    expect(() =>
      buildDoneEntry({
        run: 'r',
        task: 'audit_a',
        role: 'auditor',
        verdict: 'pass',
        report: 'reports/a.md',
        finding: ['{"file":"src/a.ts","line":3,"severity":"major","evidence":"npm test fails"}'],
        file: [],
        dep: []
      })
    ).toThrow(/verdict is pass but findings are present/)
  })

  it('refuses to record a verdict with no report, before it can reach the gate', () => {
    expect(() =>
      buildDoneEntry({
        run: 'r',
        task: 'audit_a',
        role: 'auditor',
        verdict: 'pass',
        report: null,
        finding: [],
        file: [],
        dep: []
      })
    ).toThrow(/no report path recorded/)
  })

  it('refuses an unknown verdict instead of storing it as fact', () => {
    expect(() =>
      buildDoneEntry({
        run: 'r',
        task: 'audit_a',
        role: 'auditor',
        verdict: 'looks-good',
        report: 'r.md',
        finding: [],
        file: [],
        dep: []
      })
    ).toThrow(/unknown verdict/)
  })

  it('lets a non-audit task finish without a verdict', () => {
    const entry = buildDoneEntry({
      run: 'r',
      task: 'impl_a',
      role: 'implementer',
      outcome: 'succeeded',
      report: null,
      finding: [],
      file: ['src/a.ts', 'src/b.ts'],
      dep: []
    })
    expect(entry.verdict).toBeNull()
    expect(entry.filesModified).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('refuses an auditor that finished without saying what it found', () => {
    expect(() =>
      buildDoneEntry({
        run: 'r',
        task: 'audit_a',
        role: 'auditor',
        verdict: null,
        report: 'r.md',
        finding: [],
        file: [],
        dep: []
      })
    ).toThrow(/no verdict recorded/)
  })
})

describe('merge execution against a real repository', () => {
  let repo
  let previousUser

  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  const write = (path, content) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
  }

  const commit = (message) => {
    git(['add', '-A'])
    git(['commit', '-m', message])
  }

  beforeEach(() => {
    previousUser = process.env.GIT_AUTHOR_NAME
    repo = mkdtempSync(join(tmpdir(), 'orca-merge-'))
    git(['init', '-b', 'main'])
    git(['config', 'user.email', 'merge-gate@example.test'])
    git(['config', 'user.name', 'merge gate'])
    write('README.md', 'base\n')
    commit('base')
  })

  afterEach(() => {
    if (previousUser === undefined) {
      delete process.env.GIT_AUTHOR_NAME
    } else {
      process.env.GIT_AUTHOR_NAME = previousUser
    }
  })

  function featureBranch(name, files) {
    git(['checkout', '-b', name])
    for (const [path, content] of Object.entries(files)) {
      write(path, content)
    }
    commit(`work on ${name}`)
    git(['checkout', 'main'])
  }

  it('reports a clean worktree, missing base, and a branch behind the base', () => {
    featureBranch('feature/a', { 'src/a.ts': 'a\n' })
    write('README.md', 'base plus a follow-up\n')
    commit('base moves on')

    const info = inspectRepository(repo, 'main', ['feature/a', 'feature/ghost'])
    expect(info.worktreeClean).toBe(true)
    expect(info.baseExists).toBe(true)
    expect(info.branches[0]).toMatchObject({ name: 'feature/a', exists: true, behind: 1 })
    expect(info.branches[1]).toMatchObject({ name: 'feature/ghost', exists: false })
  })

  it('reports a dirty worktree instead of merging into it', () => {
    write('README.md', 'uncommitted\n')
    const info = inspectRepository(repo, 'main', [])
    expect(info.worktreeClean).toBe(false)
  })

  it('merges independent branches and lands both changes on the base', () => {
    featureBranch('feature/a', { 'src/a.ts': 'a\n' })
    featureBranch('feature/b', { 'src/b.ts': 'b\n' })

    const plan = buildMergePlan(
      viewOf([IMPL_A, IMPL_B, PASSING_AUDIT, PASSING_AUDIT_B]),
      repo,
      'main'
    )
    expect(plan.ready).toBe(true)
    expect(plan.steps.map((step) => step.branch)).toEqual(['feature/a', 'feature/b'])

    const outcome = executeMerge(plan, repo)
    expect(outcome.conflict).toBeNull()
    expect(outcome.merged).toEqual(['feature/a', 'feature/b'])
    const landed = runGit(['ls-tree', '-r', '--name-only', 'HEAD'], repo)
    expect(landed).toContain('src/a.ts')
    expect(landed).toContain('src/b.ts')
  })

  it('leaves the feature branch history alone by default', () => {
    featureBranch('feature/a', { 'src/a.ts': 'a\n' })
    write('README.md', 'base moved\n')
    commit('base moves on')
    const before = runGit(['rev-parse', 'feature/a'], repo)

    const plan = buildMergePlan(viewOf([IMPL_A, PASSING_AUDIT]), repo, 'main')
    expect(executeMerge(plan, repo).conflict).toBeNull()
    expect(runGit(['rev-parse', 'feature/a'], repo)).toBe(before)
  })

  it('rebases a stale branch only when the operator asks for it', () => {
    featureBranch('feature/a', { 'src/a.ts': 'a\n' })
    write('README.md', 'base moved\n')
    commit('base moves on')
    const before = runGit(['rev-parse', 'feature/a'], repo)

    const plan = buildMergePlan(viewOf([IMPL_A, PASSING_AUDIT]), repo, 'main')
    expect(executeMerge(plan, repo, { rebase: true }).conflict).toBeNull()
    expect(runGit(['rev-parse', 'feature/a'], repo)).not.toBe(before)
    expect(git(['log', '--oneline', '-1'])).toContain('merge feature/a')
  })

  it('stops at a conflict, restores the repository, and never picks a side', () => {
    featureBranch('feature/a', { 'src/shared.ts': 'from a\n' })
    featureBranch('feature/b', { 'src/shared.ts': 'from b\n' })

    const plan = buildMergePlan(
      viewOf([
        {
          ...IMPL_A,
          filesModified: ['src/shared.ts'],
          placement: { worktree: 'a', base: 'feature/a' }
        },
        {
          ...IMPL_B,
          filesModified: ['src/shared.ts'],
          placement: { worktree: 'b', base: 'feature/b' }
        },
        PASSING_AUDIT,
        PASSING_AUDIT_B
      ]),
      repo,
      'main'
    )

    const outcome = executeMerge(plan, repo)
    expect(outcome.conflict).toMatchObject({ branch: 'feature/b', reason: 'conflict' })
    // The first branch still landed; the repository is left mid-flight-free, not with a half merge.
    expect(runGit(['status', '--porcelain'], repo)).toBe('')
    expect(git(['branch', '--show-current'])).toBe('main')
  })

  it('rebases a stale branch onto the base before merging it', () => {
    featureBranch('feature/a', { 'src/a.ts': 'a\n' })
    write('README.md', 'base moved\n')
    commit('base moves on')

    const plan = buildMergePlan(viewOf([IMPL_A, PASSING_AUDIT]), repo, 'main')
    expect(plan.steps[0].behind).toBe(1)
    expect(plan.steps[0].commands.join('\n')).toContain('rebase main')
  })

  it('refuses to start when the audit gate is closed, whatever the repository looks like', () => {
    featureBranch('feature/a', { 'src/a.ts': 'a\n' })
    const plan = buildMergePlan(viewOf([IMPL_A]), repo, 'main')
    expect(plan.ready).toBe(false)
    expect(plan.readiness.blockers).toContain('impl_a: landed without an audit verdict')
  })

  it('never reports success for a plan that names no landable branch', () => {
    const outcome = executeMerge(buildMergePlan(viewOf([]), repo, 'main'), repo)
    expect(outcome).toMatchObject({ merged: [], conflict: null, outcome: 'nothing to merge' })
  })

  it('reports an already-merged branch as done rather than merging it twice', () => {
    featureBranch('feature/a', { 'src/a.ts': 'a\n' })
    runGit(['merge', '--no-ff', '-m', 'first merge', 'feature/a'], repo)
    const plan = buildMergePlan(viewOf([IMPL_A, PASSING_AUDIT]), repo, 'main')
    expect(plan.steps[0].alreadyMerged).toBe(true)
    expect(executeMerge(plan, repo).outcome).toBe('already merged')
  })

  it('renders the verify report and the merge plan without touching a field that is not there', () => {
    featureBranch('feature/a', { 'src/a.ts': 'a\n' })
    featureBranch('feature/b', { 'src/b.ts': 'b\n' })
    const view = viewOf([IMPL_A, IMPL_B, PASSING_AUDIT, PASSING_AUDIT_B])

    expect(renderVerify(computeMergeReadiness(view.folded))).toContain('MERGE GATE: OPEN')
    expect(renderVerify(computeMergeReadiness(viewOf([IMPL_A]).folded))).toContain(
      'MERGE GATE: CLOSED'
    )

    const rendered = renderMerge(buildMergePlan(view, repo, 'main'), repo)
    expect(rendered).toContain('feature/a')
    expect(rendered).toContain('feature/b')
    expect(rendered).toContain('worktree clean')
  })

  it('says so plainly when the run left nothing to merge', () => {
    expect(renderMerge(buildMergePlan(viewOf([]), repo, 'main'), repo)).toContain('MERGE PLAN')
    expect(renderVerify(computeMergeReadiness(viewOf([]).folded))).toContain('(no audit recorded)')
  })
})
