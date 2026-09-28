// What: AccountsPane 里的 kaixuan provider 预设 section。一键启用 / 关闭
// Codex / ClaudeCode / OpenCode 上的 kaixuan 端点（local 或 kxpms），以及用户
// 自定义注册的任意 OpenAI 兼容厂商（GLM / Kimi / Groq 等）。
//
// Why: Orca 项目原本不暴露第三方 provider 切换入口。这里用新发明 "preset" 概念
// 把 IPC handler 暴露到 UI，让用户在 AccountsPane 里勾选 + Apply 即生效。
//
// v4 wiring: kaixuan two endpoints remain hard-coded built-ins. Custom providers
// are an editable list (`customProviders` in GlobalSettings) managed by a
// sibling component (accounts-pane-kaixuan-custom-providers.tsx), persisted via
// `window.api.settings.set`, and applied through the generic
// `providerPresets:apply*` IPC. The renderer passes its known registry
// (built-in + custom) on every apply / getCurrent call so the main process can
// strip Orca-owned entries cleanly and read the active id back correctly.
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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { translate } from '@/i18n/i18n'
import {
  KAIXUAN_PRESETS,
  type ProviderPresetAgentId,
  type ProviderPresetDefinition
} from '../../../../shared/provider-preset-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  CustomProvidersSection,
  ProviderEditorDialog
} from './accounts-pane-kaixuan-custom-providers'
import { AgentPresetCard, type AgentCardState } from './accounts-pane-kaixuan-agent-card'
import { AccountsPaneKaixuanHeader } from './accounts-pane-kaixuan-header'

