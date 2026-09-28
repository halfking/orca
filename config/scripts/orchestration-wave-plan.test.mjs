import { describe, expect, it } from 'vitest'

import { assignWaves, compilePlan, shellVarFor, validatePlan } from './orchestration-wave-plan.mjs'

function plan(overrides = {}) {
  return {
    objective: 'ship two independent changes behind one gate',
    base: 'main',
    confirmModels: false,
    tasks: [
      {
        id: 'impl_a',
        role: 'implementer',
        spec: 'implement a',
        writeSet: ['src/a.ts'],
        resources: { port: '4101' },
        deps: []
      },
      {
        id: 'impl_b',
        role: 'implementer',
        spec: 'implement b',
        writeSet: ['src/b.ts'],
        resources: { port: '4102' },
        deps: []
      },
      { id: 'audit_a', role: 'auditor', spec: 'audit a', base: 'feature/a', deps: ['impl_a'] },
      { id: 'audit_b', role: 'auditor', spec: 'audit b', base: 'feature/b', deps: ['impl_b'] },
      { id: 'merge', role: 'merger', spec: 'merge', deps: ['audit_a', 'audit_b'] }
    ],
    ...overrides
  }
}

function allMessages(result) {
  return [...result.errors, ...result.warnings]
}

describe('wave assignment', () => {
  it('derives depth from the DAG instead of trusting a hand-written wave', () => {
    expect(Object.fromEntries(assignWaves(plan().tasks))).toEqual({
      impl_a: 0,
      impl_b: 0,
      audit_a: 1,
      audit_b: 1,
      merge: 2
    })
  })

  it('reports a cycle on every participant rather than on some', () => {
    const waves = assignWaves([
      { id: 'a', deps: ['b'] },
      { id: 'b', deps: ['a'] }
    ])
    expect(waves.get('a')).toBe(-1)
    expect(waves.get('b')).toBe(-1)
  })

  it('turns a task id into a shell variable that survives punctuation', () => {
    expect(shellVarFor('impl_a')).toBe('TASK_IMPL_A')
    expect(shellVarFor('impl-a.1')).toBe('TASK_IMPL_A_1')
  })
})

