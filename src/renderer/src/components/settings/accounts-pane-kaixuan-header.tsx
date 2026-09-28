// What: Top banner of the AccountsPane kaixuan section — section title,
// description, protocol caveat, IPC-bridge availability notice, settings-load
// error banner, and the inline API key input.
//
// Why split out: the parent accounts-pane-kaixuan-section.tsx stays under the
// 400-line max-lines ratchet (AGENTS.md forbids max-lines disables). The header
// is presentational and renders the same regardless of state — only the
// settingsLoadError message and api availability change — so it cleanly
// separates the "shell" from the stateful apply logic.
import { AlertTriangle } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Input } from '../ui/input'
import { SearchableSetting } from './SearchableSetting'

export function AccountsPaneKaixuanHeader({
  apiAvailable,
  settingsLoadError,
  apiKeyDraft,
  onApiKeyChange,
  onApiKeyClear
}: {
  apiAvailable: boolean
  settingsLoadError: string | null
  apiKeyDraft: string
  onApiKeyChange: (value: string) => void
  onApiKeyClear: () => void
}): React.JSX.Element {
  return (
    <>
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
            'Switch the active model provider for Codex, ClaudeCode, and OpenCode to one of the two Kaixuan gateways (local http://127.0.0.1:8782 or remote https://llm.kxpms.cn), or to a custom OpenAI-compatible provider you register below. Endpoints live in ~/.codex/config.toml, ~/.claude/settings.json, and ~/.config/opencode/opencode.json respectively; nothing leaves this device. Apply restarts the next CLI session — already-running workers keep using their existing config until they exit.'
          )}
        </p>
      </div>

      <div className="flex items-start gap-2 rounded-md border border-annotation-highlight/40 bg-annotation-highlight/5 px-3 py-2 text-xs text-secondary">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {translate(
            'auto.components.settings.AccountsPane.kaixuanCaveat',
            "Read before enabling. Both gateways were verified end-to-end against the real CLIs on 2026-09-28: Codex and OpenCode over the OpenAI Responses route, ClaudeCode over the Anthropic /v1/messages route. Codex needs requires_openai_auth = false — with it true, a host logged in via ChatGPT routes the request through the OpenAI auth flow and fails 401. ClaudeCode reads ANTHROPIC_AUTH_TOKEN literally from settings.json (no ${VAR} expansion), so the key must be supplied above. Apply takes effect on the next CLI session; running workers keep their existing config until they exit. Custom providers share the same write paths; if the upstream does not expose the protocol the agent speaks, runtime calls will fail with the gateway's own error."
          )}
        </span>
      </div>

      {!apiAvailable ? (
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

      {settingsLoadError ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive dark:bg-destructive/10">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {translate(
              'auto.components.settings.AccountsPane.kaixuanSettingsLoadError',
              'Failed to load or save the custom-provider registry: {{error}}. Other settings may still apply; the registry is read-only this session.',
              { error: settingsLoadError }
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
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder={translate(
              'auto.components.settings.AccountsPane.kaixuanApiKeyPlaceholder',
              'sk-…'
            )}
            spellCheck={false}
            className="flex-1"
          />
          {apiKeyDraft.length > 0 ? (
            <Button variant="ghost" size="xs" onClick={onApiKeyClear} className="h-7 shrink-0">
              {translate('auto.components.settings.AccountsPane.kaixuanApiKeyClear', 'Clear')}
            </Button>
          ) : null}
        </div>
      </SearchableSetting>
    </>
  )
}
