import { describe, expect, it } from 'vitest'

import {
  MODEL_ROUTABLE_AGENTS,
  ROLE_MATRIX,
  knownRoles,
  launchArgv,
  resolveLaunch,
  roleSpec
} from './orchestration-role-matrix.mjs'

describe('role matrix', () => {
  it('separates the roles that land changes from the ones that only route or verify', () => {
    expect(roleSpec('implementer').lands).toBe(true)
    expect(roleSpec('test-author').lands).toBe(true)
    expect(roleSpec('auditor').lands).toBe(false)
    expect(roleSpec('auditor').writeAccess).toBe('read-only')
    expect(roleSpec('coordinator').lands).toBe(false)
  })

  it('gives the audit role a stronger model tier than the test role', () => {
    expect(roleSpec('auditor').tier).toBe('strongest-reasoning')
    expect(roleSpec('test-author').tier).toBe('cheap')
    expect(roleSpec('auditor').tier).not.toBe(roleSpec('test-author').tier)
  })

  it('names no model id anywhere, because upstream forbids guessing one', () => {
    expect(JSON.stringify(ROLE_MATRIX)).not.toMatch(/gpt-|claude-|opus|sonnet|glm-|gemini|deepseek/)
  })

  it('only routes models to agents whose worker-start accepts --model', () => {
    for (const role of knownRoles()) {
      const agent = roleSpec(role).agent
      if (agent !== null) {
        expect(MODEL_ROUTABLE_AGENTS.has(agent)).toBe(true)
      }
    }
  })
})

describe('launch resolution', () => {
  it('applies the role default when the plan names nothing, dropping effort with no model', () => {
    expect(resolveLaunch({ role: 'implementer' })).toMatchObject({
      agent: 'codex',
      tier: 'strongest-code',
      model: null,
      effort: null
    })
  })

  it('restores the role effort once a plan names a model', () => {
    expect(resolveLaunch({ role: 'implementer', model: 'gpt-5.5' })).toMatchObject({
      model: 'gpt-5.5',
      effort: 'high'
    })
  })

  it('refuses a model for an agent that runs its own config', () => {
    expect(() =>
      resolveLaunch({ role: 'implementer', agent: 'opencode', model: 'gpt-5.5' })
    ).toThrow(/rejects --model/)
    expect(() => resolveLaunch({ role: 'implementer', agent: 'zcode', model: 'glm-5.2' })).toThrow(
      /rejects --model/
    )
  })

  it('refuses an effort the plan wrote down with no model, matching the flag contract', () => {
    expect(() => resolveLaunch({ role: 'auditor', effort: 'high' })).toThrow(
      /--effort requires --model/
    )
  })

  it('lets a plan override the agent while keeping the role contract', () => {
    const launch = resolveLaunch({ role: 'implementer' }, { agent: 'claude' })
    expect(launch.agent).toBe('claude')
    expect(launch.writeAccess).toBe('own-worktree')
  })

  it('rejects an unknown agent rather than emitting an unusable command', () => {
    expect(() => resolveLaunch({ role: 'implementer', agent: 'gpt-cli' })).toThrow(/unknown agent/)
  })
})

describe('launch argv', () => {
  it('emits flags in a stable order and always ends with --json', () => {
    const argv = launchArgv('impl_a', resolveLaunch({ role: 'implementer', model: 'gpt-5.5' }), {
      worktree: 'new-child',
      name: 'impl_a',
      base: 'main',
      setup: 'run'
    })
    expect(argv).toEqual([
      'orca',
      'orchestration',
      'worker-start',
      '--task',
      'impl_a',
      '--worktree',
      'new-child',
      '--name',
      'impl_a',
      '--base-branch',
      'main',
      '--setup',
      'run',
      '--agent',
      'codex',
      '--model',
      'gpt-5.5',
      '--effort',
      'high',
      '--json'
    ])
  })

  it('omits --model and --effort rather than emitting flags the binary would reject', () => {
    const argv = launchArgv('t', resolveLaunch({ role: 'auditor' }), { worktree: 'current' })
    expect(argv).not.toContain('--model')
    expect(argv).not.toContain('--effort')
  })
})
