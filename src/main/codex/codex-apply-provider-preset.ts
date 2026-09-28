// What: 给 Codex 系统 config.toml 写 provider preset：内置 kaixuan 两个端点 +
// 用户通过 AccountsPane 注册表新增的任意 OpenAI 兼容厂商。写入顶层
// `model_provider = "<id>"` + `[model_providers.<id>]` 表，重复 apply 幂等。
// provider=null 时清掉所有已知 provider 痕迹，让 Codex 回到系统默认。
//
// Why: Codex CLI 走 ~/.codex/config.toml 的 [model_providers.X] + 顶层
// model_provider = "X" 切换 provider。Orca 现有架构是单向镜像（system → runtime），
// 所以这里直接写 system config，下次 codex-config-mirror 自动把改动同步到
// managed runtime home，Codex worker 自然可用。
//
// Why `requires_openai_auth = false`: the kaixuan gateway authenticates with its
// own bearer token, NOT with OpenAI/ChatGPT OAuth. Setting this to true tells
// Codex to authenticate the provider through the OpenAI auth flow, which — on a
// host whose `~/.codex/auth.json` carries `auth_mode: "chatgpt"` — routes the
// request with a ChatGPT token that has no scope for the gateway and fails 401
// (`Missing scopes: api.responses.write`). The user's own proven-working
// `[model_providers.custom]` table uses `requires_openai_auth = false`.
//
// `env_key` alone is only honoured when the named variable is exported in the
// shell that spawns the codex worker; when the caller passes an explicit key we
// additionally emit `experimental_bearer_token`, the documented field for a
// direct bearer token (see Codex "Configuration Reference — model_providers").
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getSystemCodexHomePath } from './codex-home-paths'
import { getTomlSections, type TomlSection } from './config-toml-runtime-owned-sections'
import { joinPreservingTrailingNewline } from './config-toml-line-scan'
import type { KaixuanPresetId, ProviderPresetDefinition } from '../../shared/provider-preset-types'
import { KAIXUAN_PRESETS } from '../../shared/provider-preset-types'

type CodexApplyResult = {
  agentId: 'codex'
  configPath: string
  providerId: string | null
  error: string | null
}

function joinTomlBlocks(blocks: string[]): string {
  return blocks.filter((block) => block.length > 0).join('\n')
}

/** Render the `[model_providers.<id>]` table header with the id QUOTED.
 *
 *  Why quoted: an unquoted bare key cannot contain a `.`, so a dotted id — the
 *  v4 UI's own suggested example is `glm-5.2` — is parsed by TOML as a nested
 *  table (`model_providers.glm` → `2`). Codex then has no `model_providers`
 *  entry for the id the top-level `model_provider` names and cannot resolve the
 *  provider at all, even though the config parses without error. TOML 1.0
 *  allows quoted keys, so quoting makes every registry id land as one flat key.
 *  The strip regex must therefore also accept the unquoted spelling, because
 *  configs written by earlier Orca versions (and by hand) are still on disk. */
function renderModelProvidersHeader(id: string): string {
  return `[model_providers."${escapeTomlBasicString(id)}"]`
}

/** Render `[model_providers.<id>]` table content for the given provider.
 *
 *  @param apiKey  when present, the caller's literal bearer token is written as
 *                 `experimental_bearer_token` and `env_key` is OMITTED.
 */
function renderProviderTable(provider: ProviderPresetDefinition, apiKey?: string | null): string {
  const lines = [
    renderModelProvidersHeader(provider.modelProviderName),
    `name = "${escapeTomlBasicString(provider.codexProviderName)}"`,
    `base_url = "${escapeTomlBasicString(provider.codexBaseUrl)}"`
  ]
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    // Why the inline token replaces env_key instead of joining it: codex resolves
    // `env_key` FIRST and hard-fails before it ever looks at
    // `experimental_bearer_token`. Verified against codex-cli 0.158.0 on
    // 2026-09-28 against the live gateway: a table carrying both fields aborts
    // with "ERROR: Missing environment variable: `OPENAI_API_KEY`", while the
    // same table with only `experimental_bearer_token` completes the call. The
    // two are mutually exclusive in practice, so emitting both silently
    // discards the key the user just typed in.
    lines.push(`experimental_bearer_token = "${escapeTomlBasicString(apiKey)}"`)
  } else {
    // No inline token: fall back to the env-var indirection, which only resolves
    // when the shell that spawns the codex worker exports it.
    lines.push(`env_key = "${provider.envKeyName}"`)
  }
  lines.push('wire_api = "responses"', 'requires_openai_auth = false')
  return lines.join('\n')
}

/**
 * Build the regex that matches a `model_provider` line for any provider in
 * the registry. Used by stripRegistryArtifacts so a switch flips cleanly
 * across built-in + custom providers, leaving unrelated top-level entries
 * (e.g. user-owned `[model_providers.foo]`) untouched.
 */
function buildModelProviderLineRegex(knownIds: ReadonlySet<string>): RegExp {
  if (knownIds.size === 0) {
    // Match nothing (unreachable path — getCurrent callers always pass at least
    // built-in ids). Returning a never-matches pattern keeps the strip function
    // safe if a future caller forgets to populate the registry.
    return /^a^/u
  }
  const ids = [...knownIds].map((id) => escapeRegex(id)).join('|')
  return new RegExp(`^['"]?model_provider['"]?\\s*=\\s*['"](${ids})['"]`)
}

/** Build the regex that matches `[model_providers.<id>]` table headers.
 *
 *  Accepts the quoted spelling this module now writes AND the unquoted one that
 *  earlier versions (and hand-written configs) left on disk, so switching
 *  providers still removes the previous table instead of leaving a stale one. */
