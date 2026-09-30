import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('./codex-home-paths', () => ({
  getSystemCodexHomePath: () => process.env.CODEX_TEST_HOME ?? '/tmp/codex-test'
}))

const { applyCodexKaixuanPreset, renderCodexConfigForPreset, readActiveCodexKaixuanPreset } =
  await import('./codex-apply-provider-preset')

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

  it('writes a model_provider + [model_providers.kaixuan-local] table on apply', () => {
    const configPath = join(workingHome, 'config.toml')
    const result = applyCodexKaixuanPreset('kaixuan-local')
    expect(result.error).toBeNull()
    expect(result.presetId).toBe('kaixuan-local')
    expect(result.configPath).toBe(configPath)
    const written = readFileSync(configPath, 'utf-8')
    expect(written).toContain('model_provider = "kaixuan-local"')
    expect(written).toContain('[model_providers.kaixuan-local]')
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
    expect(written).toContain('[model_providers.kaixuan-kxpms]')
    expect(written).toContain('base_url = "https://llm.kxpms.cn/v1"')
  })

  it('switches cleanly between presets (no duplicate blocks)', () => {
    const configPath = join(workingHome, 'config.toml')
    applyCodexKaixuanPreset('kaixuan-local')
    applyCodexKaixuanPreset('kaixuan-kxpms')
    const written = readFileSync(configPath, 'utf-8')
    expect((written.match(/\[model_providers\.kaixuan-/g) ?? []).length).toBe(1)
    expect(written).toContain('[model_providers.kaixuan-kxpms]')
    expect(written).not.toContain('[model_providers.kaixuan-local]')
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

  it('renderCodexConfigForPreset is idempotent across repeated applies', () => {
    const once = renderCodexConfigForPreset('', 'kaixuan-local')
    const twice = renderCodexConfigForPreset(once, 'kaixuan-local')
    expect(twice).toBe(once)
  })
})
