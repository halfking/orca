// What: 给 OpenCode 系统 config 写 provider preset：内置 kaixuan 两个端点 +
// 用户通过 AccountsPane 注册表新增的任意 OpenAI 兼容厂商。
// provider=非 null 时写一个 `provider.<id>` 条目，包含 npm / name /
// options.baseURL / options.apiKey / models。
// provider=null 时清掉所有已知 provider 条目，其它保留。
//
// Why: OpenCode CLI 通过 opencode.json 的 provider map 切换厂商。这里的
// `OPENCODE_CONFIG_DIR` 复用了 shared/opencode-config-directory.ts 的解析规则
// ——XDG_CONFIG_HOME 优先。
//
// Schema 参考 opencode.ai/docs/providers: 每个 provider 条目里 baseURL / apiKey
// 必须放在 options 子对象下，不是顶级 — 否则 OpenCode 不会读。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  KAIXUAN_PRESETS,
  type KaixuanPresetId,
  type ProviderPresetDefinition
} from '../../shared/provider-preset-types'
import { resolveOpenCodeConfigDirectory } from '../../shared/opencode-config-directory'

type OpenCodeApplyResult = {
  agentId: 'opencode'
  configPath: string
  providerId: string | null
  error: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Pure helper — exposed for testing. Returns the rewritten config and the
 *  provider's map key (null when provider is null). The provider entry
 *  follows opencode.ai/docs/providers: `{ npm, name, options: { baseURL, apiKey }, models }`.
 *
 *  Why `models` is mandatory: a provider entry with no `models` map is never
 *  registered by opencode — `opencode models <id>` replies `Provider not found`.
 *  Verified live against opencode 1.14.33 on 2026-09-28.
 */
export function applyProviderToOpenCodeConfig(
  config: unknown,
  provider: ProviderPresetDefinition | null,
  knownIds: ReadonlySet<string>,
  apiKeyPlaceholder = '{env:OPENAI_API_KEY}'
): { next: Record<string, unknown>; presetProviderKey: string | null } {
  const next: Record<string, unknown> = isRecord(config) ? { ...config } : {}
  const providerRaw = next.provider
  const providerMap: Record<string, Record<string, unknown>> = isRecord(providerRaw)
    ? Object.fromEntries(
        Object.entries(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: providerRaw passed isRecord() above; the cast widens unknown → Record<string, unknown> for the entries() iterator only.
          providerRaw as Record<string, unknown>
        ).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
      )
    : {}
  // Drop any provider entries whose key is in the registry. We only strip
  // entries Orca previously wrote — user-owned providers outside the registry
  // stay intact. (For Orca-written entries, the key is exactly the provider id.)
  for (const id of knownIds) {
    delete providerMap[id]
  }
  let presetProviderKey: string | null = null
  if (provider !== null) {
    presetProviderKey = provider.id
    // Why: OpenCode's schema requires baseURL/apiKey to live under `options`,
    // not at the top of the provider entry. We use the opencode-documented
    // `{env:VAR}` placeholder so the user's OPENAI_API_KEY env var resolves at
    // opencode startup — matches what opencode's /connect flow writes.
    providerMap[presetProviderKey] = {
      npm: '@ai-sdk/openai-compatible',
      name: provider.codexProviderName,
      options: {
        baseURL: provider.opencodeBaseUrl,
        apiKey: apiKeyPlaceholder
      },
      models: Object.fromEntries(
        provider.opencodeModelIds.map((modelId) => [modelId, { name: modelId }])
      )
    }
  }
  next.provider = providerMap
  return { next, presetProviderKey }
}

/** Read the active provider id by scanning provider map for any registered
 *  provider's options.baseURL match. Built-in + custom providers share the
 *  same registry here, so a custom one matches by its claudeBaseUrl-shaped
 *  opencodeBaseUrl value. */
export function readActiveOpenCodeProvider(
  config: unknown,
  knownProviders: readonly ProviderPresetDefinition[]
): string | null {
  if (!isRecord(config) || !isRecord(config.provider)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: config.provider passed isRecord() above; the cast widens unknown → Record<string, unknown> for the bracket lookup.
  const providerMap = config.provider as Record<string, unknown>
  for (const provider of knownProviders) {
    const entry = providerMap[provider.id]
    if (
      isRecord(entry) &&
      isRecord(entry.options) &&
      entry.options.baseURL === provider.opencodeBaseUrl
    ) {
      return provider.id
    }
  }
  return null
}

/** Apply or remove the provider preset on disk.
 *  Why: when caller supplies an explicit apiKey, we override the placeholder
 *  with the literal token. Note this is **not** equivalent to running
 *  `opencode auth set <id> <token>`: that command writes to
 *  `$XDG_DATA_HOME/opencode/auth.json` (per opencode `packages/opencode/src/auth/index.ts`),
 *  while this function writes to `options.apiKey` inside
 *  `$XDG_CONFIG_HOME/opencode/opencode.json`. opencode 1.x's config schema
 *  accepts a literal token in `options.apiKey`, so both forms work at runtime,
 *  but they live in different files with different security profiles. The
 *  literal-token path keeps the key inside the user's general config file
 *  alongside theme / model / mcp / permission / agents / instructions — the
 *  same fail-closed guard above therefore applies to it as well.
 */
export function applyOpenCodeProvider(
  provider: ProviderPresetDefinition | null,
  knownIds: ReadonlySet<string>,
  options?: { apiKey?: string | null; environment?: NodeJS.ProcessEnv }
): OpenCodeApplyResult {
  const configDir = resolveOpenCodeConfigDirectory(options?.environment ?? process.env)
  const configPath = join(configDir, 'opencode.json')
  try {
    mkdirSync(dirname(configPath), { recursive: true })
    let current: unknown = {}
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8')
      try {
        current = JSON.parse(raw)
      } catch (error) {
        // Why fail closed: this file holds every OpenCode setting the user owns
        // (theme, model, mcp servers, permissions, agents, instructions). If it
        // does not parse we cannot merge into it, and the old behaviour —
        // `current = {}` then writeFileSync — silently replaced the whole file
        // with a bare `{ provider: ... }`, destroying all of it with no error
        // surfaced. Refuse the write and let the user repair the file; the
        // Codex path never had this hazard because it rewrites TOML textually.
        return {
          agentId: 'opencode',
          configPath,
          providerId: provider?.id ?? null,
          error: `Refusing to overwrite ${configPath}: existing file is not valid JSON (${error instanceof Error ? error.message : String(error)}). Fix or move the file, then retry.`
        }
      }
    }
    const apiKeyPlaceholder =
      options?.apiKey && options.apiKey.length > 0 ? options.apiKey : '{env:OPENAI_API_KEY}'
    const { next } = applyProviderToOpenCodeConfig(current, provider, knownIds, apiKeyPlaceholder)
    writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
    return {
      agentId: 'opencode',
      configPath,
      providerId: provider?.id ?? null,
      error: null
    }
  } catch (error) {
    return {
      agentId: 'opencode',
      configPath,
      providerId: provider?.id ?? null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function readActiveOpenCodeProviderFromDisk(
  knownProviders: readonly ProviderPresetDefinition[],
  options?: { environment?: NodeJS.ProcessEnv }
): { providerId: string | null; configPath: string } {
  const configDir = resolveOpenCodeConfigDirectory(options?.environment ?? process.env)
  const configPath = join(configDir, 'opencode.json')
  if (!existsSync(configPath)) {
    return { providerId: null, configPath }
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
    return { providerId: readActiveOpenCodeProvider(parsed, knownProviders), configPath }
  } catch {
    return { providerId: null, configPath }
  }
}

// --- v3 thin wrappers retained for backward-compatibility ---

const KAIXUAN_IDS_FALLBACK: ReadonlySet<string> = new Set<KaixuanPresetId>([
  'kaixuan-local',
  'kaixuan-kxpms'
])

export function applyKaixuanToOpenCodeConfig(
  config: unknown,
  presetId: KaixuanPresetId | null,
  apiKeyPlaceholder = '{env:OPENAI_API_KEY}'
): { next: Record<string, unknown>; presetProviderKey: string | null } {
  const provider = presetId === null ? null : KAIXUAN_PRESETS[presetId]
  return applyProviderToOpenCodeConfig(config, provider, KAIXUAN_IDS_FALLBACK, apiKeyPlaceholder)
}

export function readActiveOpenCodeKaixuanPreset(config: unknown): KaixuanPresetId | null {
  const builtInList = Object.values(KAIXUAN_PRESETS)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: builtInList narrows the return to the KaixuanPresetId union (only built-in values come back here); the cast only re-asserts that narrower union.
  return readActiveOpenCodeProvider(config, builtInList) as KaixuanPresetId | null
}

export function applyOpenCodeKaixuanPreset(
  presetId: KaixuanPresetId | null,
  options?: { apiKey?: string | null; environment?: NodeJS.ProcessEnv }
): OpenCodeApplyResult {
  const provider = presetId === null ? null : KAIXUAN_PRESETS[presetId]
  return applyOpenCodeProvider(provider, KAIXUAN_IDS_FALLBACK, options)
}

export function readActiveOpenCodeKaixuanPresetFromDisk(options?: {
  environment?: NodeJS.ProcessEnv
}): { providerId: string | null; configPath: string } {
  const builtInList = Object.values(KAIXUAN_PRESETS)
  return readActiveOpenCodeProviderFromDisk(builtInList, options)
}
