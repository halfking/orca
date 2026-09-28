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
// The local gateway (127.0.0.1:8782) is optional — when it is not running the
// local assertions are skipped rather than failed, because "dev box is off"
// is not the same as "the catalog is wrong".
//
// Per-API-path probing (round 5): the /v1/models listing does not guarantee
// the model is actually served on every protocol path the agents use. Codex
// routes to /v1/responses, ClaudeCode to /v1/messages, OpenCode to
// /v1/chat/completions — kxpms has been seen returning 503 for `glm-5.2` on
// /v1/responses while /v1/models still lists it as available. The new cases
// below POST a one-token request to each of the three paths per catalog id
// and fail on any non-2xx. Fail-closed: a 5xx or 404 means "the model is in
// the catalog but a user picking it on the matching agent will see an error
// at call time", which is exactly what the unit-test layer cannot catch.

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

const API_PATHS = ['chat/completions', 'responses', 'messages'] as const
type ApiPath = (typeof API_PATHS)[number]

/**
 * Per-path minimal request body. The three OpenAI/Anthropic-compatible
 * surfaces the kxpms gateway multiplexes do not share a single schema — the
 * Responses API wants `input`, the other two want `messages`. Sending the
 * wrong shape produces a 4xx that is a *schema* failure, not a *model*
 * failure, so each path gets its native body to keep the signal clean.
 */
function bodyFor(path: ApiPath, modelId: string): Record<string, unknown> {
  if (path === 'responses') {
    return { model: modelId, input: '.', max_tokens: 1 }
  }
  // chat/completions + messages (Anthropic) share the messages shape.
  return {
    model: modelId,
    messages: [{ role: 'user', content: '.' }],
    max_tokens: 1
  }
}

async function probeApiPath(
  baseUrl: string,
  path: ApiPath,
  modelId: string
): Promise<{ status: number; error?: string }> {
  const url = `${baseUrl}/${path}`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(KEY ? { Authorization: `Bearer ${KEY}` } : {})
      },
      body: JSON.stringify(bodyFor(path, modelId)),
      signal: AbortSignal.timeout(20_000)
    })
    if (response.ok) {
      return { status: response.status }
    }
    let error: string | undefined
    try {
      const text = await response.text()
      error = text.slice(0, 200)
    } catch {
      // ignore — empty error is fine
    }
    return { status: response.status, error }
  } catch (e) {
    return { status: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

type ProbeResult = { model: string; status: number; error?: string }

async function probeCatalogOnPath(baseUrl: string, path: ApiPath): Promise<ProbeResult[]> {
  return Promise.all(
    KAIXUAN_PRESETS['kaixuan-kxpms'].opencodeModelIds.map(async (model) => ({
      model,
      ...(await probeApiPath(baseUrl, path, model))
    }))
  )
}

function formatMatrix(label: string, results: ProbeResult[]): string {
  const rows = results.map((r) => {
    const status = r.status === 0 ? 'NETERR' : String(r.status)
    const tail = r.error ? ` — ${r.error}` : ''
    return `  ${r.model.padEnd(20)} ${status}${tail}`
  })
  return `${label}:\n${rows.join('\n')}`
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

  it('every catalog entry exists on the local gateway when it is running', async () => {
    const live = await fetchModelIds('http://127.0.0.1:8782/v1')
    if (!live) {
      return
    }
    const missing = catalog.filter((id) => !live.has(id))
    expect(missing, `models not served by local gateway: ${missing.join(', ')}`).toEqual([])
  })

  // --- Per-API-path probing (round 5) ---
  //
  // For each catalog id, POST a one-token request to each of the three
  // protocol paths the agents use. Any non-2xx (4xx, 5xx, or network error)
  // is reported in the failure matrix. The matrix is included in the
  // assertion message so a failing CI run tells the reader which id is
  // broken on which path — the unit-test layer cannot show this.

  describe('every catalog entry responds on each kxpms API path', () => {
    for (const path of API_PATHS) {
      it(`/v1/${path}`, async () => {
        const results = await probeCatalogOnPath('https://llm.kxpms.cn/v1', path)
        const failures = results.filter((r) => r.status < 200 || r.status >= 300)
        expect(failures, formatMatrix(`kxpms /v1/${path}`, results)).toEqual([])
      })
    }
  })

  describe('every catalog entry responds on each local API path', () => {
    // Local gateway is optional (CI runners cannot reach 127.0.0.1:8782).
    // Each per-path test re-checks reachability because vitest runs tests
    // independently — a beforeAll that mutates a closure would not survive
    // the test boundary. The check is one GET against /v1/models, ~50 ms.
    for (const path of API_PATHS) {
      it(`/v1/${path}`, async () => {
        const reachable = await fetchModelIds('http://127.0.0.1:8782/v1')
        if (!reachable) {
          return
        }
        const results = await probeCatalogOnPath('http://127.0.0.1:8782/v1', path)
        const failures = results.filter((r) => r.status < 200 || r.status >= 300)
        expect(failures, formatMatrix(`local /v1/${path}`, results)).toEqual([])
      })
    }
  })
})
