// What: per-agent Apply / Clear for the 27+ TUI agents that do NOT have a
// config-file switch path. v4's three structured agents (codex / claude /
// opencode) keep their existing per-agent cards; this section covers
// everyone else (aider, cursor, goose, qwen, pi, kilo, cline, crush, …).
//
// Why split out: accounts-pane-kaixuan-section.tsx already sits at the
// 400-line max-lines ratchet (AGENTS.md forbids max-lines disables). The
// all-agents list adds ~150 lines of row markup + dispatch, so it lives
// in its own sibling component.
//
// Why not a new IPC channel: `settingsApi.set` already accepts the
// `agentDefaultEnv` field through `sanitizeRendererSettingsUpdate`; the
// renderer can call it directly to merge a single agent's env into the
// persisted map. No new handler needed.
//
// Why no live "current env" indicator per row: reading
// `agentDefaultEnv[agent]` is a synchronous lookup on the settings
// already in renderer state; the row only needs to show the keys and
// values, not a derived "active provider" guess (the env vars don't
// round-trip to a kaixuan / kxpms / custom id without per-provider
// matching that we'd then have to mutate every time the env var name
// changes). The user can see the URL + key directly.
//
// Why native-only rows still render: hiding them would make the
// "supported set" silently grow as we add rows, which is exactly the
// class of green-but-wrong defect this whole audit series has been
// trying to surface. The explicit "native only" badge tells the user
// "this entry exists; Orca does not yet know how to switch it".
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { SearchableSetting } from './SearchableSetting'
import {
  KAIXUAN_PRESETS,
  type ProviderPresetDefinition
} from '../../../../shared/provider-preset-types'
import {
  AGENT_PROVIDER_ENV,
  buildAgentProviderEnv,
  isAgentProviderEnvMapped
} from '../../../../shared/agent-provider-env'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

