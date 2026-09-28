import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as nodeOs from 'node:os'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof nodeOs>()
  return {
    ...os,
    homedir: () => process.env.CLAUDE_TEST_HOME ?? '/tmp/claude-test'
  }
})

import {
  applyKaixuanToClaudeSettings,
  applyClaudeKaixuanPreset,
  readActiveClaudeKaixuanPreset
} from './claude-apply-provider-preset'

describe('claude-apply-provider-preset', () => {
  let workingHome: string
  beforeEach(() => {
    workingHome = mkdtempSync(join(tmpdir(), 'orca-claude-preset-'))
    process.env.CLAUDE_TEST_HOME = workingHome
    delete process.env.CLAUDE_CONFIG_DIR
  })
  afterEach(() => {
    rmSync(workingHome, { recursive: true, force: true })
    delete process.env.CLAUDE_TEST_HOME
    delete process.env.CLAUDE_CONFIG_DIR
  })

  it('injects ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN on apply', () => {
    const result = applyClaudeKaixuanPreset('kaixuan-local')
    expect(result.error).toBeNull()
    const written = JSON.parse(readFileSync(result.configPath, 'utf-8'))
    expect(written.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8782')
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toContain('OPENAI_API_KEY')
  })

  it('preserves unrelated env keys', () => {
    const configDir = join(workingHome, '.claude')
    mkdirSync(configDir, { recursive: true })
    const configPath = join(configDir, 'settings.json')
    writeFileSync(
      configPath,
      JSON.stringify({ env: { CUSTOM_KEY: 'kept', OTHER: 'value' } }, null, 2)
    )
    applyClaudeKaixuanPreset('kaixuan-kxpms')
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written.env.CUSTOM_KEY).toBe('kept')
    expect(written.env.OTHER).toBe('value')
    expect(written.env.ANTHROPIC_BASE_URL).toBe('https://llm.kxpms.cn')
  })

  it('cleans up kaixuan env keys when presetId is null', () => {
    applyClaudeKaixuanPreset('kaixuan-kxpms')
    applyClaudeKaixuanPreset(null)
    const configPath = join(workingHome, '.claude', 'settings.json')
    expect(existsSync(configPath)).toBe(true)
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written.env).toBeDefined()
    expect(written.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it('switches cleanly without duplicating state', () => {
    applyClaudeKaixuanPreset('kaixuan-local')
    applyClaudeKaixuanPreset('kaixuan-kxpms')
    const configPath = join(workingHome, '.claude', 'settings.json')
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written.env.ANTHROPIC_BASE_URL).toBe('https://llm.kxpms.cn')
  })

  it('applyKaixuanToClaudeSettings is a pure function', () => {
    const input = { env: { KEEP: 'me' }, otherSetting: true }
    const next = applyKaixuanToClaudeSettings(input, 'kaixuan-local')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: applyKaixuanToClaudeSettings narrows next.env to Record<string,string>; the cast is only for the test's narrow access.
    const env = next.env as Record<string, string>
    expect(env.KEEP).toBe('me')
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8782')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: input.env is read-only; the test checks it was not mutated.
    const inputEnv = input.env as Record<string, string>
    expect(inputEnv.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it('readActiveClaudeKaixuanPreset parses settings', () => {
    expect(
      readActiveClaudeKaixuanPreset({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8782' } })
    ).toBe('kaixuan-local')
    expect(
      readActiveClaudeKaixuanPreset({ env: { ANTHROPIC_BASE_URL: 'https://llm.kxpms.cn' } })
    ).toBe('kaixuan-kxpms')
    expect(
      readActiveClaudeKaixuanPreset({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } })
    ).toBeNull()
    expect(readActiveClaudeKaixuanPreset({})).toBeNull()
  })
})