describe('plan validation', () => {
  it('accepts a coherent plan', () => {
    expect(validatePlan(plan()).errors).toEqual([])
  })

  it('refuses a dependency on a task that does not exist', () => {
    const result = validatePlan(
      plan({ tasks: [{ id: 'x', role: 'merger', spec: 's', deps: ['ghost'] }] })
    )
    expect(allMessages(result)).toContain('x: depends on unknown task "ghost"')
  })

  it('refuses a cycle', () => {
    const result = validatePlan(
      plan({
        tasks: [
          { id: 'a', role: 'merger', spec: 's', deps: ['b'] },
          { id: 'b', role: 'merger', spec: 's', deps: ['a'] }
        ]
      })
    )
    expect(allMessages(result)).toContain('a: dependency cycle')
  })

  it('refuses an auditor that carries a write set', () => {
    const result = validatePlan(
      plan({
        tasks: [{ id: 'audit', role: 'auditor', spec: 's', deps: [], writeSet: ['src/a.ts'] }]
      })
    )
    expect(allMessages(result)).toContain('audit: auditor is read-only but declares a write set')
  })

  it('refuses two parallel workers claiming the same external resource', () => {
    const result = validatePlan(
      plan({
        tasks: [
          { id: 'a', role: 'implementer', spec: 's', writeSet: [], resources: { port: '4101' } },
          { id: 'b', role: 'implementer', spec: 's', writeSet: [], resources: { port: '4101' } }
        ]
      })
    )
    expect(allMessages(result).some((message) => message.includes('both claim port:4101'))).toBe(
      true
    )
  })

  it('allows the same resource in different waves, where they cannot overlap', () => {
    const result = validatePlan(
      plan({
        tasks: [
          {
            id: 'a',
            role: 'implementer',
            spec: 's',
            writeSet: [],
            resources: { port: '4101' }
          },
          {
            id: 'b',
            role: 'implementer',
            spec: 's',
            writeSet: [],
            deps: ['a'],
            resources: { port: '4101' }
          }
        ]
      })
    )
    expect(allMessages(result).filter((message) => message.includes('both claim'))).toEqual([])
  })

  it('still reports a resource collision when the DAG could not be ordered', () => {
    const result = validatePlan(
      plan({
        tasks: [
          {
            id: 'a',
            role: 'implementer',
            spec: 's',
            writeSet: [],
            deps: ['ghost'],
            resources: { port: '4101' }
          },
          {
            id: 'b',
            role: 'implementer',
            spec: 's',
            writeSet: [],
            resources: { port: '4101' }
          }
        ]
      })
    )
    expect(allMessages(result).some((message) => message.includes('both claim port:4101'))).toBe(
      true
    )
  })

  it('warns about a predicted merge conflict before any work starts', () => {
    const result = validatePlan(
      plan({
        tasks: [
          { id: 'a', role: 'implementer', spec: 's', writeSet: ['src/shared.ts'] },
          { id: 'b', role: 'implementer', spec: 's', writeSet: ['src/shared.ts'] }
        ]
      })
    )
    expect(
      allMessages(result).some((message) => message.includes('both write src/shared.ts'))
    ).toBe(true)
  })

  it('refuses a merger that does not wait for an audit', () => {
    const result = validatePlan(
      plan({
        tasks: [
          { id: 'impl', role: 'implementer', spec: 's', writeSet: [] },
          { id: 'audit', role: 'auditor', spec: 's', deps: ['impl'] },
          { id: 'merge', role: 'merger', spec: 's', deps: [] }
        ]
      })
    )
    expect(allMessages(result)).toContain(
      'merge does not depend on audit, so an unaudited change can land'
    )
  })

  it('surfaces the model the agent will actually inherit when no model is named', () => {
    expect(
      validatePlan(plan()).warnings.some((message) => message.includes('the agent default applies'))
    ).toBe(true)
  })

  it('stops warning about an unnamed model once the plan confirms one', () => {
    const result = validatePlan(
      plan({
        confirmModels: true,
        models: { 'strongest-code': 'model-a', cheap: 'model-b', 'strongest-reasoning': 'model-c' }
      })
    )
    expect(result.warnings.some((message) => message.includes('the agent default applies'))).toBe(
      false
    )
  })

  it('refuses a plan whose auditor is the same agent on the same model as the implementer', () => {
    const result = validatePlan(
      plan({
        confirmModels: true,
        models: { 'strongest-code': 'shared', cheap: 'cheap', 'strongest-reasoning': 'shared' },
        tasks: [
          { id: 'impl', role: 'implementer', spec: 's', writeSet: [], agent: 'claude' },
          { id: 'audit', role: 'auditor', spec: 's', deps: ['impl'], agent: 'claude' }
        ]
      })
    )
    expect(allMessages(result).join('\n')).toContain('rubber stamp, not a review')
  })

  it('accepts the same agent when the audit runs a different model', () => {
    const result = validatePlan(
      plan({
        confirmModels: true,
        models: { 'strongest-code': 'writer', cheap: 'cheap', 'strongest-reasoning': 'judge' },
        tasks: [
          { id: 'impl', role: 'implementer', spec: 's', writeSet: [], agent: 'claude' },
          { id: 'audit', role: 'auditor', spec: 's', deps: ['impl'], agent: 'claude' }
        ]
      })
    )
    expect(allMessages(result).join('\n')).not.toContain('rubber stamp')
  })

  it('accepts the same model on a different agent', () => {
    const result = validatePlan(
      plan({
        confirmModels: true,
        models: { 'strongest-code': 'shared', cheap: 'cheap', 'strongest-reasoning': 'shared' },
        tasks: [
          { id: 'impl', role: 'implementer', spec: 's', writeSet: [] },
          { id: 'audit', role: 'auditor', spec: 's', deps: ['impl'] }
        ]
      })
    )
    expect(allMessages(result).join('\n')).not.toContain('rubber stamp')
  })

  it('flags an audit on the same agent with no model named, since both fall to the default', () => {
    const result = validatePlan(
      plan({
        tasks: [
          { id: 'impl', role: 'implementer', spec: 's', writeSet: [], agent: 'claude' },
          { id: 'audit', role: 'auditor', spec: 's', deps: ['impl'], agent: 'claude' }
        ]
      })
    )
    expect(allMessages(result).join('\n')).toContain('the agent default')
  })

  it('survives a plan compiled before this rule existed: the default matrix is independent', () => {
    expect(allMessages(validatePlan(plan())).join('\n')).not.toContain('rubber stamp')
  })
})

