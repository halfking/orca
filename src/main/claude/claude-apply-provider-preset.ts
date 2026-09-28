// What: 给 ClaudeCode 系统 settings.json 写 provider preset 的 env 注入：内置 kaixuan
// 两个端点 + 用户通过 AccountsPane 注册表新增的任意 OpenAI 兼容厂商。
// provider=非 null 时写入 env.ANTHROPIC_BASE_URL；若调用方提供了 apiKey，
// 再写 env.ANTHROPIC_AUTH_TOKEN=<token 字面值>。
// provider=null 时把 env 里残留的 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN /
// ANTHROPIC_API_KEY 全清。
//
// Why: ClaudeCode 通过 ~/.claude/settings.json 的 env 段切换厂商 base URL。
// Orca 的 claude-config-dir-pin.ts 把 CLAUDE_CONFIG_DIR 固定到当前账号的
// configDirName，所以这里的"系统 config"是 ~/.claude/<configDirName>/settings.json。
//
// Why we DON'T emit `${OPENAI_API_KEY}` like literal strings: ClaudeCode does no
// shell-style variable expansion inside settings.json's env block. Whatever string
// sits there gets sent verbatim to the upstream as the bearer token. So if the
// caller wants the gateway credential to be embedded, they must supply the literal
// token; otherwise we omit ANTHROPIC_AUTH_TOKEN entirely and let the user's shell
// export (or ANTHROPIC_API_KEY) win at ClaudeCode startup.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  KAIXUAN_PRESETS,
  type KaixuanPresetId,
  type ProviderPresetDefinition
} from '../../shared/provider-preset-types'

type ClaudeApplyResult = {
  agentId: 'claude'
  configPath: string
  providerId: string | null
  error: string | null
}

/** Resolve the ClaudeCode config dir based on CLAUDE_CONFIG_DIR override or
 *  the conventional `~/.claude` location. Mirrors hook-settings.ts:115.
 */
export function resolveClaudeConfigDir(configDirName = '.claude'): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim()
  return override ? override : join(homedir(), configDirName)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Pure helper — exposed for testing. Apply (or remove) a provider preset's
 *  env entries against the parsed settings object.
 *
 *  @param apiKey  inline bearer token to write as ANTHROPIC_AUTH_TOKEN. null/undefined
 *                means "leave it to the user's shell env / ANTHROPIC_API_KEY".
 */
export function applyProviderToClaudeSettings(
  settings: unknown,
  provider: ProviderPresetDefinition | null,
  apiKey?: string | null
): Record<string, unknown> {
  const next: Record<string, unknown> = isRecord(settings) ? { ...settings } : {}
  const envRaw = next.env
  const env: Record<string, string> = isRecord(envRaw)
    ? Object.fromEntries(
        Object.entries(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: envRaw passed isRecord() above; the cast widens unknown → Record<string, unknown> for the entries() iterator only.
          envRaw as Record<string, unknown>
        ).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      )
    : {}
  // Always start by scrubbing any Orca-injected keys.
  delete env.ANTHROPIC_BASE_URL
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.ANTHROPIC_API_KEY
  if (provider !== null) {
    env.ANTHROPIC_BASE_URL = provider.claudeBaseUrl
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      // Inline the literal token; ClaudeCode will read it verbatim from settings.json.
      env.ANTHROPIC_AUTH_TOKEN = apiKey
    }
  }
  next.env = env
  return next
}

/** Read the active provider id from a parsed settings object by looking at
 *  env.ANTHROPIC_BASE_URL. Matches against the supplied registry so custom
 *  providers (with their own claudeBaseUrl) also resolve to their id. */
export function readActiveClaudeProvider(
  settings: unknown,
  knownProviders: readonly ProviderPresetDefinition[]
): string | null {
  if (!isRecord(settings) || !isRecord(settings.env)) {
    return null
  }
  const baseUrl = settings.env.ANTHROPIC_BASE_URL
  if (typeof baseUrl !== 'string') {
    return null
  }
  for (const provider of knownProviders) {
    if (provider.claudeBaseUrl === baseUrl) {
      return provider.id
    }
  }
  return null
}

