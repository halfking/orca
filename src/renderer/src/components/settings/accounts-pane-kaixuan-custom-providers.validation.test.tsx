// @vitest-environment happy-dom

// What: the custom-provider dialog must reject ids and env key names that would
// corrupt the generated Codex / OpenCode config, and must accept the rest.
//
// Why: the type layer's `isProviderPresetIdInterpolationSafe` / `isSafeEnvKeyName`
// existed with no production caller, so every assertion in provider-preset-types
// was about the two built-ins while a user could still type a broken id. These
// cases drive the dialog itself to prove the validators are on the user path.
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderEditorDialog } from './accounts-pane-kaixuan-custom-providers'

afterEach(() => cleanup())

/** Fill the required fields, then submit. Returns nothing; read the mocks. */
function submitWith(values: { id: string; envKeyName?: string }): {
  onSubmit: ReturnType<typeof vi.fn>
  onCancel: ReturnType<typeof vi.fn>
} {
  const onSubmit = vi.fn().mockResolvedValue(undefined)
  const onCancel = vi.fn()
  const { container } = render(
    <ProviderEditorDialog
      initial={null}
      existingIds={new Set<string>()}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  )

  const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input'))
  // Order in the DOM: id, label, codex base url, claude, opencode, model ids, env key.
  fireEvent.change(inputs[0], { target: { value: values.id } })
  fireEvent.change(inputs[1], { target: { value: 'Test Provider' } })
  fireEvent.change(inputs[2], { target: { value: 'https://gw.example.com/v1' } })
  fireEvent.change(inputs[5], { target: { value: 'gpt-5.5' } })
  fireEvent.change(inputs[6], { target: { value: values.envKeyName ?? 'OPENAI_API_KEY' } })

  const save = Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('Save')
  )
  expect(save).not.toBeUndefined()
  fireEvent.click(save!)

  return { onSubmit, onCancel }
}

describe('ProviderEditorDialog id validation', () => {
  it('rejects an id whose quotes or brackets would break the Codex table header', () => {
    for (const id of ['my"gateway', 'my gateway', 'my]gateway', '[gateway]', 'a\\b', '']) {
      const { onSubmit } = submitWith({ id })
      expect(onSubmit, `expected "${id}" to be rejected`).not.toHaveBeenCalled()
    }
  })

  it('accepts a dotted id — it is a valid OpenCode provider key', () => {
    // Dots stay accepted on purpose: the OpenCode path and the registry both
    // handle them, and the Codex table header is now written quoted
    // (40f9210d9), so the documented `glm-5.2` resolves there too.
    const { onSubmit } = submitWith({ id: 'glm-5.2' })
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ id: 'glm-5.2' }))
  })

  it('accepts an ordinary custom id and mirrors it into modelProviderName', () => {
    const { onSubmit } = submitWith({ id: 'my-gateway' })
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'my-gateway', modelProviderName: 'my-gateway' })
    )
  })
})

describe('ProviderEditorDialog env key validation', () => {
  it('rejects an env key a shell could never export', () => {
    for (const envKeyName of ['OPENAI-API-KEY', '2OPENAI_API_KEY', 'MY KEY']) {
      const { onSubmit } = submitWith({ id: 'my-gateway', envKeyName })
      expect(onSubmit, `expected "${envKeyName}" to be rejected`).not.toHaveBeenCalled()
    }
  })

  it('falls back to OPENAI_API_KEY when the field is left blank', () => {
    const { onSubmit } = submitWith({ id: 'my-gateway', envKeyName: '' })
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ envKeyName: 'OPENAI_API_KEY' }))
  })
})
