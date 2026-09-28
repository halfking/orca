import { describe, expect, it } from 'vitest'

import {
  buildView,
  computeWriteSetMatrix,
  foldLedger,
  normalizeEntry,
  parseLedger,
  renderView,
  suggestMergeOrder
} from './orchestration-schedule-ledger.mjs'

const RUN = 'run_test'

function entry(overrides) {
  return normalizeEntry({ run: RUN, ...overrides })
}

/** Two parallel implementations, their audits, and the merge wave that depends on both audits. */
const LEDGER = [
  entry({
    task: 'impl_a',
    event: 'worker-start',
    role: 'implementer',
    agent: 'codex',
    model: 'gpt-5.5',
    effort: 'high',
    placement: { worktree: 'task-a', base: 'main' },
    state: 'dispatched'
  }),
  entry({
    task: 'impl_b',
    event: 'worker-start',
    role: 'implementer',
    agent: 'codex',
    model: 'gpt-5.5',
    effort: 'high',
    placement: { worktree: 'task-b', base: 'main' },
    state: 'dispatched'
  }),
  entry({
    task: 'impl_a',
    event: 'worker-done',
    state: 'completed',
    outcome: 'succeeded',
    filesModified: ['src/a.ts', 'src/shared.ts']
  }),
  entry({
    task: 'impl_b',
    event: 'worker-done',
    state: 'completed',
    outcome: 'succeeded',
    filesModified: ['src/b.ts', 'src/shared.ts']
  }),
  entry({
    task: 'audit_a',
    event: 'worker-start',
    role: 'auditor',
    agent: 'claude',
    model: 'claude-opus-4-8',
    effort: 'high',
    deps: ['impl_a'],
    placement: { worktree: 'task-a-audit', base: 'feature/task-a' },
    state: 'dispatched'
  }),
  entry({
    task: 'audit_a',
    event: 'worker-done',
    state: 'completed',
    outcome: 'succeeded',
    verdict: 'pass',
    findings: 0,
    filesModified: [],
    reportPath: 'reports/audit-a.md'
  }),
  entry({
    task: 'audit_b',
    event: 'worker-start',
    role: 'auditor',
    agent: 'claude',
    model: 'claude-opus-4-8',
    effort: 'high',
    deps: ['impl_a'],
    placement: { worktree: 'task-b-audit', base: 'feature/task-b' },
    state: 'dispatched'
  }),
  entry({
    task: 'merge',
    event: 'note',
    role: 'merger',
    deps: ['audit_a', 'audit_b'],
    state: 'ready'
  })
]

describe('ledger parsing', () => {
  it('reports the offending line instead of silently dropping a corrupt record', () => {
    const body = ['{"run":"r","event":"note"}', 'not json'].join('\n')
    expect(() => parseLedger(body)).toThrow(/ledger line 2/)
  })

  it('rejects an event outside the contract', () => {
    expect(() => normalizeEntry({ run: RUN, event: 'merge-now' })).toThrow(/Unknown ledger event/)
  })

  it('requires a run id', () => {
    expect(() => normalizeEntry({ event: 'note' })).toThrow(/"run"/)
  })
})

describe('folding the append-only trail', () => {
  const folded = foldLedger(LEDGER)

  it('keeps one row per task with its latest dispatch facts', () => {
    expect(folded.tasks).toHaveLength(5)
    const auditA = folded.tasks.find((task) => task.id === 'audit_a')
    expect(auditA).toMatchObject({
      role: 'auditor',
      agent: 'claude',
      model: 'claude-opus-4-8',
      state: 'completed',
      verdict: 'pass',
      reportPaths: ['reports/audit-a.md']
    })
  })

  it('derives the wave from the dependency DAG rather than trusting a recorded wave', () => {
    const waves = Object.fromEntries(folded.tasks.map((task) => [task.id, task.wave]))
    expect(waves).toEqual({ impl_a: 0, impl_b: 0, audit_a: 1, audit_b: 1, merge: 2 })
  })

  it('unions every file a task touched across its dispatches', () => {
    const implA = folded.tasks.find((task) => task.id === 'impl_a')
    expect([...implA.files].sort()).toEqual(['src/a.ts', 'src/shared.ts'])
  })
})

