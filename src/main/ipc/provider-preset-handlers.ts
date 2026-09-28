// What: IPC handler，把 renderer 端的 "Apply kaixuan preset" 调用路由到对应 agent 的 apply 函数。
// 三组 apiChannel：providerPresets:applyCodex / applyClaude / applyOpenCode / getCurrent。
//
// Why: 见 src/shared/provider-preset-types.ts 头部注释。
// preload 在 src/preload/api/provider-preset-api.ts 暴露给 renderer 为 window.api.providerPresets.*。
import { ipcMain } from 'electron'
import {
  KAIXUAN_PRESETS,
  type KaixuanPresetId,
  type ProviderPresetAgentId,
  type ProviderPresetApplyResult
} from '../../shared/provider-preset-types'
import {
  applyCodexKaixuanPreset,
  readActiveCodexKaixuanPreset
} from '../codex/codex-apply-provider-preset'
import {
  applyClaudeKaixuanPreset,
  readActiveClaudeKaixuanPresetFromDisk
} from '../claude/claude-apply-provider-preset'
import {
  applyOpenCodeKaixuanPreset,
  readActiveOpenCodeKaixuanPresetFromDisk
} from '../opencode/opencode-apply-provider-preset'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'

function asPresetId(value: unknown): KaixuanPresetId | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== 'string') {
    throw new Error(`presetId must be a string or null, got ${typeof value}`)
  }
  if (Object.hasOwn(KAIXUAN_PRESETS, value)) {
    return value
  }
  throw new Error(`unknown presetId: ${value}`)
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

function asStringOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    return undefined
  }
  return value
}

function asAgentId(value: unknown): ProviderPresetAgentId {
  if (value === 'codex' || value === 'claude' || value === 'opencode') {
    return value
  }
  throw new Error(`unknown agentId: ${String(value)}`)
}

export function registerProviderPresetHandlers(): void {
  ipcMain.handle(
    'providerPresets:applyCodex',
    (_event, args: { presetId?: unknown; apiKey?: unknown }): ProviderPresetApplyResult => {
      const presetId = asPresetId(args?.presetId)
      const apiKey = asStringOrNull(args?.apiKey)
      const result = applyCodexKaixuanPreset(presetId, apiKey === undefined ? {} : { apiKey })
      return result
    }
  )

  ipcMain.handle(
    'providerPresets:applyClaude',
    (
      _event,
      args: { presetId?: unknown; apiKey?: unknown; configDirName?: unknown }
    ): ProviderPresetApplyResult => {
      const presetId = asPresetId(args?.presetId)
      const apiKey = asStringOrNull(args?.apiKey)
      const configDirName = asStringOrUndefined(args?.configDirName)
      const result = applyClaudeKaixuanPreset(
        presetId,
        apiKey === undefined && configDirName === undefined
          ? {}
          : { apiKey: apiKey ?? null, configDirName }
      )
      return result
    }
  )

  ipcMain.handle(
    'providerPresets:applyOpenCode',
    (_event, args: { presetId?: unknown; apiKey?: unknown }): ProviderPresetApplyResult => {
      const presetId = asPresetId(args?.presetId)
      const apiKey = asStringOrNull(args?.apiKey)
      const result = applyOpenCodeKaixuanPreset(presetId, apiKey === undefined ? {} : { apiKey })
      return result
    }
  )

  ipcMain.handle(
    'providerPresets:getCurrent',
    (
      _event,
      args: { agentId?: unknown }
    ): {
      presetId: KaixuanPresetId | null
      configPath: string
    } => {
      const agentId = asAgentId(args?.agentId)
      if (agentId === 'codex') {
        const configPath = join(getSystemCodexHomePath(), 'config.toml')
        if (!existsSync(configPath)) {
          return { presetId: null, configPath }
        }
        try {
          const content = readFileSync(configPath, 'utf-8')
          return { presetId: readActiveCodexKaixuanPreset(content), configPath }
        } catch {
          return { presetId: null, configPath }
        }
      }
      if (agentId === 'claude') {
        return readActiveClaudeKaixuanPresetFromDisk()
      }
      return readActiveOpenCodeKaixuanPresetFromDisk()
    }
  )
}
