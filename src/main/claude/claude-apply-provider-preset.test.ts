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
  applyClaudeProvider,
  applyProviderToClaudeSettings,
  readActiveClaudeKaixuanPreset,
  readActiveClaudeProvider
} from './claude-apply-provider-preset'
import type { ProviderPresetDefinition } from '../../shared/provider-preset-types'

const GLM_PROVIDER: ProviderPresetDefinition = {
  id: 'glm-5.2',
  label: 'GLM 5.2 (Z.AI)',
  modelProviderName: 'glm-5.2',
  codexProviderName: 'GLM 5.2 (Z.AI)',
  codexBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
  claudeBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
  opencodeBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
  envKeyName: 'OPENAI_API_KEY',
  opencodeModelIds: ['glm-5.2']
}

const REGISTRY: readonly ProviderPresetDefinition[] = [GLM_PROVIDER]

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

  // --- v1–v3 behaviour kept green via the wrapper ---

  it('writes only ANTHROPIC_BASE_URL when no apiKey is supplied (no shell-style ${VAR} literals)', () => {
    const result = applyClaudeKaixuanPreset('kaixuan-local')
    expect(result.error).toBeNull()
    const written = JSON.parse(readFileSync(result.configPath, 'utf-8'))
    expect(written.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8782')
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(JSON.stringify(written.env)).not.toContain('${OPENAI_API_KEY}')
  })

  it('writes the literal apiKey as ANTHROPIC_AUTH_TOKEN when supplied', () => {
    const result = applyClaudeKaixuanPreset('kaixuan-kxpms', { apiKey: 'sk-test-1234' })
    expect(result.error).toBeNull()
    const written = JSON.parse(readFileSync(result.configPath, 'utf-8'))
    expect(written.env.ANTHROPIC_BASE_URL).toBe('https://llm.kxpms.cn')
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test-1234')
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

  // --- v4: custom provider registry ---

  it('applyClaudeProvider writes a custom provider baseUrl without disturbing built-ins', () => {
    const result = applyClaudeProvider(GLM_PROVIDER)
    expect(result.error).toBeNull()
    expect(result.providerId).toBe('glm-5.2')
    const written = JSON.parse(readFileSync(result.configPath, 'utf-8'))
    expect(written.env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/coding/paas/v4')
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it('applyClaudeProvider with apiKey embeds the literal token verbatim', () => {
    const result = applyClaudeProvider(GLM_PROVIDER, { apiKey: 'glm-secret-1234' })
    expect(result.error).toBeNull()
    const written = JSON.parse(readFileSync(result.configPath, 'utf-8'))
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe('glm-secret-1234')
    expect(written.env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/coding/paas/v4')
  })

  it('switching from a built-in to a custom provider rewrites ANTHROPIC_BASE_URL cleanly', () => {
    applyClaudeKaixuanPreset('kaixuan-local')
    applyClaudeProvider(GLM_PROVIDER)
    const written = JSON.parse(readFileSync(join(workingHome, '.claude', 'settings.json'), 'utf-8'))
    expect(written.env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/coding/paas/v4')
  })

  it('clears the env block when provider=null after applying a custom provider', () => {
    applyClaudeProvider(GLM_PROVIDER, { apiKey: 'will-be-cleared' })
    applyClaudeProvider(null)
    const written = JSON.parse(readFileSync(join(workingHome, '.claude', 'settings.json'), 'utf-8'))
    expect(written.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(written.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('readActiveClaudeProvider matches a custom provider in the registry', () => {
    const settings = { env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/coding/paas/v4' } }
    expect(readActiveClaudeProvider(settings, REGISTRY)).toBe('glm-5.2')
  })

  it('readActiveClaudeProvider returns null for an unknown baseUrl', () => {
    const settings = { env: { ANTHROPIC_BASE_URL: 'https://unknown.example.com' } }
    expect(readActiveClaudeProvider(settings, REGISTRY)).toBeNull()
  })

  it('applyProviderToClaudeSettings is pure for custom providers', () => {
    const input = { env: { KEEP: 'me' } }
    const next = applyProviderToClaudeSettings(input, GLM_PROVIDER)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: next.env narrows to Record<string,string>; cast only for narrow test access.
    const env = next.env as Record<string, string>
    expect(env.KEEP).toBe('me')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/coding/paas/v4')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: input.env is read-only.
    const inputEnv = input.env as Record<string, string>
    expect(inputEnv.ANTHROPIC_BASE_URL).toBeUndefined()
  })
})