function buildModelProviderSectionRegex(knownIds: ReadonlySet<string>): RegExp {
  if (knownIds.size === 0) {
    return /^a^/u
  }
  const ids = [...knownIds].map((id) => escapeRegex(id)).join('|')
  return new RegExp(`^\\[model_providers\\.(?:"(?:${ids})"|'(?:${ids})'|${ids})\\]$`)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Drop top-level `model_provider = "<known-id>"` lines and any
 * `[model_providers.<known-id>]` table sections, leaving all other content
 * untouched. Returns the rewritten config string.
 *
 * Why: idempotency — repeated applies must not duplicate blocks; the previous
 * provider's table stays removed so Codex's `model_provider` flips cleanly.
 * The set of "known ids" is the union of built-in + custom providers so the
 * same code clears any provider Orca might have written previously.
 */
function stripRegistryArtifacts(config: string, knownIds: ReadonlySet<string>): string {
  const lineRe = buildModelProviderLineRegex(knownIds)
  const sectionRe = buildModelProviderSectionRegex(knownIds)

  const strippedTopLevel = config
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('model_provider')) {
        return true
      }
      return !lineRe.test(trimmed)
    })
    .join('\n')

  // Filter out known provider sections while preserving preamble.
  const sections = getTomlSections(strippedTopLevel)
  const filteredSections: TomlSection[] = sections.filter(
    (section) => !sectionRe.test(section.header.trim())
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
 * Pure helper: return the rewritten config string for the given provider.
 * Exported for unit tests; production callers should use `applyCodexProvider`.
 *
 * `knownIds` is the union of built-in + custom provider ids. It controls which
 * `[model_providers.<id>]` tables get stripped before the new one is appended.
 */
export function renderCodexConfigForProvider(
  currentConfig: string,
  provider: ProviderPresetDefinition | null,
  knownIds: ReadonlySet<string>,
  apiKey?: string | null
): string {
  const cleaned = stripRegistryArtifacts(currentConfig, knownIds)
  if (provider === null) {
    return joinPreservingTrailingNewline(cleaned.split('\n'), cleaned.includes('\r\n'))
  }
  const tableBlock = renderProviderTable(provider, apiKey)
  const withTopLevel = `${cleaned.replace(/(\r?\n)*$/, '')}\nmodel_provider = "${provider.modelProviderName}"\n`
  return joinPreservingTrailingNewline(
    `${withTopLevel}\n${tableBlock}\n`.split('\n'),
    withTopLevel.includes('\r\n')
  )
}

/**
 * Read the active provider id from system Codex config.toml by scanning
 * the top-level `model_provider = "<id>"` line. Returns null if no known
 * provider is active.
 *
 * Why pass `knownIds` rather than hard-coding kaixuan ids: the registry is
 * now user-extensible; the read path needs the same union of built-in +
 * custom ids that the write path uses, so a custom preset written earlier
 * still reads back as itself.
 */
export function readActiveCodexProvider(
  configContent: string,
  knownIds: ReadonlySet<string>
): string | null {
  if (knownIds.size === 0) {
    return null
  }
  const ids = [...knownIds].map((id) => escapeRegex(id)).join('|')
  const match = configContent.match(
    new RegExp(`^['"]?model_provider['"]?\\s*=\\s*['"](${ids})['"]`, 'm')
  )
  return match ? (match[1] ?? null) : null
}

/**
 * Apply (or remove) a provider preset to the system Codex config. Atomic write:
 * if the rewrite throws, the existing file is untouched.
 *
 * `knownIds` should include all built-in + custom provider ids so the rewrite
 * step can strip every Orca-owned `[model_providers.<id>]` table — including
 * ones written by a previous (different) provider — without touching user-owned
 * provider entries.
 */
export function applyCodexProvider(
  provider: ProviderPresetDefinition | null,
  knownIds: ReadonlySet<string>,
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
    // The token is rendered by renderProviderTable rather than patched in
    // afterwards, so `env_key` and `experimental_bearer_token` are never emitted
    // together — codex resolves env_key first and aborts on the missing variable
    // before it can use the inline token (see renderProviderTable).
    const next = renderCodexConfigForProvider(current, provider, knownIds, options?.apiKey ?? null)
    if (current === next) {
      return {
        agentId: 'codex',
        configPath,
        providerId: provider?.id ?? null,
        error: null
      }
    }
    writeFileSync(configPath, next, 'utf-8')
    return {
      agentId: 'codex',
      configPath,
      providerId: provider?.id ?? null,
      error: null
    }
  } catch (error) {
    return {
      agentId: 'codex',
      configPath,
      providerId: provider?.id ?? null,
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

// Why: keep the v3-era entry points as thin wrappers around the new generic
// functions so anything that still imports the old symbols (existing tests,
// external callers) compiles. Renderer and IPC are migrated in this same
// change to the new shape; these wrappers exist for downstream type-checking.
export function applyCodexKaixuanPreset(
  presetId: KaixuanPresetId | null,
  options?: { apiKey?: string | null }
): CodexApplyResult {
  const provider = presetId === null ? null : KAIXUAN_PRESETS[presetId]
  return applyCodexProvider(provider, BUILT_IN_PROVIDER_IDS_FALLBACK, options)
}

export function readActiveCodexKaixuanPreset(configContent: string): string | null {
  return readActiveCodexProvider(configContent, BUILT_IN_PROVIDER_IDS_FALLBACK)
}

const BUILT_IN_PROVIDER_IDS_FALLBACK = new Set<string>(['kaixuan-local', 'kaixuan-kxpms'])
