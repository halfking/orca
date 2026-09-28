// What: 给 OpenCode 系统 config 写 kaixuan preset：
// presetId 切换 `provider.kaixuan-<id>.baseURL` + `provider.kaixuan-<id>.apiKey`，并把顶层 `model` 设为合适模型。
// presetId 为 null 时清掉所有 kaixuan provider 条目，把 `model` 复原到用户原有值。
//
// Why: OpenCode CLI 通过 opencode.json 的 provider map 切换厂商。这里的 `OPENCODE_CONFIG_DIR` 复用了
// shared/opencode-config-directory.ts 的解析规则——XDG_CONFIG_HOME 优先。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { KAIXUAN_PRESETS, type KaixuanPresetId } from '../../shared/provider-preset-types'
import { resolveOpenCodeConfigDirectory } from '../../shared/opencode-config-directory'

type OpenCodeApplyResult = {
  agentId: 'opencode'
  configPath: string
  presetId: KaixuanPresetId | null
  error: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Pure helper — exposed for testing. */
export function applyKaixuanToOpenCodeConfig(
  config: unknown,
  presetId: KaixuanPresetId | null
): { next: Record<string, unknown>; presetProviderKey: string | null } {
  const next: Record<string, unknown> = isRecord(config) ? { ...config } : {}
  const providerRaw = next.provider
  const provider: Record<string, Record<string, unknown>> = isRecord(providerRaw)
    ? Object.fromEntries(
        Object.entries(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: providerRaw passed isRecord() above; the cast widens unknown → Record<string, unknown> for the entries() iterator only.
          providerRaw as Record<string, unknown>
        ).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
      )
    : {}
  // Drop any kaixuan-attributed providers so a switch flips cleanly.
  for (const key of Object.keys(provider)) {
    if (key.startsWith('kaixuan-')) {
      delete provider[key]
    }
  }
  let presetProviderKey: string | null = null
  if (presetId !== null) {
    const preset = KAIXUAN_PRESETS[presetId]
    presetProviderKey = `kaixuan-${presetId.split('-')[1]}`
    provider[presetProviderKey] = {
      name: preset.codexProviderName,
      baseURL: preset.opencodeBaseUrl,
      apiKey: `\${env:${preset.envKeyName}}`,
      // OpenCode accepts the OpenAI Responses protocol adapter transparently when
      // it sees an OpenAI-shaped baseURL; we don't force a model here so the
      // user's configured `model` field remains the source of truth.
      npm: '@ai-sdk/openai-compatible'
    }
  }
  next.provider = provider
  return { next, presetProviderKey }
}

/** Read the active preset id by scanning provider map for kaixuan-* baseURL match. */
export function readActiveOpenCodeKaixuanPreset(config: unknown): KaixuanPresetId | null {
  if (!isRecord(config) || !isRecord(config.provider)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: config.provider passed isRecord() above; the cast widens unknown → Record<string, unknown> for the bracket lookup.
  const provider = config.provider as Record<string, unknown>
  for (const id of Object.keys(KAIXUAN_PRESETS) as KaixuanPresetId[]) { // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Object.keys returns string[]; the cast only narrows to the union of known preset ids for the dispatch table.
    const providerKey = `kaixuan-${id.split('-')[1]}`
    const entry = provider[providerKey]
    if (isRecord(entry) && entry.baseURL === KAIXUAN_PRESETS[id].opencodeBaseUrl) {
      return id
    }
  }
  return null
}

/** Apply or remove the kaixuan preset on disk. */
export function applyOpenCodeKaixuanPreset(
  presetId: KaixuanPresetId | null,
  options?: { apiKey?: string | null; environment?: NodeJS.ProcessEnv }
): OpenCodeApplyResult {
  const configDir = resolveOpenCodeConfigDirectory(options?.environment ?? process.env)
  const configPath = join(configDir, 'opencode.json')
  try {
    mkdirSync(dirname(configPath), { recursive: true })
    let current: unknown = {}
    if (existsSync(configPath)) {
      try {
        current = JSON.parse(readFileSync(configPath, 'utf-8'))
      } catch {
        current = {}
      }
    }
    const { next } = applyKaixuanToOpenCodeConfig(current, presetId)
    if (presetId !== null && options?.apiKey) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: applyKaixuanToOpenCodeConfig returned Record for next.provider; this widens for the apiKey mutation only.
      const provider: Record<string, Record<string, unknown>> = next.provider as Record<
        string,
        Record<string, unknown>
      >
      const providerKey = `kaixuan-${presetId.split('-')[1]}`
      if (provider[providerKey]) {
        provider[providerKey].apiKey = options.apiKey
      }
    }
    writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
    return { agentId: 'opencode', configPath, presetId, error: null }
  } catch (error) {
    return {
      agentId: 'opencode',
      configPath,
      presetId,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function readActiveOpenCodeKaixuanPresetFromDisk(options?: {
  environment?: NodeJS.ProcessEnv
}): { presetId: KaixuanPresetId | null; configPath: string } {
  const configDir = resolveOpenCodeConfigDirectory(options?.environment ?? process.env)
  const configPath = join(configDir, 'opencode.json')
  if (!existsSync(configPath)) {
    return { presetId: null, configPath }
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
    return { presetId: readActiveOpenCodeKaixuanPreset(parsed), configPath }
  } catch {
    return { presetId: null, configPath }
  }
}
