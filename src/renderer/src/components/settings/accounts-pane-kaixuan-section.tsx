// What: AccountsPane 里的 kaixuan provider 预设 section。一键启用 / 关闭
// Codex / ClaudeCode / OpenCode 上的 kaixuan 端点（local 或 kxpms）。
//
// Why: Orca 项目原本不暴露第三方 provider 切换入口。这里用新发明 "preset" 概念
// 把 IPC handler 暴露到 UI，让用户在 AccountsPane 里勾选 + Apply 即生效。
//
// Caveats the UI surfaces (these are NOT just-for-show):
//  * ClaudeCode walks the Anthropic `/v1/messages` protocol; the kaixuan gateway
//    upstream (kxpms) is documented as OpenAI Responses only. The ClaudeCode
//    preset writes the right base URL/auth key, but the user must accept that
//    runtime requests will 404/501 until the gateway team exposes a compatible
//    endpoint.
//  * ClaudeCode's settings.json env block does NOT do shell-style ${VAR}
//    expansion. If the user does not provide an inline API key we leave
//    ANTHROPIC_AUTH_TOKEN absent and rely on the user's own shell export (which
//    ClaudeCode *does* read at startup).
//  * Codex uses [model_providers.X] + top-level model_provider; the OpenCode CLI
//    reads provider.<id>.options.{baseURL,apiKey} per opencode.ai/docs/providers.
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Badge } from '../ui/badge'
import { Input } from '../ui/input'
import { SearchableSetting } from './SearchableSetting'
import {
  KAIXUAN_PRESETS,
  type KaixuanPresetId,
  type ProviderPresetAgentId
} from '../../../../shared/provider-preset-types'

type AgentState = {
  presetId: KaixuanPresetId | null
  busy: boolean
  error: string | null
  configPath: string | null
}

const initialAgentState: AgentState = {
  presetId: null,
  busy: false,
  error: null,
  configPath: null
}

function readWindowApi() {
  if (typeof window === 'undefined') {
    return null
  }
  return window.api?.providerPresets ?? null
}

export function renderKaixuanAccountsSection(): React.JSX.Element {
  return <KaixuanAccountsSection />
}

