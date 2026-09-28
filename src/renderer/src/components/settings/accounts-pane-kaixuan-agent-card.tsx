// What: Per-agent preset picker card. Shows the active provider chip, the
// config path, and a row of Apply buttons — one per built-in + registered
// custom provider, plus a Clear button to revert to the system default.
//
// Why split out: the parent accounts-pane-kaixuan-section.tsx stays under the
// 400-line max-lines ratchet (AGENTS.md forbids max-lines disables). The card
// is the most repetitive piece — three near-identical instances live in the
// parent — so extracting it keeps the diff small and the per-agent UX
// consistent.
import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Badge } from '../ui/badge'
import { SearchableSetting } from './SearchableSetting'
import {
  BUILT_IN_PROVIDER_IDS,
  KAIXUAN_PRESETS,
  type ProviderPresetAgentId,
  type ProviderPresetDefinition
} from '../../../../shared/provider-preset-types'

export type AgentCardState = {
  providerId: string | null
  busy: boolean
  error: string | null
  configPath: string | null
}

export function AgentPresetCard({
  agentLabel,
  state,
  knownProviders,
  customProviders,
  onApply,
  caveat
}: {
  agentId: ProviderPresetAgentId
  agentLabel: string
  state: AgentCardState
  knownProviders: readonly ProviderPresetDefinition[]
  customProviders: readonly ProviderPresetDefinition[]
  onApply: (provider: ProviderPresetDefinition | null) => void
  caveat?: string
}): React.JSX.Element {
  const activeProvider = state.providerId
    ? knownProviders.find((p) => p.id === state.providerId)
    : null
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.AccountsPane.kaixuanAgentTitle',
        'Provider for {{agent}}',
        { agent: agentLabel }
      )}
      description={translate(
        'auto.components.settings.AccountsPane.kaixuanAgentDescription',
        'Pick a Kaixuan gateway, a registered custom provider, or clear the active preset. Currently active: {{presetLabel}}. Config file: {{configPath}}.',
        {
          presetLabel: activeProvider
            ? activeProvider.label
            : translate('auto.components.settings.AccountsPane.kaixuanNoPreset', 'system default'),
          configPath:
            state.configPath ??
            translate('auto.components.settings.AccountsPane.kaixuanConfigNotLoaded', 'not loaded')
        }
      )}
      keywords={[
        'kaixuan',
        'provider',
        'gateway',
        'local',
        'kxpms',
        'llm.kxpms.cn',
        '127.0.0.1:8782',
        agentLabel.toLowerCase(),
        ...customProviders.map((p) => p.id)
      ]}
      className="space-y-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Label>{agentLabel}</Label>
          {state.providerId ? (
            <Badge variant="secondary">
              {translate('auto.components.settings.AccountsPane.kaixuanActiveBadge', 'active')}
            </Badge>
          ) : null}
          {activeProvider && !BUILT_IN_PROVIDER_IDS.has(activeProvider.id) ? (
            <Badge variant="outline">
              {translate('auto.components.settings.AccountsPane.kaixuanCustomBadge', 'custom')}
            </Badge>
          ) : null}
        </div>
        {state.configPath ? (
          <code className="truncate text-[11px] text-muted-foreground">{state.configPath}</code>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {Object.values(KAIXUAN_PRESETS).map((preset) => (
          <PresetApplyButton
            key={preset.id}
            label={preset.label}
            busy={state.busy}
            isActive={state.providerId === preset.id}
            onApply={() => onApply(preset)}
          />
        ))}
        {customProviders.map((preset) => (
          <PresetApplyButton
            key={preset.id}
            label={preset.label}
            busy={state.busy}
            isActive={state.providerId === preset.id}
            onApply={() => onApply(preset)}
          />
        ))}
        <PresetApplyButton
          label={translate(
            'auto.components.settings.AccountsPane.kaixuanClearButton',
            'Clear (revert to system default)'
          )}
          busy={state.busy}
          isActive={state.providerId === null}
          onApply={() => onApply(null)}
          variant="ghost"
        />
      </div>
      {caveat ? <p className="text-xs text-muted-foreground">{caveat}</p> : null}
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
    </SearchableSetting>
  )
}

function PresetApplyButton({
  label,
  busy,
  isActive,
  onApply,
  variant = 'outline'
}: {
  label: string
  busy: boolean
  isActive: boolean
  onApply: () => void
  variant?: 'outline' | 'ghost'
}): React.JSX.Element {
  return (
    <Button variant={variant} size="xs" onClick={onApply} disabled={busy || isActive}>
      {busy ? <Loader2 className="size-3 animate-spin" /> : null}
      {isActive
        ? translate(
            'auto.components.settings.AccountsPane.kaixuanButtonActive',
            'Active: {{label}}',
            {
              label
            }
          )
        : label}
    </Button>
  )
}
