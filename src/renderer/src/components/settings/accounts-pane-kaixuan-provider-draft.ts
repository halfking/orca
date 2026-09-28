// What: the field rules the custom-provider dialog enforces before it calls
// onSubmit. Extracted so the rules are one testable unit instead of a chain of
// inline guards in the dialog, and so the dialog file stays under the 400-line
// max-lines ratchet (AGENTS.md forbids disabling it).
//
// Why: every rule here exists because the value is written verbatim into a
// generated file — a Codex TOML table header, a quoted TOML value, an OpenCode
// JSON key, or an environment variable name.
import {
  BUILT_IN_PROVIDER_IDS,
  isProviderPresetIdInterpolationSafe,
  isSafeEnvKeyName
} from '../../../../shared/provider-preset-types'

export type ProviderDraft = {
  id: string
  label: string
  codexBaseUrl: string
  envKeyName: string
  opencodeModelIdsText: string
}

/** First violated rule, or null when the draft is acceptable. */
export function validateProviderDraft(
  draft: ProviderDraft,
  existingIds: ReadonlySet<string>,
  isEdit: boolean
): string | null {
  const id = draft.id.trim()
  if (id.length === 0) {
    return 'id is required'
  }
  if (BUILT_IN_PROVIDER_IDS.has(id)) {
    return `"${id}" is a built-in id; pick a different one`
  }
  if (!isEdit && existingIds.has(id)) {
    return `A provider with id "${id}" already exists`
  }
  if (!isProviderPresetIdInterpolationSafe(id)) {
    return 'id may only contain letters, digits and _ - . | @ : + — it is written verbatim as a config key'
  }
  if (draft.label.trim().length === 0) {
    return 'label is required'
  }
  if (parseOpenCodeModelIds(draft.opencodeModelIdsText).length === 0) {
    return 'at least one OpenCode model id is required'
  }
  if (!/^https?:\/\//.test(draft.codexBaseUrl.trim())) {
    return 'Codex base URL must start with http:// or https://'
  }
  const envKeyName = resolveEnvKeyName(draft.envKeyName)
  if (!isSafeEnvKeyName(envKeyName)) {
    return `"${envKeyName}" is not a usable environment variable name (letters, digits and _ , not starting with a digit)`
  }
  return null
}

export function parseOpenCodeModelIds(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

export function resolveEnvKeyName(envKeyName: string): string {
  return envKeyName.trim() || 'OPENAI_API_KEY'
}
