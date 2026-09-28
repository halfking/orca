import { describe, expect, it } from 'vitest'
import {
  parseOpenCodeModelIds,
  resolveEnvKeyName,
  validateProviderDraft,
  type ProviderDraft
} from './accounts-pane-kaixuan-provider-draft'

const VALID: ProviderDraft = {
  id: 'my-gateway',
  label: 'In-house gateway',
  codexBaseUrl: 'https://gw.example.com/v1',
  envKeyName: 'OPENAI_API_KEY',
  opencodeModelIdsText: 'gpt-5.5'
}

function errorFor(
  overrides: Partial<ProviderDraft>,
  existingIds: string[] = [],
  isEdit = false
): string | null {
  return validateProviderDraft({ ...VALID, ...overrides }, new Set(existingIds), isEdit)
}

describe('validateProviderDraft', () => {
  it('accepts a complete draft', () => {
    expect(errorFor({})).toBeNull()
  })

  it('trims the id before judging it', () => {
    expect(errorFor({ id: '  my-gateway  ' })).toBeNull()
  })

  it('rejects an id that would break the Codex table header or the OpenCode key', () => {
    for (const id of ['my gateway', 'my"gateway', 'my]gateway', '[gateway]', 'a\\b']) {
      expect(errorFor({ id }), `expected "${id}" to be rejected`).not.toBeNull()
    }
  })

  it('accepts a dotted id — OpenCode and the registry handle it', () => {
    expect(errorFor({ id: 'glm-5.2' })).toBeNull()
  })

  it('rejects a built-in id, a duplicate and an empty id', () => {
    expect(errorFor({ id: 'kaixuan-local' })).not.toBeNull()
    expect(errorFor({ id: '' })).not.toBeNull()
    expect(errorFor({ id: 'dupe' }, ['dupe'])).not.toBeNull()
  })

  it('lets an edit keep its own id without tripping the duplicate rule', () => {
    expect(errorFor({ id: 'dupe' }, ['dupe'], true)).toBeNull()
  })

  it('rejects a missing label, model list or usable base url', () => {
    expect(errorFor({ label: '   ' })).not.toBeNull()
    expect(errorFor({ opencodeModelIdsText: ' , ' })).not.toBeNull()
    expect(errorFor({ codexBaseUrl: 'gw.example.com' })).not.toBeNull()
  })

  it('rejects an env key a shell could not export', () => {
    expect(errorFor({ envKeyName: 'OPENAI-API-KEY' })).not.toBeNull()
    expect(errorFor({ envKeyName: '2KEY' })).not.toBeNull()
  })
})

describe('parseOpenCodeModelIds', () => {
  it('splits on commas and whitespace and drops blanks', () => {
    expect(parseOpenCodeModelIds('a, b\nc ,,  d')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('returns nothing for a blank list', () => {
    expect(parseOpenCodeModelIds('  ,  ')).toEqual([])
  })
})

describe('resolveEnvKeyName', () => {
  it('falls back to OPENAI_API_KEY when the field is empty', () => {
    expect(resolveEnvKeyName('   ')).toBe('OPENAI_API_KEY')
    expect(resolveEnvKeyName(' MY_KEY ')).toBe('MY_KEY')
  })
})