describe('compiling a plan into commands', () => {
  it('emits nothing at all when the plan has a blocking problem', () => {
    const result = compilePlan(
      plan({ tasks: [{ id: 'x', role: 'merger', spec: 's', deps: ['ghost'] }] })
    )
    expect(result.steps).toEqual([])
  })

  it('opens the Run first, then dispatches every wave including wave 0 work', () => {
    const result = compilePlan(plan())
    expect(result.steps[0]).toMatchObject({ kind: 'run-create' })
    const starts = result.steps
      .filter((step) => step.kind === 'worker-start')
      .map((step) => step.task)
    expect(starts).toEqual(['impl_a', 'impl_b', 'audit_a', 'audit_b'])
    expect(result.steps.find((step) => step.kind === 'gate-create').wave).toBe(2)
  })

  it('passes dependencies as the shell variables holding real Task ids', () => {
    const result = compilePlan(plan())
    const auditA = result.steps.find(
      (step) => step.kind === 'task-create' && step.task === 'audit_a'
    )
    expect(auditA.depVars).toEqual(['TASK_IMPL_A'])
    expect(auditA.taskVar).toBe('TASK_AUDIT_A')
  })

  it('gives an auditor its own worktree on the implementation branch, not the base', () => {
    const result = compilePlan(plan())
    const start = result.steps.find(
      (step) => step.kind === 'worker-start' && step.task === 'audit_a'
    )
    expect(start.argv).toContain('new-child')
    expect(start.argv[0]).toBe('orca')
    const base = start.argv[start.argv.indexOf('--base-branch') + 1]
    expect(base).toBe('feature/a')
  })

  it('carries a ledger entry with every dispatch so the path view starts populated', () => {
    const result = compilePlan(plan())
    const start = result.steps.find(
      (step) => step.kind === 'worker-start' && step.task === 'impl_a'
    )
    expect(start.ledger).toMatchObject({
      role: 'implementer',
      agent: 'codex',
      event: 'worker-start',
      placement: { worktree: 'new-child', base: 'main', isolation: 'worktree' }
    })
    // A ledger entry whose nextAction already ends in --json must not carry a second one.
    expect(start.ledger.nextAction.filter((part) => part === '--json')).toHaveLength(1)
  })

  it('never dispatches the merger as an agent — the merge runs behind a gate instead', () => {
    const result = compilePlan(plan())
    expect(result.steps.some((step) => step.kind === 'worker-start' && step.task === 'merge')).toBe(
      false
    )
    expect(result.steps.some((step) => step.kind === 'gate-create' && step.task === 'merge')).toBe(
      true
    )
  })

  it('records the gate in the ledger too, so a blocked merge is visible before it runs', () => {
    const result = compilePlan(plan())
    expect(result.steps.find((step) => step.kind === 'gate-create').ledger.event).toBe(
      'gate-create'
    )
  })

  it('records dependencies in the ledger by plan name, so the view can resolve blocking', () => {
    const result = compilePlan(plan())
    const auditA = result.steps.find(
      (step) => step.kind === 'worker-start' && step.task === 'audit_a'
    )
    const merge = result.steps.find((step) => step.kind === 'gate-create' && step.task === 'merge')
    expect(auditA.ledger.deps).toEqual(['impl_a'])
    expect(merge.ledger.deps).toEqual(['audit_a', 'audit_b'])
  })

  it('leaves the task id to the runtime and keeps only what is known at compile time', () => {
    const result = compilePlan(plan())
    const start = result.steps.find(
      (step) => step.kind === 'worker-start' && step.task === 'impl_a'
    )
    // The runtime task id only exists once task-create answers. The plan id is what every report is
    // keyed on, and it is written at dispatch time rather than compiled into the entry.
    expect(start.ledger.task).toBeUndefined()
    expect(start.ledger.deps).toEqual([])
  })
})
