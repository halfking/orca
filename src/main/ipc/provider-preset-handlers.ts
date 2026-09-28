// What: IPC handler，把 renderer 端的 "Apply provider preset" 调用路由到对应 agent 的
// apply 函数。四组 apiChannel：providerPresets:applyCodex / applyClaude /
// applyOpenCode / getCurrent。
//
// Why: 见 src/shared/provider-preset-types.ts 头部注释。preload 在
// src/preload/api/provider-preset-api.ts 暴露给 renderer 为 window.api.providerPresets.*。
//
// v4 wiring: apply handlers take a full `provider: ProviderPresetDefinition | null`
// (the renderer resolves built-in + custom ids to definitions), and getCurrent
// takes `knownProviders` so the read path can match against the same registry
// the user sees in the UI. The knownProviders list is renderer-owned; the main
// process treats it as untrusted input (size-capped) and never re-emits ids
// that are not in it.
import { ipcMain } from 'electron'
import type {
  ProviderPresetAgentId,
  ProviderPresetApplyResult,
  ProviderPresetDefinition
} from '../../shared/provider-preset-types'
import { applyCodexProvider, readActiveCodexProvider } from '../codex/codex-apply-provider-preset'
import {
  applyClaudeProvider,
  readActiveClaudeProviderFromDisk
} from '../claude/claude-apply-provider-preset'
import {
  applyOpenCodeProvider,
  readActiveOpenCodeProviderFromDisk
} from '../opencode/opencode-apply-provider-preset'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { BUILT_IN_PROVIDER_IDS } from '../../shared/provider-preset-types'

// Why: defense in depth — renderer is treated as untrusted; cap the registry
// size so a malicious or buggy renderer can't make us parse megabytes of
// provider definitions per IPC call. 100 is enough for any realistic org
// catalogue of OpenAI-compatible providers.
const MAX_KNOWN_PROVIDERS = 100

function asKnownProviders(value: unknown): readonly ProviderPresetDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error('knownProviders must be an array')
  }
  if (value.length > MAX_KNOWN_PROVIDERS) {
    throw new Error(`knownProviders has ${value.length} entries; max is ${MAX_KNOWN_PROVIDERS}`)
  }
  const result: ProviderPresetDefinition[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('knownProviders entries must be objects')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: entry is `object` per the guard above; the cast widens unknown → ProviderPresetDefinition for downstream field access. Renderer is untrusted, and we re-validate required fields below.
    const provider = entry as ProviderPresetDefinition
    if (typeof provider.id !== 'string' || provider.id.length === 0) {
      throw new Error('knownProviders entry missing id')
    }
    result.push(provider)
  }
  return result
}

function asProviderOrNull(value: unknown): ProviderPresetDefinition | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== 'object') {
    throw new Error('provider must be an object or null')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: value is `object` per the guard above; the cast widens unknown → ProviderPresetDefinition for downstream field access. Renderer is untrusted, and we re-validate `id` below.
  const provider = value as ProviderPresetDefinition
  if (typeof provider.id !== 'string' || provider.id.length === 0) {
    throw new Error('provider missing id')
  }
  return provider
}

function asStringOrNull(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new Error('apiKey must be a string or null')
  }
  return value
}

function asAgentId(value: unknown): ProviderPresetAgentId {
  if (value === 'codex' || value === 'claude' || value === 'opencode') {
    return value
  }
  throw new Error(`unknown agentId: ${String(value)}`)
}

/** Build the set of provider ids the apply / read functions should treat as
 *  Orca-owned when stripping the user's system config. Always includes the
 *  built-ins; the renderer-supplied knownProviders contribute their custom ids. */
function buildKnownIds(rendererKnown: readonly ProviderPresetDefinition[]): ReadonlySet<string> {
  const ids = new Set<string>(BUILT_IN_PROVIDER_IDS)
  for (const provider of rendererKnown) {
    ids.add(provider.id)
  }
  return ids
}

export function registerProviderPresetHandlers(): void {
  ipcMain.handle(
    'providerPresets:applyCodex',
    (
      _event,
      args: {
        provider?: unknown
        apiKey?: unknown
        knownProviders?: unknown
      }
    ): ProviderPresetApplyResult => {
      const provider = asProviderOrNull(args?.provider)
      const apiKey = asStringOrNull(args?.apiKey)
      const knownProviders = asKnownProviders(args?.knownProviders ?? [])
      const knownIds = buildKnownIds(knownProviders)
      const result = applyCodexProvider(provider, knownIds, apiKey === undefined ? {} : { apiKey })
      return result
    }
  )

  ipcMain.handle(
    'providerPresets:applyClaude',
    (
      _event,
      args: {
        provider?: unknown
        apiKey?: unknown
        configDirName?: unknown
      }
    ): ProviderPresetApplyResult => {
      const provider = asProviderOrNull(args?.provider)
      const apiKey = asStringOrNull(args?.apiKey)
      const configDirName = typeof args?.configDirName === 'string' ? args.configDirName : undefined
      const options: { apiKey?: string | null; configDirName?: string } = {}
      if (apiKey !== undefined) {
        options.apiKey = apiKey
      }
      if (configDirName !== undefined) {
        options.configDirName = configDirName
      }
      const result = applyClaudeProvider(provider, options)
      return result
    }
  )

  ipcMain.handle(
    'providerPresets:applyOpenCode',
    (
      _event,
      args: {
        provider?: unknown
        apiKey?: unknown
        knownProviders?: unknown
      }
    ): ProviderPresetApplyResult => {
      const provider = asProviderOrNull(args?.provider)
      const apiKey = asStringOrNull(args?.apiKey)
      const knownProviders = asKnownProviders(args?.knownProviders ?? [])
      const knownIds = buildKnownIds(knownProviders)
      const result = applyOpenCodeProvider(
        provider,
        knownIds,
        apiKey === undefined ? {} : { apiKey }
      )
      return result
    }
  )

  ipcMain.handle(
    'providerPresets:getCurrent',
    (
      _event,
      args: {
        agentId?: unknown
        knownProviders?: unknown
      }
    ): { providerId: string | null; configPath: string } => {
      const agentId = asAgentId(args?.agentId)
      const knownProviders = asKnownProviders(args?.knownProviders ?? [])
      if (agentId === 'codex') {
        const configPath = join(getSystemCodexHomePath(), 'config.toml')
        if (!existsSync(configPath)) {
          return { providerId: null, configPath }
        }
        try {
          const content = readFileSync(configPath, 'utf-8')
          const knownIds = buildKnownIds(knownProviders)
          return {
            providerId: readActiveCodexProvider(content, knownIds),
            configPath
          }
        } catch {
          return { providerId: null, configPath }
        }
      }
      if (agentId === 'claude') {
        return readActiveClaudeProviderFromDisk(knownProviders)
      }
      return readActiveOpenCodeProviderFromDisk(knownProviders)
    }
  )
}

// Why expose: tests that need to assert the registry helper against arbitrary
// renderer input. Not part of the public IPC surface.
export { buildKnownIds, asKnownProviders, MAX_KNOWN_PROVIDERS }