/** Apply or remove the provider preset on disk.
 *  @param options.apiKey  optional inline bearer token. When provided, written as a
 *                         literal string into settings.json's env.ANTHROPIC_AUTH_TOKEN.
 *                         When omitted (or null), ANTHROPIC_AUTH_TOKEN is left absent
 *                         so the user's shell env or ANTHROPIC_API_KEY remains in effect.
 */
export function applyClaudeProvider(
  provider: ProviderPresetDefinition | null,
  options?: { configDirName?: string; apiKey?: string | null }
): ClaudeApplyResult {
  const configDir = resolveClaudeConfigDir(options?.configDirName ?? '.claude')
  const configPath = join(configDir, 'settings.json')
  try {
    mkdirSync(configDir, { recursive: true })
    let current: unknown = {}
    if (existsSync(configPath)) {
      try {
        current = JSON.parse(readFileSync(configPath, 'utf-8'))
      } catch {
        current = {}
      }
    }
    const next = applyProviderToClaudeSettings(current, provider, options?.apiKey ?? null)
    writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
    return {
      agentId: 'claude',
      configPath,
      providerId: provider?.id ?? null,
      error: null
    }
  } catch (error) {
    return {
      agentId: 'claude',
      configPath,
      providerId: provider?.id ?? null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function readActiveClaudeProviderFromDisk(
  knownProviders: readonly ProviderPresetDefinition[],
  options?: { configDirName?: string }
): { providerId: string | null; configPath: string } {
  const configDir = resolveClaudeConfigDir(options?.configDirName ?? '.claude')
  const configPath = join(configDir, 'settings.json')
  if (!existsSync(configPath)) {
    return { providerId: null, configPath }
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
    return { providerId: readActiveClaudeProvider(parsed, knownProviders), configPath }
  } catch {
    return { providerId: null, configPath }
  }
}

// --- v3 thin wrappers retained for backward-compatibility with any caller that
// still imports the old symbol names (existing tests). The renderer + IPC are
// migrated to the new generic functions in this same change. ---

export function applyKaixuanToClaudeSettings(
  settings: unknown,
  presetId: KaixuanPresetId | null,
  apiKey?: string | null
): Record<string, unknown> {
  const provider = presetId === null ? null : KAIXUAN_PRESETS[presetId]
  return applyProviderToClaudeSettings(settings, provider, apiKey)
}

export function readActiveClaudeKaixuanPreset(settings: unknown): KaixuanPresetId | null {
  // Built-in-only fallback: only kaixuan ids are recognised here, since the
  // v3 callers do not pass a registry. Renderer-side reads use the new
  // readActiveClaudeProvider with the full registry.
  if (!isRecord(settings) || !isRecord(settings.env)) {
    return null
  }
  const baseUrl = settings.env.ANTHROPIC_BASE_URL
  if (typeof baseUrl !== 'string') {
    return null
  }
  for (const id of Object.keys(KAIXUAN_PRESETS) as KaixuanPresetId[]) { // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Object.keys returns string[]; the cast narrows to the KaixuanPresetId union for the iteration only.
    if (KAIXUAN_PRESETS[id].claudeBaseUrl === baseUrl) {
      return id
    }
  }
  return null
}

export function applyClaudeKaixuanPreset(
  presetId: KaixuanPresetId | null,
  options?: { configDirName?: string; apiKey?: string | null }
): ClaudeApplyResult {
  const provider = presetId === null ? null : KAIXUAN_PRESETS[presetId]
  return applyClaudeProvider(provider, options)
}

export function readActiveClaudeKaixuanPresetFromDisk(options?: { configDirName?: string }): {
  providerId: string | null
  configPath: string
} {
  const builtInList = Object.values(KAIXUAN_PRESETS)
  return readActiveClaudeProviderFromDisk(builtInList, options)
}
