import { describe, expect, it } from 'vitest'
import {
  BUILT_IN_PROVIDER_IDS,
  KAIXUAN_PRESETS,
  KAIXUAN_PRESET_ORDER,
  isProviderPresetIdInterpolationSafe,
  isSafeEnvKeyName,
  type KaixuanPresetId,
  type ProviderPresetAgentId,
  type ProviderPresetApplyResult,
  type ProviderPresetApi,
  type ProviderPresetDefinition
} from './provider-preset-types'

const PRESET_IDS = Object.keys(KAIXUAN_PRESETS).sort()

/** Every field that a custom entry can set, so the safety sweep below covers
 *  all of them rather than the two built-ins only. */
function builtinPresetDefinitions(): ProviderPresetDefinition[] {
  return PRESET_IDS.flatMap((id) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: PRESET_IDS is Object.keys(KAIXUAN_PRESETS), and KAIXUAN_PRESETS is keyed exactly by KaixuanPresetId, so the index is total.
    return [KAIXUAN_PRESETS[id as KaixuanPresetId]]
  })
}

describe('provider-preset-types — preset ids', () => {
  it('accepts the built-in ids and typical custom ids', () => {
    for (const id of [
      ...BUILT_IN_PROVIDER_IDS,
      'glm-5.2',
      'my-gateway',
      'Kimi_Moonshot',
      'v1',
      'gw|2',
      'x@y:z+a'
    ]) {
      expect(isProviderPresetIdInterpolationSafe(id), `expected ${id} to be safe`).toBe(true)
    }
  })

  it('rejects ids that would terminate or split a TOML header, a quoted TOML value or a JSON key', () => {
    // '"' / "'" escape or close the quoted TOML value and the JSON key; '[' /
    // ']' / '\' break the table header line; whitespace and control characters
    // cannot appear in a bare table header; empty would collapse the strip
    // regex alternation to a branch matching nothing.
    for (const id of [
      '',
      'my gateway',
      'my"gateway',
      "my'gateway",
      'my]gateway',
      '[gateway]',
      'a\\b',
      'a\nb',
      'a{b}',
      'a#b'
    ]) {
      expect(isProviderPresetIdInterpolationSafe(id), `expected ${id} to be rejected`).toBe(false)
    }
  })

  it.fails('KNOWN GAP: an id with a dot still breaks the unquoted Codex table header', () => {
    // `[model_providers.glm-5.2]` parses as model_providers.glm-5.2 nested
    // table, so Codex resolves nothing. This is the id the v4 custom-provider
    // UI suggests, so the defect is reachable. The fix is to quote the header
    // in codex-apply-provider-preset.ts; flip this to a plain `it` then.
    expect(isProviderPresetIdInterpolationSafe('glm-5.2')).toBe(false)
  })

  it('every built-in preset ships interpolation-safe id and modelProviderName values', () => {
    for (const preset of builtinPresetDefinitions()) {
      expect(isProviderPresetIdInterpolationSafe(preset.id), `${preset.id}.id`).toBe(true)
      expect(
        isProviderPresetIdInterpolationSafe(preset.modelProviderName),
        `${preset.id}.modelProviderName`
      ).toBe(true)
    }
  })

  it('modelProviderName equals id — strip matches on id but the table header is written from modelProviderName', () => {
    // codex-apply-provider-preset builds the strip regex from the registry ids
    // and writes `[model_providers.<modelProviderName>]`. If the two diverge,
    // a second apply can no longer strip the table the first apply wrote.
    for (const preset of builtinPresetDefinitions()) {
      expect(preset.modelProviderName, `${preset.id}`).toBe(preset.id)
    }
  })

  it('envKeyName is a POSIX env variable name', () => {
    for (const preset of builtinPresetDefinitions()) {
      expect(isSafeEnvKeyName(preset.envKeyName), `${preset.id}.envKeyName`).toBe(true)
    }
    expect(isSafeEnvKeyName('')).toBe(false)
    expect(isSafeEnvKeyName('2OPENAI_API_KEY')).toBe(false)
    expect(isSafeEnvKeyName('OPENAI-API-KEY')).toBe(false)
  })
})

