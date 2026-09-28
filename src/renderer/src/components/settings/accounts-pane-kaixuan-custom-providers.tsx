// What: Custom provider registry UI for the AccountsPane kaixuan section — a list view with Edit / Delete actions and an add / edit dialog form.
//
// Why split out: the parent accounts-pane-kaixuan-section.tsx stays under the 400-line max-lines ratchet (AGENTS.md forbids max-lines disables). The custom-provider UI is the largest user-facing piece added in v4 of the kaixuan preset feature, so keeping it here lets both files stay focused on one responsibility — main section = built-in presets + per-agent cards; this file = user-editable registry + editor dialog.
import { useCallback, useState } from 'react'
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Badge } from '../ui/badge'
import { Input } from '../ui/input'
import { SearchableSetting } from './SearchableSetting'
import {
  BUILT_IN_PROVIDER_IDS,
  type ProviderPresetDefinition
} from '../../../../shared/provider-preset-types'

export function CustomProvidersSection({
  customProviders,
  activeByAgent,
  onAddNew,
  onEdit,
  onDelete
}: {
  customProviders: readonly ProviderPresetDefinition[]
  activeByAgent: { codex: string | null; claude: string | null; opencode: string | null }
  onAddNew: () => void
  onEdit: (provider: ProviderPresetDefinition) => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.AccountsPane.kaixuanCustomTitle',
        'Custom providers ({{count}})',
        { count: customProviders.length }
      )}
      description={translate(
        'auto.components.settings.AccountsPane.kaixuanCustomDescription',
        "Register any OpenAI-compatible endpoint (GLM, Kimi, Groq, in-house gateway). Each entry exposes per-agent base URLs so Codex and OpenCode speak OpenAI Responses while ClaudeCode talks Anthropic /v1/messages — pick whichever the upstream supports and leave the rest blank. The Apply buttons live in each agent card above; clicking a custom provider there writes the matching entry to the agent's system config."
      )}
      keywords={['custom', 'provider', 'preset', 'openai-compatible', 'glm', 'kimi', 'groq']}
      className="space-y-3"
    >
      <div className="flex items-center justify-between gap-2">
        <Label>
          {translate(
            'auto.components.settings.AccountsPane.kaixuanCustomListLabel',
            'Custom registry'
          )}
        </Label>
        <Button variant="outline" size="xs" onClick={onAddNew}>
          <Plus className="size-3" />
          {translate('auto.components.settings.AccountsPane.kaixuanCustomAdd', 'Add provider')}
        </Button>
      </div>
      {customProviders.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AccountsPane.kaixuanCustomEmpty',
            'No custom providers yet. Click Add provider to register a base URL — useful for in-house LLM gateways that speak the OpenAI Responses or Anthropic /v1/messages protocol.'
          )}
        </p>
      ) : (
        <ul className="space-y-2">
          {customProviders.map((provider) => {
            const codexActive = activeByAgent.codex === provider.id
            const claudeActive = activeByAgent.claude === provider.id
            const opencodeActive = activeByAgent.opencode === provider.id
            return (
              <li
                key={provider.id}
                className="flex items-start justify-between gap-2 rounded-md border border-border/60 px-3 py-2"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{provider.label}</span>
                    <code className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                      {provider.id}
                    </code>
                    {codexActive ? (
                      <Badge variant="secondary">
                        {translate(
                          'auto.components.settings.AccountsPane.kaixuanAgentCodex',
                          'Codex'
                        )}
                      </Badge>
                    ) : null}
                    {claudeActive ? (
                      <Badge variant="secondary">
                        {translate(
                          'auto.components.settings.AccountsPane.kaixuanAgentClaude',
                          'ClaudeCode'
                        )}
                      </Badge>
                    ) : null}
                    {opencodeActive ? (
                      <Badge variant="secondary">
                        {translate(
                          'auto.components.settings.AccountsPane.kaixuanAgentOpencode',
                          'OpenCode'
                        )}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{provider.codexBaseUrl}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => onEdit(provider)}
                    aria-label={translate(
                      'auto.components.settings.AccountsPane.kaixuanCustomEdit',
                      'Edit {{provider}}',
                      { provider: provider.label }
                    )}
                  >
                    <Pencil className="size-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => onDelete(provider.id)}
                    aria-label={translate(
                      'auto.components.settings.AccountsPane.kaixuanCustomDelete',
                      'Delete {{provider}}',
                      { provider: provider.label }
                    )}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </SearchableSetting>
  )
}

type ProviderEditorDialogProps = {
  initial: ProviderPresetDefinition | null
  existingIds: Set<string>
  onSubmit: (provider: ProviderPresetDefinition) => void | Promise<void>
  onCancel: () => void
}

export function ProviderEditorDialog({
  initial,
  existingIds,
  onSubmit,
  onCancel
}: ProviderEditorDialogProps): React.JSX.Element {
  const isEdit = initial !== null
  const [id, setId] = useState<string>(initial?.id ?? '')
  const [label, setLabel] = useState<string>(initial?.label ?? '')
  const [codexBaseUrl, setCodexBaseUrl] = useState<string>(initial?.codexBaseUrl ?? '')
  const [claudeBaseUrl, setClaudeBaseUrl] = useState<string>(initial?.claudeBaseUrl ?? '')
  const [opencodeBaseUrl, setOpencodeBaseUrl] = useState<string>(initial?.opencodeBaseUrl ?? '')
  const [opencodeModelIdsText, setOpencodeModelIdsText] = useState<string>(
    (initial?.opencodeModelIds ?? []).join(', ')
  )
  const [envKeyName, setEnvKeyName] = useState<string>(initial?.envKeyName ?? 'OPENAI_API_KEY')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState<boolean>(false)

  // Why: modelProviderName and codexProviderName default to the user-entered id
  // and label respectively; editing either is a power-user concern, so the form
  // omits them as inputs and computes them inline at submit. The constructor
  // keeps the initial values for edits so the saved shape round-trips.
  const effectiveModelProviderName = initial?.modelProviderName?.trim() || id.trim()
  const effectiveCodexProviderName = initial?.codexProviderName?.trim() || label.trim() || id.trim()

  const handleSubmit = useCallback(async () => {
    const trimmedId = id.trim()
    const trimmedLabel = label.trim()
    if (trimmedId.length === 0) {
      setSubmitError('id is required')
      return
    }
    if (BUILT_IN_PROVIDER_IDS.has(trimmedId)) {
      setSubmitError(`"${trimmedId}" is a built-in id; pick a different one`)
      return
    }
    if (!isEdit && existingIds.has(trimmedId)) {
      setSubmitError(`A provider with id "${trimmedId}" already exists`)
      return
    }
    if (trimmedLabel.length === 0) {
      setSubmitError('label is required')
      return
    }
    const opencodeModelIds = opencodeModelIdsText
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (opencodeModelIds.length === 0) {
      setSubmitError('at least one OpenCode model id is required')
      return
    }
    if (!/^https?:\/\//.test(codexBaseUrl.trim())) {
      setSubmitError('Codex base URL must start with http:// or https://')
      return
    }
    setSubmitting(true)
    try {
      await onSubmit({
        id: trimmedId,
        label: trimmedLabel,
        modelProviderName: effectiveModelProviderName,
        codexProviderName: effectiveCodexProviderName,
        codexBaseUrl: codexBaseUrl.trim(),
        claudeBaseUrl: claudeBaseUrl.trim() || codexBaseUrl.trim(),
        opencodeBaseUrl: opencodeBaseUrl.trim() || codexBaseUrl.trim(),
        envKeyName: envKeyName.trim() || 'OPENAI_API_KEY',
        opencodeModelIds
      })
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error))
      setSubmitting(false)
    }
  }, [
    id,
    label,
    effectiveModelProviderName,
    effectiveCodexProviderName,
    codexBaseUrl,
    claudeBaseUrl,
    opencodeBaseUrl,
    opencodeModelIdsText,
    envKeyName,
    isEdit,
    existingIds,
    onSubmit
  ])

  return (
    <div
      className="rounded-md border border-border/60 bg-muted/20 p-3"
      role="dialog"
      aria-label={translate(
        'auto.components.settings.AccountsPane.kaixuanCustomDialogTitle',
        isEdit ? 'Edit custom provider' : 'Add custom provider'
      )}
    >
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold">
          {translate(
            'auto.components.settings.AccountsPane.kaixuanCustomDialogTitle',
            isEdit ? 'Edit custom provider' : 'Add custom provider'
          )}
        </h4>
        <div className="flex gap-2">
          <Button variant="ghost" size="xs" onClick={onCancel} disabled={submitting}>
            {translate('auto.components.settings.AccountsPane.kaixuanCustomCancel', 'Cancel')}
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() => void handleSubmit()}
            disabled={submitting}
          >
            {submitting ? <Loader2 className="size-3 animate-spin" /> : null}
            {translate(
              'auto.components.settings.AccountsPane.kaixuanCustomSave',
              isEdit ? 'Save' : 'Add'
            )}
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <FieldRow
          label={translate(
            'auto.components.settings.AccountsPane.kaixuanCustomFieldId',
            'ID (used as config key)'
          )}
        >
          <Input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder={translate(
              'auto.components.settings.AccountsPane.kaixuanCustomPlaceholderId',
              'glm-5.2'
            )}
            spellCheck={false}
            disabled={isEdit}
            className="flex-1"
          />
        </FieldRow>
        <FieldRow
          label={translate(
            'auto.components.settings.AccountsPane.kaixuanCustomFieldLabel',
            'Display label'
          )}
        >
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={translate(
              'auto.components.settings.AccountsPane.kaixuanCustomPlaceholderLabel',
              'GLM 5.2 (Z.AI)'
            )}
            className="flex-1"
          />
        </FieldRow>
        <FieldRow
          label={translate(
            'auto.components.settings.AccountsPane.kaixuanCustomFieldCodexBaseUrl',
            'Codex base URL'
          )}
        >
          <Input
            value={codexBaseUrl}
            onChange={(e) => setCodexBaseUrl(e.target.value)}
            placeholder={translate(
              'auto.components.settings.AccountsPane.kaixuanCustomPlaceholderCodexUrl',
              'https://api.z.ai/api/coding/paas/v4'
            )}
            spellCheck={false}
            className="flex-1"
          />
        </FieldRow>
        <FieldRow
          label={translate(
            'auto.components.settings.AccountsPane.kaixuanCustomFieldClaudeBaseUrl',
            'ClaudeCode base URL (Anthropic protocol)'
          )}
        >
          <Input
            value={claudeBaseUrl}
            onChange={(e) => setClaudeBaseUrl(e.target.value)}
            placeholder={translate(
              'auto.components.settings.AccountsPane.kaixuanCustomPlaceholderClaudeUrl',
              'https://api.z.ai/api/anthropic'
            )}
            spellCheck={false}
            className="flex-1"
          />
        </FieldRow>
        <FieldRow
          label={translate(
            'auto.components.settings.AccountsPane.kaixuanCustomFieldOpencodeBaseUrl',
            'OpenCode base URL'
          )}
        >
          <Input
            value={opencodeBaseUrl}
            onChange={(e) => setOpencodeBaseUrl(e.target.value)}
            placeholder={translate(
              'auto.components.settings.AccountsPane.kaixuanCustomPlaceholderOpencodeUrl',
              'https://api.z.ai/api/coding/paas/v4'
            )}
            spellCheck={false}
            className="flex-1"
          />
        </FieldRow>
        <FieldRow
          label={translate(
            'auto.components.settings.AccountsPane.kaixuanCustomFieldOpencodeModels',
            'OpenCode model IDs (comma-separated)'
          )}
        >
          <Input
            value={opencodeModelIdsText}
            onChange={(e) => setOpencodeModelIdsText(e.target.value)}
            placeholder={translate(
              'auto.components.settings.AccountsPane.kaixuanCustomPlaceholderOpencodeModel',
              'glm-5.2'
            )}
            spellCheck={false}
            className="flex-1"
          />
        </FieldRow>
        <FieldRow
          label={translate(
            'auto.components.settings.AccountsPane.kaixuanCustomFieldEnvKeyName',
            'Env key (token source)'
          )}
        >
          <Input
            value={envKeyName}
            onChange={(e) => setEnvKeyName(e.target.value)}
            placeholder={translate(
              'auto.components.settings.AccountsPane.kaixuanCustomPlaceholderEnvKey',
              'OPENAI_API_KEY'
            )}
            spellCheck={false}
            className="flex-1"
          />
        </FieldRow>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.AccountsPane.kaixuanCustomDialogFootnote',
          "Codex base URL is mandatory; ClaudeCode and OpenCode fall back to it when left blank. The Apply buttons above write the matching entry into each agent's system config — Codex needs requires_openai_auth = false (handled automatically) and OpenCode needs at least one model id."
        )}
      </p>
      {submitError ? <p className="mt-2 text-xs text-destructive">{submitError}</p> : null}
    </div>
  )
}
function FieldRow({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  // Why: Label owns its typography (per shadcn/no-restyle); we render the field
  // label as a sibling span so the form stays compact without restyling Label.
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      {children}
    </div>
  )
}
