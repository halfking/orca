import { describe, expect, it } from 'vitest'
import {
  KAIXUAN_PRESETS,
  KAIXUAN_PRESET_ORDER,
  type KaixuanPresetId,
  type ProviderPresetAgentId
} from './provider-preset-types'

describe('provider-preset-types', () => {
  it('KAIXUAN_PRESETS contains exactly two ids with distinct endpoints', () => {
    expect(Object.keys(KAIXUAN_PRESETS).sort()).toEqual(['kaixuan-kxpms', 'kaixuan-local'])
    expect(KAIXUAN_PRESETS['kaixuan-local'].codexBaseUrl).not.toBe(
      KAIXUAN_PRESETS['kaixuan-kxpms'].codexBaseUrl
    )
    expect(KAIXUAN_PRESETS['kaixuan-local'].claudeBaseUrl).not.toBe(
      KAIXUAN_PRESETS['kaixuan-kxpms'].claudeBaseUrl
    )
  })

  it('KAIXUAN_PRESET_ORDER lists all preset ids', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Object.keys returns string[]; narrowing requires casting to KaixuanPresetId[] for the Set constructor.
    const keys = Object.keys(KAIXUAN_PRESETS) as KaixuanPresetId[]
    expect(new Set(KAIXUAN_PRESET_ORDER)).toEqual(new Set(keys))
  })

  it('all three agent ids map to a single preset field name', () => {
    const agentIds: ProviderPresetAgentId[] = ['codex', 'claude', 'opencode']
    for (const id of agentIds) {
      expect(id).toMatch(/^(codex|claude|opencode)$/)
    }
  })

  it('local preset points at 127.0.0.1:8782, kxpms preset at llm.kxpms.cn', () => {
    expect(KAIXUAN_PRESETS['kaixuan-local'].codexBaseUrl).toBe('http://127.0.0.1:8782/v1')
    expect(KAIXUAN_PRESETS['kaixuan-kxpms'].codexBaseUrl).toBe('https://llm.kxpms.cn/v1')
    expect(KAIXUAN_PRESETS['kaixuan-local'].claudeBaseUrl).toBe('http://127.0.0.1:8782')
    expect(KAIXUAN_PRESETS['kaixuan-kxpms'].claudeBaseUrl).toBe('https://llm.kxpms.cn')
  })
})
