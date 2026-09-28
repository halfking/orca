import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../shared/opencode-config-directory', () => ({
  resolveOpenCodeConfigDirectory: () => {
    const home = process.env.OPENCODE_TEST_HOME
    if (!home) {
      throw new Error('OPENCODE_TEST_HOME must be set in test')
    }
    return join(home, '.config', 'opencode')
  }
}))

const {
  applyKaixuanToOpenCodeConfig,
  applyOpenCodeKaixuanPreset,
  applyOpenCodeProvider,
  applyProviderToOpenCodeConfig,
  readActiveOpenCodeKaixuanPreset,
  readActiveOpenCodeProvider
} = await import('./opencode-apply-provider-preset')
const { BUILT_IN_PROVIDER_IDS } = await import('../../shared/provider-preset-types')
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

const KNOWN_BUILT_IN_AND_GLM = new Set<string>([...BUILT_IN_PROVIDER_IDS, 'glm-5.2'])

describe('opencode-apply-provider-preset', () => {
  let workingHome: string
  beforeEach(() => {
    workingHome = mkdtempSync(join(tmpdir(), 'orca-opencode-preset-'))
    process.env.OPENCODE_TEST_HOME = workingHome
    delete process.env.XDG_CONFIG_HOME
  })
  afterEach(() => {
    rmSync(workingHome, { recursive: true, force: true })
    delete process.env.OPENCODE_TEST_HOME
    delete process.env.XDG_CONFIG_HOME
  })

  // --- v1–v3 behaviour kept green via the wrapper ---

  it('writes provider.kaixuan-local under options.baseURL/apiKey with placeholder by default', () => {
    const result = applyOpenCodeKaixuanPreset('kaixuan-local')
    expect(result.error).toBeNull()
    const configPath = join(workingHome, '.config', 'opencode', 'opencode.json')
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written.provider['kaixuan-local'].npm).toBe('@ai-sdk/openai-compatible')
    expect(written.provider['kaixuan-local'].options.baseURL).toBe('http://127.0.0.1:8782/v1')
    expect(written.provider['kaixuan-local'].options.apiKey).toBe('{env:OPENAI_API_KEY}')
    expect(written.provider['kaixuan-local'].baseURL).toBeUndefined()
    expect(written.provider['kaixuan-local'].apiKey).toBeUndefined()
  })

  it('writes the literal apiKey when caller supplies one', () => {
    const result = applyOpenCodeKaixuanPreset('kaixuan-kxpms', { apiKey: 'sk-token-xyz' })
    expect(result.error).toBeNull()
    const configPath = join(workingHome, '.config', 'opencode', 'opencode.json')
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written.provider['kaixuan-kxpms'].options.apiKey).toBe('sk-token-xyz')
  })

  it('preserves unrelated provider entries (options shape)', () => {
    const configDir = join(workingHome, '.config', 'opencode')
    mkdirSync(configDir, { recursive: true })
    const configPath = join(configDir, 'opencode.json')
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          provider: {
            upstream: { options: { baseURL: 'https://example.com' } }
          }
        },
        null,
        2
      )
    )
    applyOpenCodeKaixuanPreset('kaixuan-kxpms')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: readFileSync returns string; JSON.parse yields unknown. Casting to a narrow shape is fine for tests that only check the baseURL field.
    const written = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      provider: Record<string, { options?: { baseURL?: string } }>
    }
    expect(written.provider.upstream.options?.baseURL).toBe('https://example.com')
    expect(written.provider['kaixuan-kxpms'].options?.baseURL).toBe('https://llm.kxpms.cn/v1')
  })

  it('cleans up kaixuan providers when presetId is null', () => {
    applyOpenCodeKaixuanPreset('kaixuan-local')
    applyOpenCodeKaixuanPreset(null)
    const configPath = join(workingHome, '.config', 'opencode', 'opencode.json')
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written.provider).toBeDefined()
    expect(written.provider['kaixuan-local']).toBeUndefined()
  })

  it('switches cleanly without duplicating provider entries', () => {
    applyOpenCodeKaixuanPreset('kaixuan-local')
    applyOpenCodeKaixuanPreset('kaixuan-kxpms')
    const configPath = join(workingHome, '.config', 'opencode', 'opencode.json')
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    const keys = Object.keys(written.provider).filter((k) => k.startsWith('kaixuan-'))
    expect(keys).toEqual(['kaixuan-kxpms'])
  })

  it('applyKaixuanToOpenCodeConfig is a pure function', () => {
    const input = {
      provider: { upstream: { options: { baseURL: 'https://example.com' } } }
    }
    const result = applyKaixuanToOpenCodeConfig(input, 'kaixuan-local')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: applyKaixuanToOpenCodeConfig returns Record<string, unknown> for provider; the test narrows to options.baseURL/apiKey only.
    const provider = result.next.provider as Record<
      string,
      { options?: { baseURL?: string; apiKey?: string } }
    >
    expect(provider.upstream.options?.baseURL).toBe('https://example.com')
    expect(provider['kaixuan-local'].options?.baseURL).toBe('http://127.0.0.1:8782/v1')
    expect(provider['kaixuan-local'].options?.apiKey).toBe('{env:OPENAI_API_KEY}')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: input.provider is a literal; the cast only widens for the negative-lookup check.
    const inputProvider = input.provider as Record<string, unknown>
    expect(inputProvider['kaixuan-local']).toBeUndefined()
  })

  it('readActiveOpenCodeKaixuanPreset parses the new options shape', () => {
    expect(
      readActiveOpenCodeKaixuanPreset({
        provider: { 'kaixuan-local': { options: { baseURL: 'http://127.0.0.1:8782/v1' } } }
      })
    ).toBe('kaixuan-local')
    expect(
      readActiveOpenCodeKaixuanPreset({
        provider: { 'kaixuan-kxpms': { options: { baseURL: 'https://llm.kxpms.cn/v1' } } }
      })
    ).toBe('kaixuan-kxpms')
    expect(
      readActiveOpenCodeKaixuanPreset({
        provider: { 'kaixuan-local': { baseURL: 'http://127.0.0.1:8782/v1' } }
      })
    ).toBeNull()
    expect(readActiveOpenCodeKaixuanPreset({ provider: {} })).toBeNull()
    expect(readActiveOpenCodeKaixuanPreset({})).toBeNull()
  })

  // --- v4: custom provider registry ---

  it('applyOpenCodeProvider writes a custom provider entry with its own key + models', () => {
    const result = applyOpenCodeProvider(GLM_PROVIDER, KNOWN_BUILT_IN_AND_GLM)
    expect(result.error).toBeNull()
    expect(result.providerId).toBe('glm-5.2')
    const configPath = join(workingHome, '.config', 'opencode', 'opencode.json')
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written.provider['glm-5.2'].npm).toBe('@ai-sdk/openai-compatible')
    expect(written.provider['glm-5.2'].options.baseURL).toBe('https://api.z.ai/api/coding/paas/v4')
    expect(written.provider['glm-5.2'].options.apiKey).toBe('{env:OPENAI_API_KEY}')
    expect(written.provider['glm-5.2'].models['glm-5.2']).toEqual({ name: 'glm-5.2' })
  })

  it('switching from a built-in to a custom provider clears the built-in entry', () => {
    applyOpenCodeKaixuanPreset('kaixuan-local')
    applyOpenCodeProvider(GLM_PROVIDER, KNOWN_BUILT_IN_AND_GLM)
    const configPath = join(workingHome, '.config', 'opencode', 'opencode.json')
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written.provider['glm-5.2']).toBeDefined()
    expect(written.provider['kaixuan-local']).toBeUndefined()
  })

  it('switching between two custom providers leaves no duplicate entries', () => {
    const kimi: ProviderPresetDefinition = {
      ...GLM_PROVIDER,
      id: 'kimi-k2',
      opencodeModelIds: ['kimi-k2']
    }
    const registry = new Set<string>(['glm-5.2', 'kimi-k2'])
    applyOpenCodeProvider(GLM_PROVIDER, registry)
    applyOpenCodeProvider(kimi, registry)
    const configPath = join(workingHome, '.config', 'opencode', 'opencode.json')
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written.provider['kimi-k2']).toBeDefined()
    expect(written.provider['glm-5.2']).toBeUndefined()
  })

  it('clears both built-in and custom entries when provider=null', () => {
    applyOpenCodeKaixuanPreset('kaixuan-local')
    applyOpenCodeProvider(GLM_PROVIDER, KNOWN_BUILT_IN_AND_GLM)
    const result = applyOpenCodeProvider(null, KNOWN_BUILT_IN_AND_GLM)
    expect(result.providerId).toBeNull()
    const configPath = join(workingHome, '.config', 'opencode', 'opencode.json')
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written.provider['glm-5.2']).toBeUndefined()
    expect(written.provider['kaixuan-local']).toBeUndefined()
    expect(written.provider['kaixuan-kxpms']).toBeUndefined()
  })

  it('preserves user-owned provider entries whose key is not in the registry', () => {
    const configDir = join(workingHome, '.config', 'opencode')
    mkdirSync(configDir, { recursive: true })
    const configPath = join(configDir, 'opencode.json')
    writeFileSync(
      configPath,
      JSON.stringify(
        { provider: { 'user-provider': { options: { baseURL: 'https://user.example.com' } } } },
        null,
        2
      )
    )
    applyOpenCodeProvider(GLM_PROVIDER, KNOWN_BUILT_IN_AND_GLM)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: readFileSync + JSON.parse yields unknown; narrowing for the existence check.
    const written = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      provider: Record<string, { options?: { baseURL?: string } }>
    }
    expect(written.provider['user-provider'].options?.baseURL).toBe('https://user.example.com')
    expect(written.provider['glm-5.2']).toBeDefined()
  })

  it('readActiveOpenCodeProvider resolves a custom provider by baseUrl', () => {
    expect(
      readActiveOpenCodeProvider(
        {
          provider: { 'glm-5.2': { options: { baseURL: 'https://api.z.ai/api/coding/paas/v4' } } }
        },
        [GLM_PROVIDER]
      )
    ).toBe('glm-5.2')
  })

  it('readActiveOpenCodeProvider returns null when no registered provider matches', () => {
    expect(
      readActiveOpenCodeProvider(
        { provider: { 'glm-5.2': { options: { baseURL: 'https://example.com' } } } },
        [GLM_PROVIDER]
      )
    ).toBeNull()
  })

  it('applyProviderToOpenCodeConfig is pure for custom providers', () => {
    const input = { provider: { upstream: { options: { baseURL: 'https://up.example' } } } }
    const result = applyProviderToOpenCodeConfig(input, GLM_PROVIDER, KNOWN_BUILT_IN_AND_GLM)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: result.next.provider narrows for the test's baseURL check.
    const providerMap = result.next.provider as Record<
      string,
      { options?: { baseURL?: string; apiKey?: string } }
    >
    expect(providerMap.upstream.options?.baseURL).toBe('https://up.example')
    expect(providerMap['glm-5.2'].options?.baseURL).toBe('https://api.z.ai/api/coding/paas/v4')
    expect(providerMap['glm-5.2'].options?.apiKey).toBe('{env:OPENAI_API_KEY}')
  })

  // --- regression: applying a preset must never destroy the user's own config ---

  it('preserves unrelated top-level keys when applying a preset over a real config', () => {
    const configPath = join(workingHome, '.config', 'opencode', 'opencode.json')
    mkdirSync(join(workingHome, '.config', 'opencode'), { recursive: true })
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          theme: 'tokyonight',
          model: 'anthropic/claude-sonnet-4',
          mcp: { myserver: { type: 'local', command: ['node', 'server.js'] } },
          permission: { edit: 'ask' }
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
    const result = applyOpenCodeKaixuanPreset('kaixuan-local')
    expect(result.error).toBeNull()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: JSON.parse yields unknown; the cast narrows to Record for these four field lookups.
    const written = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    expect(written.theme).toBe('tokyonight')
    expect(written.model).toBe('anthropic/claude-sonnet-4')
    expect(written.mcp).toEqual({ myserver: { type: 'local', command: ['node', 'server.js'] } })
    expect(written.permission).toEqual({ edit: 'ask' })
  })

  it('refuses to overwrite a malformed opencode.json instead of wiping it', () => {
    const configPath = join(workingHome, '.config', 'opencode', 'opencode.json')
    mkdirSync(join(workingHome, '.config', 'opencode'), { recursive: true })
    // A truncated / hand-edited file. Everything the user owns is in here.
    const broken = '{\n  "theme": "tokyonight",\n  "mcp": { "a": 1\n'
    writeFileSync(configPath, broken, 'utf-8')

    const result = applyOpenCodeKaixuanPreset('kaixuan-local')

    // The apply must fail loudly...
    expect(result.error).toBeTruthy()
    // ...and the file on disk must be byte-identical to what the user had.
    expect(readFileSync(configPath, 'utf-8')).toBe(broken)
  })

  // --- regression: v4 custom-provider + literal apiKey writes the token verbatim ---
  // The provider entry's options.apiKey is opencode's literal-token slot (per
  // opencode.ai/docs/providers and verified live against opencode 1.18.33 on
  // 2026-09-29). The earlier v3 test `writes the literal apiKey when caller
  // supplies one` only covers kaixuan built-ins; the v4 path through
  // `applyOpenCodeProvider` is the one reachable from the registry UI.
  it('writes the literal apiKey verbatim when v4 applyOpenCodeProvider receives one', () => {
    const result = applyOpenCodeProvider(GLM_PROVIDER, KNOWN_BUILT_IN_AND_GLM, {
      apiKey: 'sk-literal-token-v4'
    })
    expect(result.error).toBeNull()
    const configPath = join(workingHome, '.config', 'opencode', 'opencode.json')
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written.provider['glm-5.2'].options.apiKey).toBe('sk-literal-token-v4')
    expect(written.provider['glm-5.2'].npm).toBe('@ai-sdk/openai-compatible')
  })

  // --- regression: when no apiKey is supplied, options.apiKey must stay a placeholder ---
  // The earlier v4 test uses the default `{env:OPENAI_API_KEY}` placeholder but
  // never pins the behaviour against a future refactor that might default the
  // literal path. Lock it.
  it('keeps the {env:OPENAI_API_KEY} placeholder when v4 applyOpenCodeProvider gets no apiKey', () => {
    const result = applyOpenCodeProvider(GLM_PROVIDER, KNOWN_BUILT_IN_AND_GLM)
    expect(result.error).toBeNull()
    const configPath = join(workingHome, '.config', 'opencode', 'opencode.json')
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written.provider['glm-5.2'].options.apiKey).toBe('{env:OPENAI_API_KEY}')
  })
})
