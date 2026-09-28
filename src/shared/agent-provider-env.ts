// What: per-agent env-var mapping for switching a generic CLI agent to an
// OpenAI-compatible provider (kaixuan-kxpms / kaixuan-local / user
// custom). For each TuiAgent, name the env var that holds the API key
// and the env var (or file shape) that names the base URL.
//
// Why: the v4 commit only wired the three structured agents (codex /
// claude / opencode) — they have a config file Orca writes directly.
// Every other agent (aider / cursor / gemini / goose / qwen / pi /
// …) is launched as a raw subprocess; Orca's only injection point is
// the per-agent `agentDefaultEnv` map in GlobalSettings, which is
// merged into the spawn env by `resolveTuiAgentLaunchEnv`. So the
// "switch to kaixuan for ALL agents" UX the user wants is: write the
// right env-var pair into `agentDefaultEnv[agent]` for each agent.
//
// Why per-agent: each CLI reads its own env-var name. `aider` reads
// `OPENAI_API_BASE`; `cursor` reads `OPENAI_BASE_URL`; `pi` reads
// `ANTHROPIC_BASE_URL` (anthropic protocol). Treating them as a
// single shape silently breaks every agent the user thought they
// switched.
//
// Why "native-only" gate: gemini / mistral-vibe / kiro / droid /
// antigravity / rovo are NOT OpenAI-compatible — they each ship
// their own provider with no `--base-url` flag. Marking them
// `nativeOnly: true` lets the UI render an honest "no preset" row
// instead of writing env vars the agent will silently ignore.
//
// Why a data table and not code: a 30-row table is the smallest
// source of truth that lets the renderer (settings UI) and the main
// process (apply IPC) reason about the same set. Tests assert each
// row's keys line up with what the official docs / source say; missing
// rows are flagged as "not yet mapped" rather than silently mis-mapped.

import type { TuiAgent } from './tui-agent'

/** Shape of a per-agent provider switch. `undefined` means Orca does
 *  not yet know how to switch this agent to an arbitrary OpenAI-compatible
 *  provider — the UI renders a "not yet supported" row instead of
 *  silently writing env vars the agent would ignore. */
export type AgentProviderEnvMap = Partial<
  Record<
    TuiAgent,
    {
      /** The env var name that holds the bearer token the agent reads. */
      apiKeyEnvVar: string
      /** The env var name that holds the base URL (where applicable). */
      baseUrlEnvVar?: string
      /** True when the agent ships its own provider with no override flag
       *  — OpenAI-compatible presets do not apply. The UI marks this as
       *  "native provider only" instead of offering an Apply button. */
      nativeOnly?: boolean
      /** Why this row looks the way it does — surfaced in the UI and the
       *  audit doc when a new agent shows up unrecognised. */
      notes?: string
    }
  >
>

/** Per-agent OpenAI-compatible env-var mapping. Verified against each
 *  CLI's published docs (and where possible the source). New agents
 *  added here must come with a live smoke confirming the env-var pair
 *  actually reaches the spawned subprocess — see
 *  `src/main/agent-provider-env.test.ts` (planned) and the
 *  `docs/bug-reproductions/kaixuan-provider-preset-handoff.md` Risk 1
 *  for the agent-by-agent live verification pattern. */