function KaixuanAccountsSection(): React.JSX.Element {
  const api = readWindowApi()
  const [codex, setCodex] = useState<AgentState>(initialAgentState)
  const [claude, setClaude] = useState<AgentState>(initialAgentState)
  const [openCode, setOpenCode] = useState<AgentState>(initialAgentState)
  // Why: kept only in component state, never persisted. The literal value is
  // forwarded into the system config on Apply and forgotten on reload.
  const [apiKeyDraft, setApiKeyDraft] = useState<string>('')

  useEffect(() => {
    if (!api) {
      return
    }
    let cancelled = false
    void (async () => {
      const fetchOne = async (
        agentId: ProviderPresetAgentId,
        applyState: (next: AgentState) => void
      ): Promise<void> => {
        try {
          const result = await api.getCurrent({ agentId })
          if (!cancelled) {
            applyState({
              ...initialAgentState,
              presetId: result.presetId,
              configPath: result.configPath
            })
          }
        } catch (error) {
          if (!cancelled) {
            applyState({
              ...initialAgentState,
              error: error instanceof Error ? error.message : String(error)
            })
          }
        }
      }
      await Promise.all([
        fetchOne('codex', (s) => setCodex(s)),
        fetchOne('claude', (s) => setClaude(s)),
        fetchOne('opencode', (s) => setOpenCode(s))
      ])
    })()
    return () => {
      cancelled = true
    }
  }, [api])

  const trimmedApiKey = apiKeyDraft.trim()

  const applyPreset = useCallback(
    async (
      agentId: ProviderPresetAgentId,
      presetId: KaixuanPresetId | null,
      applyState: (next: AgentState) => void
    ): Promise<void> => {
      if (!api) {
        return
      }
      applyState({ presetId, busy: true, error: null, configPath: null })
      const apiKeyArg = trimmedApiKey.length > 0 ? trimmedApiKey : null
      try {
        const result =
          agentId === 'codex'
            ? // Codex reads OPENAI_API_KEY from the user's shell; nothing to embed.
              await api.applyCodex({ presetId })
            : agentId === 'claude'
              ? await api.applyClaude({ presetId, apiKey: apiKeyArg })
              : await api.applyOpenCode({ presetId, apiKey: apiKeyArg })
        if (result.error) {
          applyState({ presetId, busy: false, error: result.error, configPath: result.configPath })
          return
        }
        applyState({ presetId, busy: false, error: null, configPath: result.configPath })
      } catch (error) {
        applyState({
          presetId,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
          configPath: null
        })
      }
    },
    [api, trimmedApiKey]
  )

  return (
    <section key="kaixuan" id="accounts-kaixuan" className="space-y-4 scroll-mt-6">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">
          {translate(
            'auto.components.settings.AccountsPane.kaixuanTitle',
            'Kaixuan provider preset'
          )}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AccountsPane.kaixuanDescription',
            'Switch the active model provider for Codex, ClaudeCode, and OpenCode to one of the two Kaixuan gateways (local http://127.0.0.1:8782 or remote https://llm.kxpms.cn). Endpoints live in ~/.codex/config.toml, ~/.claude/settings.json, and ~/.config/opencode/opencode.json respectively; nothing leaves this device. Apply restarts the next CLI session — already-running workers keep using their existing config until they exit.'
          )}
        </p>
      </div>

      <div className="flex items-start gap-2 rounded-md border border-annotation-highlight/40 bg-annotation-highlight/5 px-3 py-2 text-xs text-secondary">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {translate(
            'auto.components.settings.AccountsPane.kaixuanCaveat',
            'Read before enabling. The kxpms gateway ships an OpenAI Responses endpoint; ClaudeCode walks the Anthropic /v1/messages protocol. Apply will write the right base URL into ~/.claude/settings.json, but ClaudeCode worker calls may 404/501 against the upstream until the gateway team exposes an Anthropic-compatible route. Codex and OpenCode both speak OpenAI Responses and work as soon as OPENAI_API_KEY is set in the shell that runs the agent.'
          )}
        </span>
      </div>

      {!api ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive dark:bg-destructive/10">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {translate(
              'auto.components.settings.AccountsPane.kaixuanApiUnavailable',
              'The provider-preset bridge is not exposed in this build. Reinstall Orca after the next release ships.'
            )}
          </span>
        </div>
      ) : null}

      <SearchableSetting
        title={translate(
          'auto.components.settings.AccountsPane.kaixuanApiKeyTitle',
          'Inline API key (ClaudeCode / OpenCode)'
        )}
        description={translate(
          'auto.components.settings.AccountsPane.kaixuanApiKeyDescription',
          'Optional. When set, the literal token is written as ANTHROPIC_AUTH_TOKEN into ~/.claude/settings.json and as options.apiKey into ~/.config/opencode/opencode.json. Codex is unaffected — it reads OPENAI_API_KEY from the shell at agent startup. Leave blank if you exported the token in the shell that runs the worker and want ClaudeCode to inherit it.'
        )}
        keywords={['kaixuan', 'api', 'key', 'token', 'bearer', 'anthropic', 'openai']}
        className="space-y-2"
      >
        <Label htmlFor="kaixuan-api-key">
          {translate('auto.components.settings.AccountsPane.kaixuanApiKeyLabel', 'Inline API key')}
        </Label>
        <div className="flex gap-2">
          <Input
            id="kaixuan-api-key"
            type="password"
            value={apiKeyDraft}
            onChange={(e) => setApiKeyDraft(e.target.value)}
            placeholder="sk-…"
            spellCheck={false}
            className="flex-1"
          />
          {apiKeyDraft.length > 0 ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setApiKeyDraft('')}
              className="h-7 shrink-0"
            >
              {translate('auto.components.settings.AccountsPane.kaixuanApiKeyClear', 'Clear')}
            </Button>
          ) : null}
        </div>
      </SearchableSetting>

      <AgentPresetCard
        agentId="codex"
        agentLabel={translate('auto.components.settings.AccountsPane.kaixuanAgentCodex', 'Codex')}
        state={codex}
        onApply={(presetId) => applyPreset('codex', presetId, setCodex)}
      />
      <AgentPresetCard
        agentId="claude"
        agentLabel={translate(
          'auto.components.settings.AccountsPane.kaixuanAgentClaude',
          'ClaudeCode'
        )}
        state={claude}
        onApply={(presetId) => applyPreset('claude', presetId, setClaude)}
        caveat={translate(
          'auto.components.settings.AccountsPane.kaixuanAgentClaudeCaveat',
          'Writes ANTHROPIC_BASE_URL into ~/.claude/settings.json. Provide the inline API key above to also embed ANTHROPIC_AUTH_TOKEN — otherwise ClaudeCode must inherit it from the shell that runs it.'
        )}
      />
      <AgentPresetCard
        agentId="opencode"
        agentLabel={translate(
          'auto.components.settings.AccountsPane.kaixuanAgentOpencode',
          'OpenCode'
        )}
        state={openCode}
        onApply={(presetId) => applyPreset('opencode', presetId, setOpenCode)}
        caveat={translate(
          'auto.components.settings.AccountsPane.kaixuanAgentOpencodeCaveat',
          'Writes provider.kaixuan-<id> with options.baseURL + options.apiKey. OpenCode uses {env:OPENAI_API_KEY} when the inline key is blank — make sure the shell running opencode has it exported.'
        )}
      />
    </section>
  )
}