describe('blocking analysis', () => {
  const view = buildView(LEDGER)
  const byId = Object.fromEntries(view.blocking.map((row) => [row.id, row]))

  it('treats an unfinished dependency as blocking and a settled one as clear', () => {
    expect(byId.merge.unmetDeps).toEqual(['audit_b'])
    expect(byId.audit_a.unmetDeps).toEqual([])
    expect(byId.audit_a.actionable).toBe(false)
  })

  it('fails closed on a dependency the ledger never recorded', () => {
    const orphan = buildView([entry({ task: 'merge', event: 'note', deps: ['never_started'] })])
    expect(orphan.blocking[0].unmetDeps).toEqual(['never_started'])
  })

  it('treats an unresolved gate as blocking', () => {
    const gated = buildView([
      entry({ task: 'merge', event: 'note', role: 'merger' }),
      entry({
        task: 'merge',
        event: 'gate-create',
        gate: { id: 'gate_1', question: 'pass?', resolved: false }
      })
    ])
    expect(gated.blocking[0].pendingGates).toEqual(['gate_1'])
    expect(gated.blocking[0].actionable).toBe(false)
  })

  it('clears a task once its gate is resolved', () => {
    const gated = buildView([
      entry({ task: 'merge', event: 'note', role: 'merger' }),
      entry({
        task: 'merge',
        event: 'gate-create',
        gate: { id: 'gate_1', question: 'pass?', resolved: false }
      }),
      entry({
        task: 'merge',
        event: 'gate-resolve',
        gate: { id: 'gate_1', question: 'pass?', resolved: true }
      })
    ])
    expect(gated.blocking[0].pendingGates).toEqual([])
    expect(gated.blocking[0].actionable).toBe(true)
  })
})

describe('write-set overlap and merge order', () => {
  const folded = foldLedger(LEDGER)
  const matrix = computeWriteSetMatrix(folded)

  it('counts a shared file as a conflict and names it, once per unordered pair', () => {
    const matching = matrix.conflicts.filter(
      (entry) => entry.a === 'impl_a' && entry.b === 'impl_b'
    )
    expect(matching).toHaveLength(1)
    expect(matching[0].shared).toEqual(['src/shared.ts'])
  })

  it('leaves disjoint write sets with a zero cell', () => {
    const rowA = matrix.rows.find((row) => row.id === 'impl_a')
    expect(rowA.cells).toMatchObject({ impl_a: 0, impl_b: 1, audit_a: 0 })
  })

  it('merges the least-conflicting task first', () => {
    const order = suggestMergeOrder(folded, matrix)
    expect(order).toEqual(['impl_a', 'impl_b'])
  })

  it('keeps audit and merge tasks out of the merge queue entirely', () => {
    const order = suggestMergeOrder(folded, matrix)
    expect(order).not.toContain('audit_a')
    expect(order).not.toContain('merge')
  })

  it('sorts a landable task with no recorded write set last: unknown is not small', () => {
    const withUnknown = buildView([
      ...LEDGER,
      entry({
        task: 'impl_c',
        event: 'worker-start',
        role: 'implementer',
        state: 'dispatched',
        filesModified: []
      })
    ])
    const order = withUnknown.order
    expect(order.at(-1)).toBe('impl_c')
  })
})

describe('rendering the scheduling path', () => {
  const view = buildView(LEDGER)
  const rendered = renderView(view.folded, view.blocking, view.matrix, view.order)

  it('shows the wave tree, the blocking reason, the conflicts and the role coverage', () => {
    expect(rendered).toContain('SCHEDULING PATH')
    expect(rendered).toContain('wave 2')
    expect(rendered).toContain('BLOCKING')
    expect(rendered).toContain('impl_a <-> impl_b: src/shared.ts')
    expect(rendered).toContain('auditor')
    expect(rendered).toContain('SUGGESTED MERGE ORDER')
  })

  it('gives a runnable argv for whatever is actionable right now', () => {
    expect(rendered).toContain('orca orchestration worker-start --task audit_b')
  })

  it('never truncates a verdict, because a cut pass_with_findings reads as pass', () => {
    const withFindings = buildView([
      entry({
        task: 'impl_c',
        event: 'worker-done',
        state: 'completed',
        role: 'implementer',
        verdict: 'pass_with_findings',
        filesModified: ['src/c.ts']
      })
    ])
    const text = renderView(
      withFindings.folded,
      withFindings.blocking,
      withFindings.matrix,
      withFindings.order
    )
    expect(text).toContain('pass_with_findings')
    expect(text).not.toContain('pass_with_ ')
  })
})
