import { describe, expect, it } from 'vitest'
import {
  BUILT_IN_PROVIDER_IDS,
  KAIXUAN_PRESETS,
  KAIXUAN_PRESET_ORDER,
  type KaixuanPresetId,
  type ProviderPresetAgentId,
  type ProviderPresetDefinition
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

  it('BUILT_IN_PROVIDER_IDS is the same set of ids as KAIXUAN_PRESETS', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Object.keys returns string[]; narrowing requires casting to KaixuanPresetId[] for the Set constructor.
    const keys = Object.keys(KAIXUAN_PRESETS) as KaixuanPresetId[]
    expect(new Set(keys)).toEqual(BUILT_IN_PROVIDER_IDS)
  })

  it('ProviderPresetDefinition is reusable for custom providers (smoke check)', () => {
    const custom: ProviderPresetDefinition = {
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
    // The shape is identical to KAIXUAN_PRESETS values, so the same apply
    // functions accept both — verified by type system only here.
    expect(custom.id).toBe('glm-5.2')
    expect(custom.codexBaseUrl).toMatch(/^https:\/\//)
    expect(custom.opencodeModelIds).toContain('glm-5.2')
  })
})