function AgentPresetCard({
  agentLabel,
  state,
  onApply,
  caveat
}: {
  agentId: ProviderPresetAgentId
  agentLabel: string
  state: AgentState
  onApply: (presetId: KaixuanPresetId | null) => void
  caveat?: string
}): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.AccountsPane.kaixuanAgentTitle',
        'Provider for {{agent}}',
        { agent: agentLabel }
      )}
      description={translate(
        'auto.components.settings.AccountsPane.kaixuanAgentDescription',
        'Pick a Kaixuan gateway or clear the active preset. Currently active: {{presetLabel}}. Config file: {{configPath}}.',
        {
          presetLabel: state.presetId
            ? KAIXUAN_PRESETS[state.presetId].label
            : translate('auto.components.settings.AccountsPane.kaixuanNoPreset', 'system default'),
          configPath:
            state.configPath ??
            translate('auto.components.settings.AccountsPane.kaixuanConfigNotLoaded', 'not loaded')
        }
      )}
      keywords={[
        'kaixuan',
        agentLabel.toLowerCase(),
        'preset',
        'provider',
        'gateway',
        'local',
        'kxpms',
        'llm.kxpms.cn',
        '127.0.0.1:8782'
      ]}
      className="space-y-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Label>{agentLabel}</Label>
          {state.presetId ? (
            <Badge variant="secondary">
              {translate('auto.components.settings.AccountsPane.kaixuanActiveBadge', 'active')}
            </Badge>
          ) : null}
        </div>
        {state.configPath ? (
          <code className="truncate text-[11px] text-muted-foreground">{state.configPath}</code>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <PresetApplyButton
          label={KAIXUAN_PRESETS['kaixuan-local'].label}
          busy={state.busy}
          isActive={state.presetId === 'kaixuan-local'}
          onApply={() => onApply('kaixuan-local')}
        />
        <PresetApplyButton
          label={KAIXUAN_PRESETS['kaixuan-kxpms'].label}
          busy={state.busy}
          isActive={state.presetId === 'kaixuan-kxpms'}
          onApply={() => onApply('kaixuan-kxpms')}
        />
        <PresetApplyButton
          label={translate(
            'auto.components.settings.AccountsPane.kaixuanClearButton',
            'Clear (revert to system default)'
          )}
          busy={state.busy}
          isActive={state.presetId === null}
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