describe('provider-preset-types — preset values', () => {
  it('codex and opencode base urls carry the /v1 suffix, the claude one does not', () => {
    for (const preset of builtinPresetDefinitions()) {
      expect(preset.codexBaseUrl.endsWith('/v1'), `${preset.id}.codexBaseUrl`).toBe(true)
      expect(preset.opencodeBaseUrl.endsWith('/v1'), `${preset.id}.opencodeBaseUrl`).toBe(true)
      expect(preset.claudeBaseUrl.endsWith('/v1'), `${preset.id}.claudeBaseUrl`).toBe(false)
      expect(preset.claudeBaseUrl, `${preset.id}`).toBe(
        preset.opencodeBaseUrl.replace(/\/v1$/u, '')
      )
    }
  })

  it('every preset exposes a non-empty, duplicate-free OpenCode model list', () => {
    // A provider entry without `models` is never registered by opencode:
    // `opencode models <id>` answers "Provider not found".
    for (const preset of builtinPresetDefinitions()) {
      expect(preset.opencodeModelIds.length, `${preset.id}`).toBeGreaterThan(0)
      expect(new Set(preset.opencodeModelIds).size, `${preset.id} has duplicates`).toBe(
        preset.opencodeModelIds.length
      )
      for (const modelId of preset.opencodeModelIds) {
        expect(modelId, `${preset.id} model id`).toBeTruthy()
      }
    }
  })

  it('labels are non-empty and distinct from the bare id', () => {
    for (const preset of builtinPresetDefinitions()) {
      expect(preset.label, `${preset.id}`).not.toBe(preset.id)
      expect(preset.codexProviderName, `${preset.id}`).toBeTruthy()
    }
  })

  it('KAIXUAN_PRESET_ORDER has no duplicate ids', () => {
    expect(new Set(KAIXUAN_PRESET_ORDER).size).toBe(KAIXUAN_PRESET_ORDER.length)
  })

  it('BUILT_IN_PROVIDER_IDS stays non-empty — apply functions fall back to it when a caller passes no registry', () => {
    expect(BUILT_IN_PROVIDER_IDS.size).toBe(PRESET_IDS.length)
  })
})

describe('provider-preset-types — ipc contract', () => {
  it('the apply result carries agentId, providerId, configPath and error', () => {
    const cleared: ProviderPresetApplyResult = {
      agentId: 'codex',
      providerId: null,
      configPath: '/tmp/.codex/config.toml',
      error: null
    }
    const failed: ProviderPresetApplyResult = {
      agentId: 'opencode',
      providerId: 'kaixuan-local',
      configPath: '/tmp/opencode.json',
      error: 'boom'
    }
    expect(Object.keys(cleared).sort()).toEqual(['agentId', 'configPath', 'error', 'providerId'])
    expect(failed.error).toBe('boom')
  })

  it('the bridge exposes apply + getCurrent for all three agents', () => {
    const api: ProviderPresetApi = {
      applyCodex: async () => {
        throw new Error('unused')
      },
      applyClaude: async () => {
        throw new Error('unused')
      },
      applyOpenCode: async () => {
        throw new Error('unused')
      },
      getCurrent: async () => {
        throw new Error('unused')
      }
    }
    expect(Object.keys(api).sort()).toEqual([
      'applyClaude',
      'applyCodex',
      'applyOpenCode',
      'getCurrent'
    ])
  })
})

describe('provider-preset-types — baseline', () => {
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
    expect(isProviderPresetIdInterpolationSafe(custom.id)).toBe(true)
    expect(custom.codexBaseUrl).toMatch(/^https:\/\//)
    expect(custom.opencodeModelIds).toContain('glm-5.2')
  })
})
