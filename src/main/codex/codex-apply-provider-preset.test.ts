import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('./codex-home-paths', () => ({
  getSystemCodexHomePath: () => process.env.CODEX_TEST_HOME ?? '/tmp/codex-test'
}))

const {
  applyCodexKaixuanPreset,
  applyCodexProvider,
  renderCodexConfigForProvider,
  readActiveCodexKaixuanPreset,
  readActiveCodexProvider
} = await import('./codex-apply-provider-preset')
const { KAIXUAN_PRESETS, BUILT_IN_PROVIDER_IDS } =
  await import('../../shared/provider-preset-types')
import type { ProviderPresetDefinition } from '../../shared/provider-preset-types'
import { parseTomlTableHeaderPath } from './config-toml-key-path'

// A custom provider used in the v4 tests. Mirrors the GLM-5.2 setup in
// docs/site/content/docs/agents/glm-agent.mdx so the test exercises the same
// shape real users will save through the AccountsPane form.
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

describe('codex-apply-provider-preset', () => {
  let workingHome: string
  beforeEach(() => {
    workingHome = mkdtempSync(join(tmpdir(), 'orca-codex-preset-'))
    process.env.CODEX_TEST_HOME = workingHome
  })
  afterEach(() => {
    rmSync(workingHome, { recursive: true, force: true })
    delete process.env.CODEX_TEST_HOME
  })

  // --- v1–v3 behaviour kept green for the existing wrapper ---

  it('writes a model_provider + [model_providers.kaixuan-local] table on apply', () => {
    const configPath = join(workingHome, 'config.toml')
    const result = applyCodexKaixuanPreset('kaixuan-local')
    expect(result.error).toBeNull()
    expect(result.providerId).toBe('kaixuan-local')
    expect(result.configPath).toBe(configPath)
    const written = readFileSync(configPath, 'utf-8')
    expect(written).toContain('model_provider = "kaixuan-local"')
    expect(written).toContain('[model_providers."kaixuan-local"]')
    expect(written).toContain('base_url = "http://127.0.0.1:8782/v1"')
    expect(written).toContain('wire_api = "responses"')
  })

  it('preserves unrelated top-level keys and tables in the source config', () => {
    const configPath = join(workingHome, 'config.toml')
    writeFileSync(
      configPath,
      [
        'theme = "dark"',
        '',
        '[model_providers.openai]',
        'name = "OpenAI"',
        'base_url = "https://api.openai.com/v1"',
        '',
        '[agents.reviewer]',
        'config_file = "reviewer.toml"'
      ].join('\n')
    )
    applyCodexKaixuanPreset('kaixuan-kxpms')
    const written = readFileSync(configPath, 'utf-8')
    expect(written).toContain('theme = "dark"')
    expect(written).toContain('[model_providers.openai]')
    expect(written).toContain('base_url = "https://api.openai.com/v1"')
    expect(written).toContain('[agents.reviewer]')
    expect(written).toContain('config_file = "reviewer.toml"')
    expect(written).toContain('model_provider = "kaixuan-kxpms"')
    expect(written).toContain('[model_providers."kaixuan-kxpms"]')
    expect(written).toContain('base_url = "https://llm.kxpms.cn/v1"')
  })

  it('switches cleanly between presets (no duplicate blocks)', () => {
    const configPath = join(workingHome, 'config.toml')
    applyCodexKaixuanPreset('kaixuan-local')
    applyCodexKaixuanPreset('kaixuan-kxpms')
    const written = readFileSync(configPath, 'utf-8')
    expect((written.match(/\[model_providers\."kaixuan-/g) ?? []).length).toBe(1)
    expect(written).toContain('[model_providers."kaixuan-kxpms"]')
    expect(written).not.toContain('[model_providers."kaixuan-local"]')
  })

  it('removes all kaixuan artifacts when presetId is null', () => {
    const configPath = join(workingHome, 'config.toml')
    applyCodexKaixuanPreset('kaixuan-local')
    const result = applyCodexKaixuanPreset(null)
    expect(result.error).toBeNull()
    const written = readFileSync(configPath, 'utf-8')
    expect(written).not.toContain('kaixuan-local')
    expect(written).not.toContain('kaixuan-kxpms')
    expect(written).not.toMatch(/^model_provider\s*=\s*"kaixuan-/m)
  })

  it('readActiveCodexKaixuanPreset parses the active id', () => {
    expect(readActiveCodexKaixuanPreset('model_provider = "kaixuan-local"\n')).toBe('kaixuan-local')
    expect(readActiveCodexKaixuanPreset('model_provider = "kaixuan-kxpms"\n')).toBe('kaixuan-kxpms')
    expect(readActiveCodexKaixuanPreset('model_provider = "openai"\n')).toBeNull()
    expect(readActiveCodexKaixuanPreset('[model_providers.openai]\n')).toBeNull()
  })

  it('renderCodexConfigForProvider is idempotent across repeated applies', () => {
    const once = renderCodexConfigForProvider(
      '',
      KAIXUAN_PRESETS['kaixuan-local'],
      BUILT_IN_PROVIDER_IDS
    )
    const twice = renderCodexConfigForProvider(
      once,
      KAIXUAN_PRESETS['kaixuan-local'],
      BUILT_IN_PROVIDER_IDS
    )
    expect(twice).toBe(once)
  })

  // --- Codex schema conformance (defects found 2026-09-28) ---
  //
  // These lock the exact shapes that were wrong before, so a future edit cannot
  // silently reintroduce a config Codex accepts-but-cannot-authenticate.

  it('sets requires_openai_auth = false so Codex does not hijack ChatGPT OAuth', () => {
    applyCodexKaixuanPreset('kaixuan-kxpms')
    const written = readFileSync(join(workingHome, 'config.toml'), 'utf-8')
    expect(written).toContain('requires_openai_auth = false')
    expect(written).not.toContain('requires_openai_auth = true')
  })

  it('embeds the caller-supplied key as experimental_bearer_token, never as api_key', () => {
    applyCodexKaixuanPreset('kaixuan-kxpms', { apiKey: 'sk-test-token' })
    const written = readFileSync(join(workingHome, 'config.toml'), 'utf-8')
    expect(written).toContain('experimental_bearer_token = "sk-test-token"')
    expect(written).not.toMatch(/^api_key\s*=/m)
  })

  it('drops a previously embedded token when switching presets or clearing', () => {
    const configPath = join(workingHome, 'config.toml')
    applyCodexKaixuanPreset('kaixuan-local', { apiKey: 'sk-local-secret' })
    applyCodexKaixuanPreset('kaixuan-kxpms', { apiKey: 'sk-kxpms-secret' })
    let written = readFileSync(configPath, 'utf-8')
    expect(written).toContain('experimental_bearer_token = "sk-kxpms-secret"')
    expect(written).not.toContain('sk-local-secret')
    applyCodexKaixuanPreset(null)
    written = readFileSync(configPath, 'utf-8')
    expect(written).not.toContain('experimental_bearer_token')
    expect(written).not.toContain('sk-kxpms-secret')
  })

  it('escapes TOML-special characters in an embedded bearer token', () => {
    applyCodexKaixuanPreset('kaixuan-kxpms', { apiKey: 'sk-a"b\\c' })
    const written = readFileSync(join(workingHome, 'config.toml'), 'utf-8')
    expect(written).toContain('experimental_bearer_token = "sk-a\\"b\\\\c"')
  })

  it('never emits env_key alongside an inline token (codex aborts on the missing var)', () => {
    // Why: verified against codex-cli 0.158.0 on 2026-09-28 against the live
    // gateway. A table with BOTH fields aborts with
    // "ERROR: Missing environment variable: `OPENAI_API_KEY`" — codex resolves
    // env_key first and never reaches experimental_bearer_token. Emitting both
    // therefore silently discards the key the user just typed in.
    applyCodexKaixuanPreset('kaixuan-kxpms', { apiKey: 'sk-test-token' })
    const withKey = readFileSync(join(workingHome, 'config.toml'), 'utf-8')
    expect(withKey).toContain('experimental_bearer_token = "sk-test-token"')
    expect(withKey).not.toContain('env_key')

    // With no inline token, env_key is the only auth path and must be present.
    applyCodexKaixuanPreset('kaixuan-kxpms')
    const withoutKey = readFileSync(join(workingHome, 'config.toml'), 'utf-8')
    expect(withoutKey).toContain('env_key = "OPENAI_API_KEY"')
    expect(withoutKey).not.toContain('experimental_bearer_token')
  })

  // --- v4: custom provider registry ---

  it('applyCodexProvider writes a custom provider table without disturbing built-ins', () => {
    const configPath = join(workingHome, 'config.toml')
    const result = applyCodexProvider(GLM_PROVIDER, KNOWN_BUILT_IN_AND_GLM)
    expect(result.error).toBeNull()
    expect(result.providerId).toBe('glm-5.2')
    const written = readFileSync(configPath, 'utf-8')
    expect(written).toContain('model_provider = "glm-5.2"')
    expect(written).toContain('[model_providers."glm-5.2"]')
    expect(written).toContain('base_url = "https://api.z.ai/api/coding/paas/v4"')
    // The custom table must not be confused with a built-in.
    expect(written).not.toContain('[model_providers."kaixuan-')
  })

  it('switching from built-in to custom removes the built-in table and replaces it', () => {
    applyCodexKaixuanPreset('kaixuan-local')
    applyCodexProvider(GLM_PROVIDER, KNOWN_BUILT_IN_AND_GLM)
    const written = readFileSync(join(workingHome, 'config.toml'), 'utf-8')
    expect(written).toContain('model_provider = "glm-5.2"')
    expect(written).toContain('[model_providers."glm-5.2"]')
    expect(written).not.toContain('[model_providers."kaixuan-local"]')
    expect(written).not.toMatch(/^model_provider\s*=\s*"kaixuan-/m)
  })

  it('switching from one custom provider to another replaces only that one', () => {
    const kimiProvider: ProviderPresetDefinition = {
      ...GLM_PROVIDER,
      id: 'kimi-k2',
      label: 'Kimi K2',
      modelProviderName: 'kimi-k2',
      codexProviderName: 'Kimi K2',
      codexBaseUrl: 'https://api.moonshot.cn/v1'
    }
    const registry = new Set<string>(['glm-5.2', 'kimi-k2'])
    applyCodexProvider(GLM_PROVIDER, registry)
    applyCodexProvider(kimiProvider, registry)
    const written = readFileSync(join(workingHome, 'config.toml'), 'utf-8')
    expect(written).toContain('model_provider = "kimi-k2"')
    expect(written).toContain('[model_providers."kimi-k2"]')
    expect(written).not.toContain('[model_providers."glm-5.2"]')
  })

  it('readActiveCodexProvider resolves the active id when known to the registry', () => {
    const content = 'theme = "dark"\nmodel_provider = "glm-5.2"\n[model_providers.glm-5.2]\n'
    expect(readActiveCodexProvider(content, KNOWN_BUILT_IN_AND_GLM)).toBe('glm-5.2')
  })

  it('readActiveCodexProvider returns null when the active id is not in the registry', () => {
    const content = 'model_provider = "glm-5.2"\n[model_providers.glm-5.2]\n'
    // Same config, but renderer forgot to include glm-5.2 in its known list —
    // we must NOT guess; treat as no active provider.
    expect(readActiveCodexProvider(content, BUILT_IN_PROVIDER_IDS)).toBeNull()
  })

  it('renderCodexConfigForProvider is pure and round-trips a custom provider', () => {
    const once = renderCodexConfigForProvider('', GLM_PROVIDER, KNOWN_BUILT_IN_AND_GLM)
    const twice = renderCodexConfigForProvider(once, GLM_PROVIDER, KNOWN_BUILT_IN_AND_GLM)
    expect(twice).toBe(once)
  })

  it('clears both built-in and custom artifacts when provider=null', () => {
    const configPath = join(workingHome, 'config.toml')
    applyCodexKaixuanPreset('kaixuan-local')
    applyCodexProvider(GLM_PROVIDER, KNOWN_BUILT_IN_AND_GLM)
    const result = applyCodexProvider(null, KNOWN_BUILT_IN_AND_GLM)
    expect(result.providerId).toBeNull()
    const written = readFileSync(configPath, 'utf-8')
    expect(written).not.toContain('[model_providers."glm-5.2"]')
    expect(written).not.toContain('[model_providers."kaixuan-')
    expect(written).not.toMatch(/^model_provider\s*=\s*"(glm|kaixuan)-/m)
  })

  it('still uses KAIXUAN_PRESETS values for the wrapper path (smoke)', () => {
    const beforeApply = KAIXUAN_PRESETS['kaixuan-local']
    applyCodexKaixuanPreset('kaixuan-local')
    const written = readFileSync(join(workingHome, 'config.toml'), 'utf-8')
    expect(written).toContain(`base_url = "${beforeApply.codexBaseUrl}"`)
  })

  // Why parse the header instead of matching its text: the whole defect is that
  // `[model_providers.glm-5.2]` is VALID TOML — it just means something else
  // (`model_providers.glm-5` → `2`). A `toContain` assertion passes against the
  // broken shape, which is why the suite was green while Codex could not
  // resolve the provider. parseTomlTableHeaderPath reports what Codex's TOML
  // layer actually sees.
  it('a dotted provider id lands as ONE flat model_providers key, not a nested table', () => {
    const config = renderCodexConfigForProvider('', GLM_PROVIDER, KNOWN_BUILT_IN_AND_GLM)
    const header = config.split('\n').find((line) => line.startsWith('[model_providers'))
    expect(header).toBeDefined()
    const parsed = parseTomlTableHeaderPath(header ?? '')
    expect(parsed?.segments).toEqual(['model_providers', 'glm-5.2'])
    expect(parsed?.isArray).toBe(false)
  })

  it('control: the unquoted header form really does split into a nested table', () => {
    // Guards the guard — if this ever stops splitting, the assertion above is
    // no longer proving anything.
    expect(parseTomlTableHeaderPath('[model_providers.glm-5.2]')?.segments).toEqual([
      'model_providers',
      'glm-5',
      '2'
    ])
  })

  it('strips a legacy UNQUOTED table left by an earlier Orca version', () => {
    // Backward compatibility: configs written before the header was quoted are
    // still on disk, and a switch must remove them or the stale table lingers.
    const legacy = [
      'model_provider = "glm-5.2"',
      '',
      '[model_providers.glm-5.2]',
      'name = "GLM 5.2 (Z.AI)"',
      'base_url = "https://api.z.ai/api/coding/paas/v4"',
      ''
    ].join('\n')
    const next = renderCodexConfigForProvider(legacy, GLM_PROVIDER, KNOWN_BUILT_IN_AND_GLM)
    const legacyHeaders = next
      .split('\n')
      .filter((line) => line.startsWith('[model_providers.glm-5'))
    expect(legacyHeaders).toHaveLength(0)
    expect(next).toContain('[model_providers."glm-5.2"]')
  })

  it('leaves a user-owned unquoted provider table untouched', () => {
    const withUser = [
      '[model_providers.my-own]',
      'name = "Mine"',
      'base_url = "https://example.test/v1"',
      ''
    ].join('\n')
    const next = renderCodexConfigForProvider(withUser, GLM_PROVIDER, KNOWN_BUILT_IN_AND_GLM)
    expect(next).toContain('[model_providers.my-own]')
    expect(next).toContain('base_url = "https://example.test/v1"')
  })
})
