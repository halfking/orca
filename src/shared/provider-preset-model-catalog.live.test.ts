import { describe, expect, it } from 'vitest'
import { KAIXUAN_PRESETS } from './provider-preset-types'

// Live gateway check for the hard-coded OpenCode model catalog.
//
// Why this exists: the `models` map is load-bearing (an entry without it is never
// registered by opencode), and a stale id inside it is invisible to unit tests —
// the config still parses and opencode still lists the provider, but selecting
// that model 404s at call time. A copied model list rots silently.
//
// Skipped by default because it needs both gateways reachable. Run it with:
//   ORCA_LIVE_GATEWAY_TESTS=1 \
//   ORCA_KAIXUAN_KEY=<token> \
//   npx vitest run --config config/vitest.config.ts \
//     src/shared/provider-preset-model-catalog.live.test.ts
//
// Both gateways must be reachable when this suite runs. CI reaches them
// over the public network; an unreachable gateway must fail the test rather
// than skip, because "we didn't actually look" is not the same as "the
// catalog is fine" and silent skips train reviewers to ignore the gate.

const LIVE = process.env.ORCA_LIVE_GATEWAY_TESTS === '1'
const KEY = process.env.ORCA_KAIXUAN_KEY ?? ''

async function fetchModelIds(baseUrl: string): Promise<Set<string> | null> {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: KEY ? { Authorization: `Bearer ${KEY}` } : {},
      signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) {
      return null
    }
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null || !('data' in body)) {
      return null
    }
    const data = (body as { data: unknown }).data
    if (!Array.isArray(data)) {
      return null
    }
    return new Set(
      data
        .map((entry) =>
          typeof entry === 'object' && entry !== null && 'id' in entry
            ? String((entry as { id: unknown }).id)
            : ''
        )
        .filter((id) => id.length > 0)
    )
  } catch {
    return null
  }
}

describe.skipIf(!LIVE)('kaixuan model catalog vs live gateways', () => {
  const catalog = KAIXUAN_PRESETS['kaixuan-kxpms'].opencodeModelIds

  it('is not empty — opencode needs a models map to register the provider', () => {
    expect(catalog.length).toBeGreaterThan(0)
  })

  it('every catalog entry exists on the kxpms gateway', async () => {
    const live = await fetchModelIds('https://llm.kxpms.cn/v1')
    if (!live) {
      // An unreachable gateway must not silently pass as "catalog is fine".
      throw new Error('kxpms gateway unreachable — cannot validate the catalog')
    }
    const missing = catalog.filter((id) => !live.has(id))
    expect(missing, `models not served by kxpms: ${missing.join(', ')}`).toEqual([])
  })

  it('every catalog entry exists on the local gateway', async () => {
    const live = await fetchModelIds('http://127.0.0.1:8782/v1')
    if (!live) {
      // Symmetric with the kxpms branch: an unreachable gateway must not
      // silently pass. CI on a schedule cannot reach a developer's loopback;
      // the schedule workflow only runs the kxpms case (see
      // .github/workflows/kaixuan-provider-preset-live.yml). This case stays
      // in the suite for the local dev-box audit pass.
      throw new Error('local kaixuan gateway unreachable — cannot validate the catalog')
    }
    const missing = catalog.filter((id) => !live.has(id))
    expect(missing, `models not served by local gateway: ${missing.join(', ')}`).toEqual([])
  })
})
