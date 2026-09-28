// What: unit tests for the per-agent env-var mapping. Each row in
// `AGENT_PROVIDER_ENV` is checked for: (a) shape (apiKeyEnvVar always
// set, baseUrlEnvVar present unless nativeOnly), (b) buildAgentProviderEnv
// round-trips into the right keys, (c) unmapped and nativeOnly agents
// return null. The agent-by-agent verification of "the env var really
// reaches the spawned subprocess" is a separate live smoke — see
// `docs/bug-reproductions/kaixuan-provider-preset-handoff.md` Risk 1.
//
// Why mutation-checked: removing any row's baseUrlEnvVar name must turn
// exactly one case red, and the same for swapping apiKeyEnvVar.

import { describe, expect, it } from 'vitest'
import {
  AGENT_PROVIDER_ENV,
  buildAgentProviderEnv,
  isAgentProviderEnvMapped
} from './agent-provider-env'

const EXPECTED_AGENTS: readonly (keyof typeof AGENT_PROVIDER_ENV)[] = [
  'claude',
  'claude-agent-teams',
  'openclaude',
  'codex',
  'opencode',
  'opencode2',
  'mimo-code',
  'pi',
  'omp',
  'aider',
  'goose',
  'amp',
  'kilo',
  'crush',
  'aug',
  'cline',
  'codebuff',
  'command-code',
  'continue',
  'cursor',
  'kimi',
  'qwen-code',
  'hermes',
  'autohand',
  'trae',
  'ante'
] as const

const NATIVE_ONLY_AGENTS: readonly (keyof typeof AGENT_PROVIDER_ENV)[] = [
  'gemini',
  'antigravity',
  'kiro',
  'droid',
  'mistral-vibe',
  'rovo'
] as const

