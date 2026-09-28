import { ipcRenderer } from 'electron'
import type {
  ProviderPresetAgentId,
  ProviderPresetApplyResult,
  ProviderPresetDefinition
} from '../../shared/provider-preset-types'
import type { PreloadApi } from '../api-types'

export const providerPresetsApi = {
  applyCodex: (args: {
    provider: ProviderPresetDefinition | null
    apiKey?: string | null
    knownProviders: readonly ProviderPresetDefinition[]
  }): Promise<ProviderPresetApplyResult> => ipcRenderer.invoke('providerPresets:applyCodex', args),
  applyClaude: (args: {
    provider: ProviderPresetDefinition | null
    apiKey?: string | null
    configDirName?: string
  }): Promise<ProviderPresetApplyResult> => ipcRenderer.invoke('providerPresets:applyClaude', args),
  applyOpenCode: (args: {
    provider: ProviderPresetDefinition | null
    apiKey?: string | null
    knownProviders: readonly ProviderPresetDefinition[]
  }): Promise<ProviderPresetApplyResult> =>
    ipcRenderer.invoke('providerPresets:applyOpenCode', args),
  getCurrent: (args: {
    agentId: ProviderPresetAgentId
    knownProviders: readonly ProviderPresetDefinition[]
  }): Promise<{ providerId: string | null; configPath: string }> =>
    ipcRenderer.invoke('providerPresets:getCurrent', args)
} satisfies PreloadApi['providerPresets']