const initialAgentState: AgentCardState = {
  providerId: null,
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

function readSettingsApi() {
  if (typeof window === 'undefined') {
    return null
  }
  return window.api?.settings ?? null
}

export function renderKaixuanAccountsSection(): React.JSX.Element {
  return <KaixuanAccountsSection />
}

function KaixuanAccountsSection(): React.JSX.Element {
  const api = readWindowApi()
  const settingsApi = readSettingsApi()
  const [codex, setCodex] = useState<AgentCardState>(initialAgentState)
  const [claude, setClaude] = useState<AgentCardState>(initialAgentState)
  const [openCode, setOpenCode] = useState<AgentCardState>(initialAgentState)
  // Why: kept only in component state, never persisted. The literal value is
  // forwarded into the system config on Apply and forgotten on reload.
  const [apiKeyDraft, setApiKeyDraft] = useState<string>('')
  const [customProviders, setCustomProviders] = useState<ProviderPresetDefinition[]>([])
  const [editingProvider, setEditingProvider] = useState<ProviderPresetDefinition | null>(null)
  const [isAddingNew, setIsAddingNew] = useState<boolean>(false)
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null)

  const knownProviders = useMemo<readonly ProviderPresetDefinition[]>(
    () => [...Object.values(KAIXUAN_PRESETS), ...customProviders],
    [customProviders]
  )

  useEffect(() => {
    if (!settingsApi) {
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const current = await settingsApi.get()
        if (!cancelled) {
          setCustomProviders(current.customProviders ?? [])
          // Hydrate active provider ids from settings so the UI rehydrates even
          // before getCurrent finishes (system config still wins via the call
          // below, but settings keeps the chip stable across worktree reboots).
          setCodex((prev) => ({ ...prev, providerId: current.codexActiveProviderId ?? null }))
          setClaude((prev) => ({ ...prev, providerId: current.claudeActiveProviderId ?? null }))
          setOpenCode((prev) => ({ ...prev, providerId: current.opencodeActiveProviderId ?? null }))
        }
      } catch (error) {
        if (!cancelled) {
          setSettingsLoadError(error instanceof Error ? error.message : String(error))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [settingsApi])

  useEffect(() => {
    if (!api) {
      return
    }
    let cancelled = false
    void (async () => {
      const fetchOne = async (
        agentId: ProviderPresetAgentId,
        applyState: (next: AgentCardState) => void
      ): Promise<void> => {
        try {
          const result = await api.getCurrent({ agentId, knownProviders })
          if (!cancelled) {
            applyState({
              ...initialAgentState,
              providerId: result.providerId,
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
  }, [api, knownProviders])

  const trimmedApiKey = apiKeyDraft.trim()

  const persistCustomProviders = useCallback(
    async (next: ProviderPresetDefinition[]): Promise<void> => {
      if (!settingsApi) {
        return
      }
      try {
        const updated = await settingsApi.set({ customProviders: next })
        setCustomProviders(updated.customProviders ?? [])
      } catch (error) {
        setSettingsLoadError(error instanceof Error ? error.message : String(error))
      }
    },
    [settingsApi]
  )

  const applyProvider = useCallback(
    async (
      agentId: ProviderPresetAgentId,
      provider: ProviderPresetDefinition | null,
      applyState: (next: AgentCardState) => void
    ): Promise<void> => {
      if (!api) {
        return
      }
      applyState({ providerId: provider?.id ?? null, busy: true, error: null, configPath: null })
      const apiKeyArg = trimmedApiKey.length > 0 ? trimmedApiKey : null
      try {
        const result =
          agentId === 'codex'
            ? // Codex reads OPENAI_API_KEY from the user's shell; nothing to embed.
              await api.applyCodex({ provider, knownProviders })
            : agentId === 'claude'
              ? await api.applyClaude({ provider, apiKey: apiKeyArg })
              : await api.applyOpenCode({ provider, apiKey: apiKeyArg, knownProviders })
        if (result.error) {
          applyState({
            providerId: provider?.id ?? null,
            busy: false,
            error: result.error,
            configPath: result.configPath
          })
          return
        }
        applyState({
          providerId: provider?.id ?? null,
          busy: false,
          error: null,
          configPath: result.configPath
        })
        // Persist the new active provider id so the chip survives a settings
        // re-hydration cycle. The system config is the runtime source of truth,
        // but settings keeps the UI in lockstep on the next reload.
        if (settingsApi) {
          try {
            const fieldName =
              agentId === 'codex'
                ? 'codexActiveProviderId'
                : agentId === 'claude'
                  ? 'claudeActiveProviderId'
                  : 'opencodeActiveProviderId'
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `fieldName` is computed from the closed `agentId` enum so the value is one of the three known string fields on GlobalSettings; the cast widens the inline object for the Partial<GlobalSettings> parameter only.
            await settingsApi.set({ [fieldName]: provider?.id ?? null } as Partial<GlobalSettings>)
          } catch (error) {
            // Non-fatal — the system config already reflects the change.
            setSettingsLoadError(error instanceof Error ? error.message : String(error))
          }
        }
      } catch (error) {
        applyState({
          providerId: provider?.id ?? null,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
          configPath: null
        })
      }
    },
    [api, trimmedApiKey, knownProviders, settingsApi]
  )

  const handleAddNew = useCallback(() => {
    setEditingProvider(null)
    setIsAddingNew(true)
  }, [])

  const handleEdit = useCallback((provider: ProviderPresetDefinition) => {
    setEditingProvider(provider)
    setIsAddingNew(true)
  }, [])

  const handleDelete = useCallback(
    async (id: string) => {
      const next = customProviders.filter((p) => p.id !== id)
      await persistCustomProviders(next)
      // If the deleted id was active on any agent, clear that agent's chip.
      if (settingsApi) {
        const updates: Partial<GlobalSettings> = {}
        if (codex.providerId === id) {
          updates.codexActiveProviderId = null
        }
        if (claude.providerId === id) {
          updates.claudeActiveProviderId = null
        }
        if (openCode.providerId === id) {
          updates.opencodeActiveProviderId = null
        }
        if (Object.keys(updates).length > 0) {
          try {
            await settingsApi.set(updates)
          } catch (error) {
            setSettingsLoadError(error instanceof Error ? error.message : String(error))
          }
        }
      }
    },
    [
      customProviders,
      persistCustomProviders,
      settingsApi,
      codex.providerId,
      claude.providerId,
      openCode.providerId
    ]
  )

  const handleDialogSubmit = useCallback(
    async (next: ProviderPresetDefinition): Promise<void> => {
      const exists = customProviders.some((p) => p.id === next.id)
      const list = exists
        ? customProviders.map((p) => (p.id === next.id ? next : p))
        : [...customProviders, next]
      await persistCustomProviders(list)
      setIsAddingNew(false)
      setEditingProvider(null)
    },
    [customProviders, persistCustomProviders]
  )

  const handleDialogCancel = useCallback(() => {
    setIsAddingNew(false)
    setEditingProvider(null)
  }, [])

  return (
    <section key="kaixuan" id="accounts-kaixuan" className="space-y-4 scroll-mt-6">
      <AccountsPaneKaixuanHeader
        apiAvailable={api !== null}
        settingsLoadError={settingsLoadError}
        apiKeyDraft={apiKeyDraft}
        onApiKeyChange={setApiKeyDraft}
        onApiKeyClear={() => setApiKeyDraft('')}
      />

      <AgentPresetCard
        agentId="codex"
        agentLabel={translate('auto.components.settings.AccountsPane.kaixuanAgentCodex', 'Codex')}
        state={codex}
        knownProviders={knownProviders}
        customProviders={customProviders}
        onApply={(provider) => applyProvider('codex', provider, setCodex)}
      />
      <AgentPresetCard
        agentId="claude"
        agentLabel={translate(
          'auto.components.settings.AccountsPane.kaixuanAgentClaude',
          'ClaudeCode'
        )}
        state={claude}
        knownProviders={knownProviders}
        customProviders={customProviders}
        onApply={(provider) => applyProvider('claude', provider, setClaude)}
        caveat={translate(
          'auto.components.settings.AccountsPane.kaixuanAgentClaudeCaveat',
          'Writes ANTHROPIC_BASE_URL into ~/.claude/settings.json. Verified live against claude 2.1.90 on 2026-09-28 — the gateway answers /v1/messages and a real -p run completed. Provide the inline API key above to also embed ANTHROPIC_AUTH_TOKEN; settings.json does not expand ${VAR}, so the token is sent literally.'
        )}
      />
      <AgentPresetCard
        agentId="opencode"
        agentLabel={translate(
          'auto.components.settings.AccountsPane.kaixuanAgentOpencode',
          'OpenCode'
        )}
        state={openCode}
        knownProviders={knownProviders}
        customProviders={customProviders}
        onApply={(provider) => applyProvider('opencode', provider, setOpenCode)}
        caveat={translate(
          'auto.components.settings.AccountsPane.kaixuanAgentOpencodeCaveat',
          'Writes provider.<id> with options.baseURL + options.apiKey plus a models map. OpenCode ignores a provider entry with no models map (it reports "Provider not found"), so the map is required. OpenCode uses {env:OPENAI_API_KEY} when the inline key is blank — make sure the shell running opencode has it exported.'
        )}
      />

      <CustomProvidersSection
        customProviders={customProviders}
        activeByAgent={{
          codex: codex.providerId,
          claude: claude.providerId,
          opencode: openCode.providerId
        }}
        onAddNew={handleAddNew}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />

      {isAddingNew ? (
        <ProviderEditorDialog
          initial={editingProvider}
          existingIds={new Set(customProviders.map((p) => p.id))}
          onSubmit={handleDialogSubmit}
          onCancel={handleDialogCancel}
        />
      ) : null}
    </section>
  )
}
