// What: 给 OpenCode 系统 config 写 kaixuan preset。
// presetId 写一个 `provider.kaixuan-<id>` 条目，包含 npm / name / options.baseURL / options.apiKey。
// presetId 为 null 时清掉所有 kaixuan-* provider 条目，其它保留。
//
// Why: OpenCode CLI 通过 opencode.json 的 provider map 切换厂商。这里的 `OPENCODE_CONFIG_DIR` 复用了
// shared/opencode-config-directory.ts 的解析规则——XDG_CONFIG_HOME 优先。
//
// Schema 参考 opencode.ai/docs/providers: 每个 provider 条目里 baseURL / apiKey 必须放在 options 子对象下，
// 不是顶级 — 否则 OpenCode 不会读。
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

/** Pure helper — exposed for testing. Returns the rewritten config and the
 *  preset's provider key (null when presetId is null). The provider entry
 *  follows opencode.ai/docs/providers: `{ npm, name, options: { baseURL, apiKey } }`.
 */
export function applyKaixuanToOpenCodeConfig(
  config: unknown,
  presetId: KaixuanPresetId | null,
  apiKeyPlaceholder = '{env:OPENAI_API_KEY}'
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
    // Why: OpenCode's schema requires baseURL/apiKey to live under `options`,
    // not at the top of the provider entry. We use the opencode-documented
    // `{env:VAR}` placeholder so the user's OPENAI_API_KEY env var resolves at
    // opencode startup — matches what opencode's /connect flow writes.
    //
    // Why `models` is mandatory: a provider entry with no `models` map is never
    // registered by opencode — `opencode models <id>` replies `Provider not found`.
    // Verified live against opencode 1.14.33 on 2026-09-28: the identical entry
    // without `models` failed to resolve, and with it the model listed and a real
    // inference call round-tripped.
    provider[presetProviderKey] = {
      npm: '@ai-sdk/openai-compatible',
      name: preset.codexProviderName,
      options: {
        baseURL: preset.opencodeBaseUrl,
        apiKey: apiKeyPlaceholder
      },
      models: Object.fromEntries(
        preset.opencodeModelIds.map((modelId) => [modelId, { name: modelId }])
      )
    }
  }
  next.provider = provider
  return { next, presetProviderKey }
}

/** Read the active preset id by scanning provider map for kaixuan-* baseURL match.
 *  Looks at options.baseURL because baseURL lives under options per opencode schema.
 */
export function readActiveOpenCodeKaixuanPreset(config: unknown): KaixuanPresetId | null {
  if (!isRecord(config) || !isRecord(config.provider)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: config.provider passed isRecord() above; the cast widens unknown → Record<string, unknown> for the bracket lookup.
  const provider = config.provider as Record<string, unknown>
  for (const id of Object.keys(KAIXUAN_PRESETS) as KaixuanPresetId[]) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Object.keys returns string[]; the cast only narrows to the union of known preset ids for the dispatch table.
    const providerKey = `kaixuan-${id.split('-')[1]}`
    const entry = provider[providerKey]
    if (
      isRecord(entry) &&
      isRecord(entry.options) &&
      entry.options.baseURL === KAIXUAN_PRESETS[id].opencodeBaseUrl
    ) {
      return id
    }
  }
  return null
}

/** Apply or remove the kaixuan preset on disk.
 *  Why: when caller supplies an explicit apiKey, we override the placeholder; this is
 *  the Orca-side equivalent of running `opencode auth set <id> <token>` from the
 *  shell before invoking the agent.
 */
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
    const apiKeyPlaceholder =
      options?.apiKey && options.apiKey.length > 0 ? options.apiKey : '{env:OPENAI_API_KEY}'
    const { next } = applyKaixuanToOpenCodeConfig(current, presetId, apiKeyPlaceholder)
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
