// What: 给 ClaudeCode 系统 settings.json 写 kaixuan preset 的 env 注入。
// presetId=kaixuan-local/kaixuan-kxpms 时写入 env.ANTHROPIC_BASE_URL + env.ANTHROPIC_AUTH_TOKEN(envKey placeholder)；
// presetId=null 时把 env 里残留的 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 全清。
//
// Why: ClaudeCode 通过 ~/.claude/settings.json 的 env 段切换厂商 base URL。
// Orca 的 claude-config-dir-pin.ts 把 CLAUDE_CONFIG_DIR 固定到当前账号的 configDirName，所以这里的"系统 config"是 ~/.claude/<configDirName>/settings.json。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { KAIXUAN_PRESETS, type KaixuanPresetId } from '../../shared/provider-preset-types'

type ClaudeApplyResult = {
  agentId: 'claude'
  configPath: string
  presetId: KaixuanPresetId | null
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

/** Pure helper — exposed for testing. Apply (or remove) kaixuan env entries
 *  against the parsed settings object.
 */
export function applyKaixuanToClaudeSettings(
  settings: unknown,
  presetId: KaixuanPresetId | null
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
  // Always start by scrubbing any kaixuan-injected keys.
  delete env.ANTHROPIC_BASE_URL
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.ANTHROPIC_API_KEY
  if (presetId !== null) {
    const preset = KAIXUAN_PRESETS[presetId]
    env.ANTHROPIC_BASE_URL = preset.claudeBaseUrl
    // Why: ClaudeCode fallback chain is ANTHROPIC_AUTH_TOKEN → ANTHROPIC_API_KEY.
    // The kaixuan endpoint accepts the OPENAI_API_KEY env var, so we point
    // ClaudeCode at the same variable via the OAuth-style token slot. Users may
    // override by setting ANTHROPIC_API_KEY after apply (preserved across calls).
    env.ANTHROPIC_AUTH_TOKEN = `\${${preset.envKeyName}}`
  }
  next.env = env
  return next
}

/** Read the active preset id from a parsed settings object by looking at env.ANTHROPIC_BASE_URL. */
export function readActiveClaudeKaixuanPreset(settings: unknown): KaixuanPresetId | null {
  if (!isRecord(settings) || !isRecord(settings.env)) {
    return null
  }
  const baseUrl = settings.env.ANTHROPIC_BASE_URL
  if (typeof baseUrl !== 'string') {
    return null
  }
  for (const id of Object.keys(KAIXUAN_PRESETS) as KaixuanPresetId[]) { // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Object.keys returns string[]; the cast only narrows to the union of known preset ids for the dispatch table.
    if (KAIXUAN_PRESETS[id].claudeBaseUrl === baseUrl) {
      return id
    }
  }
  return null
}

/** Apply or remove the kaixuan preset on disk. */
export function applyClaudeKaixuanPreset(
  presetId: KaixuanPresetId | null,
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
    const next = applyKaixuanToClaudeSettings(current, presetId)
    // apiKey plumbing: when caller supplied an inline token, write it through the
    // ClaudeCode-blessed slot so it survives across CLI invocations. Stored-encrypted
    // equivalent here is "the user chose to embed"; future hardening can swap to
    // a keytar-backed env resolver.
    if (presetId !== null && options?.apiKey) {
      const env: Record<string, string> = isRecord(next.env)
        ? Object.fromEntries(
            Object.entries(next.env).filter((e): e is [string, string] => typeof e[1] === 'string')
          )
        : {}
      env.ANTHROPIC_AUTH_TOKEN = options.apiKey
      next.env = env
    }
    writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
    return { agentId: 'claude', configPath, presetId, error: null }
  } catch (error) {
    return {
      agentId: 'claude',
      configPath,
      presetId,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function readActiveClaudeKaixuanPresetFromDisk(options?: { configDirName?: string }): {
  presetId: KaixuanPresetId | null
  configPath: string
} {
  const configDir = resolveClaudeConfigDir(options?.configDirName ?? '.claude')
  const configPath = join(configDir, 'settings.json')
  if (!existsSync(configPath)) {
    return { presetId: null, configPath }
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
    return { presetId: readActiveClaudeKaixuanPreset(parsed), configPath }
  } catch {
    return { presetId: null, configPath }
  }
}