describe('agent-provider-env (v4 → all-agents extension)', () => {
  it('maps every OpenAI-compatible agent to apiKeyEnvVar + (optional) baseUrlEnvVar', () => {
    for (const agent of EXPECTED_AGENTS) {
      const entry = AGENT_PROVIDER_ENV[agent]
      expect(entry, `agent=${agent} should be mapped`).toBeDefined()
      expect(typeof entry!.apiKeyEnvVar, `agent=${agent}`).toBe('string')
      expect(entry!.apiKeyEnvVar.length, `agent=${agent}`).toBeGreaterThan(0)
      // baseUrlEnvVar is optional: structured agents (codex / claude /
      // opencode) read baseUrl from the config file Orca writes, so
      // only the api key needs to land in the env for the "launch
      // outside Orca" case. Native-only agents are checked separately
      // below.
    }
  })

  it('exposes baseUrlEnvVar for the generic OpenAI-compatible agents', () => {
    // Why: the structured agents (codex / claude / opencode) read baseUrl
    // from their config file. Every other OpenAI-compatible agent
    // relies on an env-var baseUrl — so this row must exist. If a
    // future edit accidentally drops it, the agent silently goes to
    // api.openai.com and fails on the kxpms-shaped path.
    //
    // crush is the documented exception: per charmbracelet/crush README
    // env-var table, crush reads OPENAI_API_KEY but baseUrl is configured
    // per-provider via `provider add --type openai-compat --base-url` in
    // crushrc. Keeping OPENAI_BASE_URL in the table would be a silent
    // no-op (verified 2026-09-29).
    const mustHaveBaseUrl = [
      'claude-agent-teams',
      'openclaude',
      'mimo-code',
      'pi',
      'omp',
      'aider',
      'goose',
      'amp',
      'kilo',
      'aug',
      'cline',
      'codebuff',
      'command-code',
      'continue',
      'cursor',
      'kimi',
      'qwen-code',
      'hermes',
      'autohand',
      'trae',
      'ante'
    ]
    for (const agent of mustHaveBaseUrl) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: EXPECTED_AGENTS is a readonly tuple of TuiAgent keys; TS narrows the iterated type to the wider string union in this for-of, so the cast re-narrows to the literal-keyed lookup type.
      const entry = AGENT_PROVIDER_ENV[agent as keyof typeof AGENT_PROVIDER_ENV]
      expect(entry, `agent=${agent} should be mapped`).toBeDefined()
      expect(typeof entry!.baseUrlEnvVar, `agent=${agent} should expose a baseUrl env var`).toBe(
        'string'
      )
      expect(entry!.baseUrlEnvVar!.length, `agent=${agent}`).toBeGreaterThan(0)
    }
  })

  it('flags every non-OpenAI-compatible agent as nativeOnly with apiKeyEnvVar still set', () => {
    for (const agent of NATIVE_ONLY_AGENTS) {
      const entry = AGENT_PROVIDER_ENV[agent]
      expect(entry, `agent=${agent} should be present`).toBeDefined()
      expect(entry!.nativeOnly, `agent=${agent} should be nativeOnly`).toBe(true)
      expect(typeof entry!.apiKeyEnvVar, `agent=${agent}`).toBe('string')
    }
  })

  it('isAgentProviderEnvMapped reflects the table', () => {
    for (const agent of EXPECTED_AGENTS) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: agent is the tuple-element type from EXPECTED_AGENTS / NATIVE_ONLY_AGENTS, both `readonly (keyof typeof AGENT_PROVIDER_ENV)[]`. The `as never` is the literal-key-narrowed cast the consumer expects.
      expect(isAgentProviderEnvMapped(agent as never)).toBe(true)
    }
    for (const agent of NATIVE_ONLY_AGENTS) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see comment above.
      expect(isAgentProviderEnvMapped(agent as never)).toBe(true)
    }
  })

  it('buildAgentProviderEnv returns null for unmapped agents', () => {
    // Pick a TuiAgent that is NOT in the table. The list of TuiAgent
    // values is closed; iterate the table and synthesise a key that
    // cannot collide.
    const mappedKeys = new Set(Object.keys(AGENT_PROVIDER_ENV))
    let unmapped: string | null = null
    for (const candidate of ['autohand', 'mimo-code', 'aider', 'cursor', 'goose', 'kilo', 'pi']) {
      if (!mappedKeys.has(candidate)) {
        unmapped = candidate
        break
      }
    }
    // If every candidate mapped, synthesise a clearly fake key.
    if (unmapped === null) {
      unmapped = '__definitely_not_a_real_agent__'
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: unmapped is a synthesised string that's guaranteed not to be a TuiAgent; the cast widens for the call signature.
    expect(buildAgentProviderEnv(unmapped as never, 'https://x/v1', 'sk-test')).toBeNull()
  })

  it('buildAgentProviderEnv returns null for nativeOnly agents', () => {
    for (const agent of NATIVE_ONLY_AGENTS) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: agent is the tuple-element type from NATIVE_ONLY_AGENTS, a readonly (keyof typeof AGENT_PROVIDER_ENV)[]. The cast widens for the call.
      expect(buildAgentProviderEnv(agent as never, 'https://x/v1', 'sk-test')).toBeNull()
    }
  })

  it('buildAgentProviderEnv produces exactly the right env-var keys', () => {
    const env = buildAgentProviderEnv('aider', 'https://api.kxpms.cn/v1', 'sk-test-123')
    expect(env).toEqual({
      OPENAI_API_KEY: 'sk-test-123',
      OPENAI_API_BASE: 'https://api.kxpms.cn/v1'
    })
  })

  it('omits apiKey when caller passes null/empty (env-var reference case)', () => {
    const env = buildAgentProviderEnv('cursor', 'https://api.kxpms.cn/v1', null)
    expect(env).toEqual({ OPENAI_BASE_URL: 'https://api.kxpms.cn/v1' })
  })

  it('goose uses OPENAI_HOST not OPENAI_BASE_URL (mutation guard)', () => {
    // Why: goose's env-var name is OPENAI_HOST. If a future edit silently
    // renames it to OPENAI_BASE_URL the agent will see no baseUrl. This
    // test makes that change red.
    const env = buildAgentProviderEnv('goose', 'https://api.kxpms.cn/v1', 'sk-goose')
    expect(env).toEqual({
      OPENAI_API_KEY: 'sk-goose',
      OPENAI_HOST: 'https://api.kxpms.cn/v1'
    })
  })

  it('pi uses anthropic env-var names, not openai (mutation guard)', () => {
    // Why: pi defaults to anthropic protocol. If a future edit renames
    // these to OPENAI_API_KEY / OPENAI_BASE_URL pi will read no creds.
    const env = buildAgentProviderEnv('pi', 'https://api.kxpms.cn/v1', 'sk-pi')
    expect(env).toEqual({
      ANTHROPIC_API_KEY: 'sk-pi',
      ANTHROPIC_BASE_URL: 'https://api.kxpms.cn/v1'
    })
  })

  // Why per-agent mutation guards: every OpenAI-compatible agent's exact
  // env-var name is now locked. A silent rename in AGENT_PROVIDER_ENV would
  // make the agent read no creds and the user would see an opaque auth
  // error at call time. Each guard is the cheapest test that still turns
  // red on rename — keep them one-line per agent.
  it.each([
    ['mimo-code', { OPENAI_API_KEY: 'sk-mimo', OPENAI_BASE_URL: 'https://api.kxpms.cn/v1' }],
    ['omp', { OPENAI_API_KEY: 'sk-omp', OPENAI_BASE_URL: 'https://api.kxpms.cn/v1' }],
    [
      'claude-agent-teams',
      { ANTHROPIC_AUTH_TOKEN: 'sk-cagent', ANTHROPIC_BASE_URL: 'https://api.kxpms.cn/v1' }
    ],
    [
      'openclaude',
      { ANTHROPIC_AUTH_TOKEN: 'sk-openclaude', ANTHROPIC_BASE_URL: 'https://api.kxpms.cn/v1' }
    ],
    ['amp', { OPENAI_API_KEY: 'sk-amp', OPENAI_BASE_URL: 'https://api.kxpms.cn/v1' }],
    ['kilo', { OPENAI_API_KEY: 'sk-kilo', OPENAI_BASE_URL: 'https://api.kxpms.cn/v1' }],
    ['cline', { OPENAI_API_KEY: 'sk-cline', OPENAI_BASE_URL: 'https://api.kxpms.cn/v1' }],
    ['codebuff', { OPENAI_API_KEY: 'sk-codebuff', OPENAI_BASE_URL: 'https://api.kxpms.cn/v1' }],
    ['command-code', { OPENAI_API_KEY: 'sk-cmd', OPENAI_BASE_URL: 'https://api.kxpms.cn/v1' }],
    ['continue', { OPENAI_API_KEY: 'sk-cn', OPENAI_BASE_URL: 'https://api.kxpms.cn/v1' }],
    // Why cursor uses CURSOR_API_KEY (not OPENAI_API_KEY): the cursor-agent
    // --help output literally names CURSOR_API_KEY. Real-machine spawn
    // verified 2026-09-29. Keep this guard loud so a "let's normalise to
    // OPENAI_API_KEY" refactor fails red.
    ['cursor', { CURSOR_API_KEY: 'sk-cursor', OPENAI_BASE_URL: 'https://api.kxpms.cn/v1' }],
    ['kimi', { OPENAI_API_KEY: 'sk-kimi', OPENAI_BASE_URL: 'https://api.kxpms.cn/v1' }],
    ['qwen-code', { OPENAI_API_KEY: 'sk-qwen', OPENAI_BASE_URL: 'https://api.kxpms.cn/v1' }],
    ['hermes', { OPENAI_API_KEY: 'sk-hermes', OPENAI_BASE_URL: 'https://api.kxpms.cn/v1' }],
    ['autohand', { OPENAI_API_KEY: 'sk-autohand', OPENAI_BASE_URL: 'https://api.kxpms.cn/v1' }],
    ['trae', { OPENAI_API_KEY: 'sk-trae', OPENAI_BASE_URL: 'https://api.kxpms.cn/v1' }],
    ['ante', { OPENAI_API_KEY: 'sk-ante', OPENAI_BASE_URL: 'https://api.kxpms.cn/v1' }],
    ['aug', { OPENAI_API_KEY: 'sk-aug', OPENAI_BASE_URL: 'https://api.kxpms.cn/v1' }]
  ] as const)('per-agent env-var shape (mutation guard) — %s', (agent, expected) => {
    const env = buildAgentProviderEnv(agent, 'https://api.kxpms.cn/v1', 'sk-fixed')
    // Why replace the key with the expected one: the test only cares about
    // the env-var NAME (the key) and VALUE (the URL); the apiKey value is
    // a fixture, not part of the contract.
    expect(env).toEqual({ ...expected, [Object.keys(expected)[0]!]: 'sk-fixed' })
  })

  // Why crush has only the apiKeyEnvVar: the crush README env-var table
  // lists OPENAI_API_KEY but does NOT expose a top-level OPENAI_BASE_URL —
  // baseUrl is configured per-provider via `provider add --base-url` in
  // crushrc. Keeping baseUrlEnvVar unset here prevents a silent no-op when
  // the user clicks Apply.
  it('crush env map drops baseUrlEnvVar (provider config takes it)', () => {
    const env = buildAgentProviderEnv('crush', 'https://api.kxpms.cn/v1', 'sk-crush')
    expect(env).toEqual({ OPENAI_API_KEY: 'sk-crush' })
    expect(AGENT_PROVIDER_ENV.crush?.baseUrlEnvVar).toBeUndefined()
  })

  // Why go through AGENT_PROVIDER_ENV directly for the table-shape lock:
  // buildAgentProviderEnv skips nativeOnly entries and we'd lose coverage
  // for the structured agents (codex / claude / opencode) that have no
  // baseUrlEnvVar but DO have apiKeyEnvVar. This makes the API-key
  // mismatch case (the most damaging silent rename) loud for every agent.
  it('AGENT_PROVIDER_ENV.apiKeyEnvVar is non-empty for every mapped agent', () => {
    for (const [agent, entry] of Object.entries(AGENT_PROVIDER_ENV)) {
      expect(entry?.apiKeyEnvVar?.length ?? 0, `agent=${agent}`).toBeGreaterThan(0)
    }
  })
})
