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
  readActiveOpenCodeKaixuanPreset
} = await import('./opencode-apply-provider-preset')

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

  it('writes provider.kaixuan-local under options.baseURL/apiKey with placeholder by default', () => {
    const result = applyOpenCodeKaixuanPreset('kaixuan-local')
    expect(result.error).toBeNull()
    const configPath = join(workingHome, '.config', 'opencode', 'opencode.json')
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    // Why: OpenCode's schema puts baseURL and apiKey under `options`, not at the
    // provider entry root. Anything else and opencode silently ignores the entry.
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
    // Old shape (top-level baseURL, written by 1.0) should no longer be detected —
    // apply would rewrite it on next call.
    expect(
      readActiveOpenCodeKaixuanPreset({
        provider: { 'kaixuan-local': { baseURL: 'http://127.0.0.1:8782/v1' } }
      })
    ).toBeNull()
    expect(readActiveOpenCodeKaixuanPreset({ provider: {} })).toBeNull()
    expect(readActiveOpenCodeKaixuanPreset({})).toBeNull()
  })
})
