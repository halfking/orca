// What: 给 Codex 系统 config.toml 写两个 kaixuan preset：kaixuan-local / kaixuan-kxpms。
// 写入顶层 `model_provider = "<id>"` + `[model_providers.<id>]` 表，重复 apply 是幂等的（删旧 + 写新）。
// presetId 为 null 时清掉所有 kaixuan 痕迹，让 Codex 回到系统默认。
//
// Why: Codex CLI 走 ~/.codex/config.toml 的 [model_providers.X] + 顶层 model_provider = "X" 切换 provider。
// Orca 现有架构是单向镜像（system → runtime），所以这里直接写 system config，
// 下次 codex-config-mirror 自动把改动同步到 managed runtime home，Codex worker 自然可用。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getSystemCodexHomePath } from './codex-home-paths'
import { getTomlSections, type TomlSection } from './config-toml-runtime-owned-sections'
import { joinPreservingTrailingNewline } from './config-toml-line-scan'
import {
  KAIXUAN_PRESETS,
  type KaixuanPresetDefinition,
  type KaixuanPresetId
} from '../../shared/provider-preset-types'

type CodexApplyResult = {
  agentId: 'codex'
  configPath: string
  presetId: KaixuanPresetId | null
  error: string | null
}

function joinTomlBlocks(blocks: string[]): string {
  return blocks.filter((block) => block.length > 0).join('\n')
}

/** Render `[model_providers.<id>]` table content for the given preset.
 *
 *  Why `requires_openai_auth = false`: the kaixuan gateway authenticates with its
 *  own bearer token, NOT with OpenAI/ChatGPT OAuth. Setting this to true tells
 *  Codex to authenticate the provider through the OpenAI auth flow, which — on a
 *  host whose `~/.codex/auth.json` carries `auth_mode: "chatgpt"` — routes the
 *  request with a ChatGPT token that has no scope for the gateway and fails 401
 *  (`Missing scopes: api.responses.write`). The user's own proven-working
 *  `[model_providers.custom]` table uses `requires_openai_auth = false`.
 *
 *  `env_key` alone is only honoured when the named variable is exported in the
 *  shell that spawns the codex worker; when the caller passes an explicit key we
 *  additionally emit `experimental_bearer_token`, the documented field for a
 *  direct bearer token (see Codex "Configuration Reference — model_providers").
 */
function renderProviderTable(preset: KaixuanPresetDefinition): string {
  const lines = [
    `[model_providers.${preset.modelProviderName}]`,
    `name = "${preset.codexProviderName}"`,
    `base_url = "${preset.codexBaseUrl}"`,
    `env_key = "${preset.envKeyName}"`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`
  ]
  return lines.join('\n')
}

/**
 * Drop top-level `model_provider = "<kaixuan-id>"` lines and any
 * `[model_providers.kaixuan-...]` table sections, leaving all other content
 * untouched. Returns the rewritten config string.
 *
 * Why: idempotency — repeated applies must not duplicate blocks; the previous
 * preset's table stays removed so Codex's `model_provider` flips cleanly.
 */
function stripKaixuanArtifacts(config: string): string {
  const strippedTopLevel = config
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('model_provider')) {
        return true
      }
      // Match `model_provider = "kaixuan-local"` / `model_provider = 'kaixuan-kxpms'`
      // (with optional whitespace, with optional quoted key variant).
      return !/^['"]?model_provider['"]?\s*=\s*['"](kaixuan-(local|kxpms))['"]/.test(trimmed)
    })
    .join('\n')

  // Filter out kaixuan provider sections while preserving preamble.
  const sections = getTomlSections(strippedTopLevel)
  const filteredSections: TomlSection[] = sections.filter(
    (section) => !/^\[model_providers\.kaixuan-(local|kxpms)\]$/.test(section.header.trim())
  )
  if (filteredSections.length === sections.length) {
    return strippedTopLevel
  }
  const preamble = (() => {
    const firstSectionStart = sections[0]?.start ?? -1
    if (firstSectionStart === -1) {
      return strippedTopLevel
    }
    const lines = strippedTopLevel.split('\n')
    return lines.slice(0, firstSectionStart).join('\n')
  })()
  return joinTomlBlocks([preamble, ...filteredSections.map((section) => section.block)])
}

/**
 * Pure helper: return the rewritten config string for the given preset.
 * Exported for unit tests; production callers should use `applyCodexKaixuanPreset`.
 */
export function renderCodexConfigForPreset(
  currentConfig: string,
  presetId: KaixuanPresetId | null
): string {
  const cleaned = stripKaixuanArtifacts(currentConfig)
  if (presetId === null) {
    return joinPreservingTrailingNewline(cleaned.split('\n'), cleaned.includes('\r\n'))
  }
  const preset = KAIXUAN_PRESETS[presetId]
  const tableBlock = renderProviderTable(preset)
  const withTopLevel = `${cleaned.replace(/(\r?\n)*$/, '')}\nmodel_provider = "${preset.modelProviderName}"\n`
  return joinPreservingTrailingNewline(
    `${withTopLevel}\n${tableBlock}\n`.split('\n'),
    withTopLevel.includes('\r\n')
  )
}

/**
 * Read the active kaixuan preset id from system Codex config.toml by scanning
 * the top-level `model_provider = "kaixuan-..."` line. Returns null if neither
 * preset is active.
 */
export function readActiveCodexKaixuanPreset(configContent: string): KaixuanPresetId | null {
  const match = configContent.match(
    /^['"]?model_provider['"]?\s*=\s*['"](kaixuan-(local|kxpms))['"]/m
  )
  if (!match) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the regex's inner group is hard-coded to `kaixuan-(local|kxpms)`, which the union type covers.
  return match[1] as KaixuanPresetId
}

/**
 * Apply (or remove) a kaixuan preset to the system Codex config. Atomic write:
 * if the rewrite throws, the existing file is untouched.
 */
export function applyCodexKaixuanPreset(
  presetId: KaixuanPresetId | null,
  options?: { apiKey?: string | null }
): CodexApplyResult {
  const configPath = join(getSystemCodexHomePath(), 'config.toml')
  try {
    mkdirSync(dirname(configPath), { recursive: true })
    let current = ''
    try {
      current = readFileSync(configPath, 'utf-8')
    } catch {
      current = ''
    }
    const next = renderCodexConfigForPreset(current, presetId)
    if (current === next) {
      return { agentId: 'codex', configPath, presetId, error: null }
    }
    // apiKey plumbing: when the caller supplied an explicit token, embed it as
    // `experimental_bearer_token` — the Codex-documented field for a direct
    // bearer token. The previous shape wrote `api_key = "..."`, which is NOT a
    // field in the Codex `[model_providers.<id>]` schema at all, so the token was
    // silently dropped and codex fell back to env_key alone (see Codex
    // "Configuration Reference — model_providers.<id>").
    const withEnvOverride =
      options?.apiKey && presetId !== null
        ? next.replace(
            new RegExp(`(env_key = "${KAIXUAN_PRESETS[presetId].envKeyName}")`),
            `$1\nexperimental_bearer_token = "${escapeTomlBasicString(options.apiKey)}"`
          )
        : next
    writeFileSync(configPath, withEnvOverride, 'utf-8')
    return { agentId: 'codex', configPath, presetId, error: null }
  } catch (error) {
    return {
      agentId: 'codex',
      configPath,
      presetId,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function escapeTomlBasicString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
}
