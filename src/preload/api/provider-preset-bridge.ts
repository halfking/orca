import { ipcRenderer } from 'electron'
import type {
  KaixuanPresetId,
  ProviderPresetAgentId,
  ProviderPresetApplyResult
} from '../../shared/provider-preset-types'
import type { PreloadApi } from '../api-types'

export const providerPresetsApi = {
  applyCodex: (args: {
    presetId: KaixuanPresetId | null
    apiKey?: string | null
  }): Promise<ProviderPresetApplyResult> => ipcRenderer.invoke('providerPresets:applyCodex', args),
  applyClaude: (args: {
    presetId: KaixuanPresetId | null
    apiKey?: string | null
    configDirName?: string
  }): Promise<ProviderPresetApplyResult> => ipcRenderer.invoke('providerPresets:applyClaude', args),
  applyOpenCode: (args: {
    presetId: KaixuanPresetId | null
    apiKey?: string | null
  }): Promise<ProviderPresetApplyResult> =>
    ipcRenderer.invoke('providerPresets:applyOpenCode', args),
  getCurrent: (args: {
    agentId: ProviderPresetAgentId
  }): Promise<{ presetId: KaixuanPresetId | null; configPath: string }> =>
    ipcRenderer.invoke('providerPresets:getCurrent', args)
} satisfies PreloadApi['providerPresets']