type SettingsApiLike = {
  get: () => Promise<GlobalSettings>
  set: (args: Partial<GlobalSettings>) => Promise<GlobalSettings>
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: AGENT_PROVIDER_ENV is keyed by TuiAgent (Partial<Record<TuiAgent, ...>>); Object.keys returns string[]. The cast narrows to TuiAgent for downstream consumers (TuiAgent is a closed literal union).
const SUPPORTED_AGENT_IDS = Object.keys(AGENT_PROVIDER_ENV) as TuiAgent[]

function readSettingsApi(): SettingsApiLike | null {
  if (typeof window === 'undefined') {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: window.api?.settings is loosely typed at the global API surface; the cast narrows to the SettingsApiLike shape used here (we never call anything not in that shape).
  return (window.api?.settings ?? null) as SettingsApiLike | null
}

/** Pick the baseUrl field on a provider that the env-var path should
 *  write. Anthropic-protocol agents read ANTHROPIC_BASE_URL; OpenAI-
 *  protocol agents read OPENAI_BASE_URL / OPENAI_API_BASE. The table
 *  has apiKeyEnvVar + baseUrlEnvVar; we look at the row to choose
 *  between the three provider fields. */
function pickProviderBaseUrl(agent: TuiAgent, provider: ProviderPresetDefinition): string {
  const entry = AGENT_PROVIDER_ENV[agent]
  if (!entry) {
    return provider.codexBaseUrl
  }
  if (!entry.baseUrlEnvVar) {
    return provider.codexBaseUrl
  }
  if (entry.baseUrlEnvVar === 'ANTHROPIC_BASE_URL') {
    return provider.claudeBaseUrl
  }
  // OPENAI_BASE_URL / OPENAI_API_BASE / OPENAI_HOST — codex and opencode
  // baseUrls both end in /v1; pick whichever the agent expects.
  return provider.opencodeBaseUrl
}

export function AccountsPaneKaixuanAllAgentsSection({
  customProviders,
  selectedProviderId,
  onProviderChange
}: {
  customProviders: readonly ProviderPresetDefinition[]
  selectedProviderId: string
  onProviderChange: (id: string) => void
}): React.JSX.Element | null {
  const settingsApi = readSettingsApi()
  const [agentDefaultEnv, setAgentDefaultEnv] = useState<
    Partial<Record<TuiAgent, Record<string, string>>>
  >({})
  const [busy, setBusy] = useState<Set<TuiAgent>>(new Set())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!settingsApi) {
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const current = await settingsApi.get()
        if (!cancelled) {
          setAgentDefaultEnv(current.agentDefaultEnv ?? {})
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [settingsApi])

  const providerOptions = useMemo<ProviderPresetDefinition[]>(
    () => [...Object.values(KAIXUAN_PRESETS), ...customProviders],
    [customProviders]
  )

  const selectedProvider = useMemo<ProviderPresetDefinition | null>(
    () => providerOptions.find((p) => p.id === selectedProviderId) ?? null,
    [providerOptions, selectedProviderId]
  )

  const applyToAgent = useCallback(
    async (agent: TuiAgent) => {
      if (!settingsApi) {
        return
      }
      if (!selectedProvider) {
        return
      }
      const env = buildAgentProviderEnv(agent, pickProviderBaseUrl(agent, selectedProvider), null)
      if (!env) {
        setError(
          translate(
            'auto.components.settings.AccountsPane.kaixuanAllAgentsNativeOnly',
            'Agent is native-only; Orca does not know how to switch it to this provider.'
          )
        )
        return
      }
      setBusy((prev) => new Set(prev).add(agent))
      try {
        const next: Partial<GlobalSettings> = {
          agentDefaultEnv: { ...agentDefaultEnv, [agent]: env }
        }
        const updated = await settingsApi.set(next)
        setAgentDefaultEnv(updated.agentDefaultEnv ?? {})
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy((prev) => {
          const copy = new Set(prev)
          copy.delete(agent)
          return copy
        })
      }
    },
    [agentDefaultEnv, selectedProvider, settingsApi]
  )

  const clearAgent = useCallback(
    async (agent: TuiAgent) => {
      if (!settingsApi) {
        return
      }
      setBusy((prev) => new Set(prev).add(agent))
      try {
        const next: Partial<GlobalSettings> = {
          agentDefaultEnv: { ...agentDefaultEnv, [agent]: {} }
        }
        const updated = await settingsApi.set(next)
        setAgentDefaultEnv(updated.agentDefaultEnv ?? {})
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy((prev) => {
          const copy = new Set(prev)
          copy.delete(agent)
          return copy
        })
      }
    },
    [agentDefaultEnv, settingsApi]
  )

  const applyToAll = useCallback(async () => {
    if (!settingsApi) {
      return
    }
    if (!selectedProvider) {
      return
    }
    setBusy(new Set(SUPPORTED_AGENT_IDS))
    const next: Record<string, Record<string, string>> = { ...agentDefaultEnv }
    for (const agent of SUPPORTED_AGENT_IDS) {
      const entry = AGENT_PROVIDER_ENV[agent]
      if (!entry || entry.nativeOnly) {
        continue
      }
      const env = buildAgentProviderEnv(agent, pickProviderBaseUrl(agent, selectedProvider), null)
      if (env) {
        next[agent] = env
      }
    }
    try {
      const updated = await settingsApi.set({ agentDefaultEnv: next })
      setAgentDefaultEnv(updated.agentDefaultEnv ?? {})
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(new Set())
    }
  }, [agentDefaultEnv, selectedProvider, settingsApi])

  const clearAll = useCallback(async () => {
    if (!settingsApi) {
      return
    }
    setBusy(new Set(SUPPORTED_AGENT_IDS))
    try {
      const next: Record<string, Record<string, string>> = {}
      for (const agent of SUPPORTED_AGENT_IDS) {
        next[agent] = {}
      }
      const updated = await settingsApi.set({ agentDefaultEnv: next })
      setAgentDefaultEnv(updated.agentDefaultEnv ?? {})
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(new Set())
    }
  }, [settingsApi])

  if (!settingsApi) {
    return null
  }

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.AccountsPane.kaixuanAllAgentsTitle',
        'All agents ({{count}})',
        { count: SUPPORTED_AGENT_IDS.length }
      )}
      description={translate(
        'auto.components.settings.AccountsPane.kaixuanAllAgentsDescription',
        'Apply the selected provider to any of the {{count}} supported TUI agents via env-var injection. Structured agents (codex / claude / opencode) still go through their per-agent cards above; native-only agents (gemini / kiro / droid / rovo / antigravity / mistral-vibe) are listed but marked not supported.',
        { count: SUPPORTED_AGENT_IDS.length }
      )}
      keywords={['all-agents', 'apply', 'env', 'aider', 'cursor', 'goose', 'qwen', 'pi', 'native']}
      className="space-y-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* Why a span not a Label: Label owns its typography (shadcn/no-restyle); the inline select pair is a small form control, not a labeled form field. */}
        <span className="text-xs font-medium text-foreground/80">
          {translate(
            'auto.components.settings.AccountsPane.kaixuanAllAgentsProviderLabel',
            'Apply which provider'
          )}
        </span>
        <select
          aria-label={translate(
            'auto.components.settings.AccountsPane.kaixuanAllAgentsProviderLabel',
            'Apply which provider'
          )}
          className="rounded border border-border/60 bg-background px-2 py-1 text-xs"
          value={selectedProviderId}
          onChange={(e) => onProviderChange(e.target.value)}
        >
          {providerOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <Button
          size="xs"
          variant="outline"
          onClick={() => void applyToAll()}
          disabled={!selectedProvider || busy.size > 0}
        >
          {busy.size > 0 ? <Loader2 className="size-3 animate-spin" /> : null}
          {translate(
            'auto.components.settings.AccountsPane.kaixuanAllAgentsApplyAll',
            'Apply to all supported agents'
          )}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => void clearAll()} disabled={busy.size > 0}>
          <Trash2 className="size-3" />
          {translate('auto.components.settings.AccountsPane.kaixuanAllAgentsClearAll', 'Clear all')}
        </Button>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive dark:bg-destructive/10">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <ul className="space-y-1">
        {SUPPORTED_AGENT_IDS.map((agent) => {
          const entry = AGENT_PROVIDER_ENV[agent]
          if (!entry) {
            return null
          }
          const env = agentDefaultEnv[agent]
          const hasEnv = env !== undefined && Object.keys(env).length > 0
          const isBusy = busy.has(agent)
          return (
            <li
              key={agent}
              className="flex items-start justify-between gap-2 rounded-md border border-border/60 px-3 py-2"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs">{agent}</span>
                  {entry.nativeOnly ? (
                    <Badge variant="outline">
                      {translate(
                        'auto.components.settings.AccountsPane.kaixuanAllAgentsNativeOnlyBadge',
                        'native only'
                      )}
                    </Badge>
                  ) : null}
                </div>
                {hasEnv ? (
                  <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
                    {Object.entries(env!).map(([k, v]) => (
                      <li key={k} className="truncate">
                        <span className="text-foreground/80">{k}</span>={v}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    {translate(
                      'auto.components.settings.AccountsPane.kaixuanAllAgentsNoEnv',
                      'No env vars set for this agent.'
                    )}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void applyToAgent(agent)}
                  disabled={isBusy || entry.nativeOnly || !selectedProvider}
                >
                  {isBusy ? <Loader2 className="size-3 animate-spin" /> : null}
                  {translate(
                    'auto.components.settings.AccountsPane.kaixuanAllAgentsApply',
                    'Apply'
                  )}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => void clearAgent(agent)}
                  disabled={isBusy || !hasEnv}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            </li>
          )
        })}
      </ul>

      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.AccountsPane.kaixuanAllAgentsFootnote',
          'Native-only agents ship their own provider with no OpenAI shim. Orca does not yet know how to switch them; the row is rendered so the gap is visible. Adding a row needs (1) a confirmed env-var mapping in AGENT_PROVIDER_ENV, (2) a live smoke that proves the env reaches the subprocess, and (3) a test that fails if the env-var name silently changes.'
        )}
      </p>
    </SearchableSetting>
  )
}

// Why re-export the helper: the parent section imports it for the v4 →
// all-agents connection (it passes the same knownProviders list to the
// IPC). Keeping the export here means the dispatch is co-located with
// the UI.
export { isAgentProviderEnvMapped, pickProviderBaseUrl }