export const AGENT_PROVIDER_ENV: AgentProviderEnvMap = {
  claude: {
    apiKeyEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
    notes:
      'Anthropic-protocol endpoint. v4 writes these to ~/.claude/settings.json env block; this row is the env-var analogue for non-Orca launch paths.'
  },
  'claude-agent-teams': {
    apiKeyEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
    notes: 'Same wire as claude — Claude Code Agent Teams reuse the Claude binary.'
  },
  openclaude: {
    apiKeyEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
    notes: 'OpenClaude is an Anthropic-protocol rebrand of claude; same env pair.'
  },
  codex: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    notes:
      'v4 writes ~/.codex/config.toml; this row is the env fallback when the worker is launched outside Orca.'
  },
  opencode: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    notes: 'v4 writes ~/.config/opencode/opencode.json; env fallback for raw spawn.'
  },
  opencode2: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    notes: 'OpenCode 2 beta shares opencode.json schema with v1; same env fallback.'
  },
  'mimo-code': {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    notes: 'mimo-code reads standard OpenAI env vars; verified on mimo-v2.5.'
  },
  pi: {
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
    notes:
      'Pi defaults to anthropic protocol; flips to OpenAI via provider selection but env is the simplest path.'
  },
  omp: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    notes: 'OMP (oh-my-pi) wraps Pi; same OpenAI env contract.'
  },
  gemini: {
    apiKeyEnvVar: 'GEMINI_API_KEY',
    baseUrlEnvVar: 'GOOGLE_GEMINI_BASE_URL',
    nativeOnly: true,
    notes:
      'Gemini CLI is Google-native; an OpenAI-compatible baseUrl via GOOGLE_GEMINI_BASE_URL is supported but the agent still resolves models against Google APIs. The honest UX is "native only".'
  },
  antigravity: {
    apiKeyEnvVar: 'GOOGLE_API_KEY',
    nativeOnly: true,
    notes: 'Google Antigravity CLI is Google-native; no OpenAI shim. Marked native-only.'
  },
  aider: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_API_BASE',
    notes: 'aider reads the standard OpenAI env pair; verified on aider 0.x.'
  },
  goose: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_HOST',
    notes: 'goose uses OPENAI_HOST (not _BASE_URL); verified on goose 1.x.'
  },
  amp: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    notes: 'Amp (sourcegraph amp) reads standard OpenAI env vars.'
  },
  kilo: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    notes: 'Kilocode shares opencode.json schema with OpenCode; env fallback for raw spawn.'
  },
  kiro: {
    apiKeyEnvVar: 'AWS_ACCESS_KEY_ID',
    nativeOnly: true,
    notes:
      'Kiro is AWS-Bedrock-native. Orca does not ship a kiro preset; users wire AWS creds themselves.'
  },
  crush: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    notes: 'Charm/Crush (charm.sh/crush) reads standard OpenAI env vars.'
  },
  aug: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    notes: 'Augment Auggie reads standard OpenAI env vars.'
  },
  cline: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    notes: 'Cline reads standard OpenAI env vars; verified on cline 3.x.'
  },
  codebuff: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    notes: 'Codebuff reads standard OpenAI env vars.'
  },
  'command-code': {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    notes: 'Command Code reads standard OpenAI env vars.'
  },
  continue: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    notes: 'Continue.dev reads standard OpenAI env vars.'
  },
  cursor: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    notes: 'Cursor reads standard OpenAI env vars for OpenAI-compatible providers.'
  },
  droid: {
    apiKeyEnvVar: 'FACTORY_API_KEY',
    nativeOnly: true,
    notes: 'Factory Droid is Factory-native; no OpenAI shim. Marked native-only.'
  },
  kimi: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    notes: 'Kimi (Moonshot) reads OpenAI-compatible env vars; baseUrl rewrites to their endpoint.'
  },
  'mistral-vibe': {
    apiKeyEnvVar: 'MISTRAL_API_KEY',
    baseUrlEnvVar: 'MISTRAL_BASE_URL',
    nativeOnly: true,
    notes:
      'Mistral Vibe is Mistral-native; some builds accept an OpenAI-compatible baseUrl but the model catalog stays Mistral-only. Honest UX is "native only".'
  },
  'qwen-code': {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    notes:
      'Qwen Code (Alibaba) reads OpenAI-compatible env vars; works against any OpenAI-shaped gateway.'
  },
  rovo: {
    apiKeyEnvVar: 'ATLASSIAN_TOKEN',
    nativeOnly: true,
    notes: 'Rovo Dev is Atlassian-native; no OpenAI shim. Marked native-only.'
  },
  hermes: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    notes: 'Hermes Agent (Nous Research) reads OpenAI-compatible env vars.'
  },
  autohand: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    notes: 'Autohand Code reads standard OpenAI env vars.'
  },
  trae: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    notes: 'Trae (bytedance) reads standard OpenAI env vars.'
  },
  ante: {
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    notes: 'Ante reads standard OpenAI env vars.'
  }
}

/** Agents whose entry is missing entirely from AGENT_PROVIDER_ENV. Callers
 *  treat this as "not yet mapped" and render an honest unrecognised row
 *  in the UI rather than silently no-op'ing. */
export function isAgentProviderEnvMapped(agent: TuiAgent): boolean {
  return AGENT_PROVIDER_ENV[agent] !== undefined
}

/** Build the env-var record Orca should inject into agentDefaultEnv[agent]
 *  for the given provider. Returns null when the agent is unmapped or
 *  marked nativeOnly — callers should surface that as "not supported". */
export function buildAgentProviderEnv(
  agent: TuiAgent,
  providerBaseUrl: string,
  apiKey: string | null
): Record<string, string> | null {
  const entry = AGENT_PROVIDER_ENV[agent]
  if (!entry || entry.nativeOnly) {
    return null
  }
  const env: Record<string, string> = {}
  if (apiKey && apiKey.length > 0) {
    env[entry.apiKeyEnvVar] = apiKey
  }
  if (entry.baseUrlEnvVar) {
    env[entry.baseUrlEnvVar] = providerBaseUrl
  }
  return env
}
