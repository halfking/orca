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

  it('writes provider.kaixuan-local block on apply', () => {
    const result = applyOpenCodeKaixuanPreset('kaixuan-local')
    expect(result.error).toBeNull()
    const configPath = join(workingHome, '.config', 'opencode', 'opencode.json')
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written.provider['kaixuan-local'].baseURL).toBe('http://127.0.0.1:8782/v1')
    expect(written.provider['kaixuan-local'].apiKey).toContain('OPENAI_API_KEY')
  })

  it('preserves unrelated provider entries', () => {
    const configDir = join(workingHome, '.config', 'opencode')
    mkdirSync(configDir, { recursive: true })
    const configPath = join(configDir, 'opencode.json')
    writeFileSync(
      configPath,
      JSON.stringify({ provider: { upstream: { baseURL: 'https://example.com' } } }, null, 2)
    )
    applyOpenCodeKaixuanPreset('kaixuan-kxpms')
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written.provider.upstream.baseURL).toBe('https://example.com')
    expect(written.provider['kaixuan-kxpms'].baseURL).toBe('https://llm.kxpms.cn/v1')
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
    const input = { provider: { upstream: { baseURL: 'https://example.com' } } }
    const result = applyKaixuanToOpenCodeConfig(input, 'kaixuan-local')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: result.next.provider is a Record after applyKaixuanToOpenCodeConfig; the cast only widens for the test's narrow access.
    const provider = result.next.provider as Record<string, Record<string, unknown>>
    expect(provider.upstream.baseURL).toBe('https://example.com')
    expect(provider['kaixuan-local'].baseURL).toBe('http://127.0.0.1:8782/v1')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: input.provider is a Record from the literal initializer; the cast only widens for the negative-lookup check.
    const inputProvider = input.provider as Record<string, unknown>
    expect(inputProvider['kaixuan-local']).toBeUndefined()
  })

  it('readActiveOpenCodeKaixuanPreset parses config', () => {
    expect(
      readActiveOpenCodeKaixuanPreset({
        provider: { 'kaixuan-local': { baseURL: 'http://127.0.0.1:8782/v1' } }
      })
    ).toBe('kaixuan-local')
    expect(
      readActiveOpenCodeKaixuanPreset({
        provider: { 'kaixuan-kxpms': { baseURL: 'https://llm.kxpms.cn/v1' } }
      })
    ).toBe('kaixuan-kxpms')
    expect(readActiveOpenCodeKaixuanPreset({ provider: {} })).toBeNull()
    expect(readActiveOpenCodeKaixuanPreset({})).toBeNull()
  })
})
