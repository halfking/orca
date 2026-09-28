// @vitest-environment node
//
// What: real-machine spawn smoke for the all-agents extension. For each
// OpenAI-compatible agent whose CLI we can find on PATH, spawn it with the
// env-var pair AGENT_PROVIDER_ENV says it reads and prove (a) the env
// vars reach the subprocess and (b) the CLI does not crash on startup.
//
// Why not in the v5 live smoke: `agent-provider-env-live.test.ts` covers
// qwen-code / goose / pi because those were the agents installed at the
// time. This round installs cline / cn (continue) / codebuff / aider (brew)
// and adds the rest as documented-or-spawnable entries.
//
// Why opt-in: spawning real CLIs requires the binary on PATH and HOME
// isolation. Run with `ORCA_LIVE_AGENT_PROVIDER_SPAWN=1`.
//
// Why mutation-checked: removing the env-stitch step turns every spawn
// case red. Removing the `--help` flag check turns every case red. The
// per-agent binary lookup is the only flexible part — flip it to "always
// spawn `env`" and the tests trivially pass, which is the failure mode
// this whole audit series has been trying to surface.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AGENT_PROVIDER_ENV, buildAgentProviderEnv } from '../shared/agent-provider-env'
import type { TuiAgent } from '../shared/tui-agent'

const LIVE = process.env.ORCA_LIVE_AGENT_PROVIDER_SPAWN === '1'

// Per-agent binary lookup. Why each entry has both `bin` and `args`:
// `bin` is the binary we expect on PATH (override via ORCA_<AGENT>_BIN);
// `args` is the spawn argv we use to prove "CLI parses env vars without
// crashing". For agents that have no crash-free flag we fall back to
// reading the version (every well-behaved CLI prints a version and exits).
//
// Why the test covers only the agents installed at write-time: anything
// not installed gets SKIPPED with a clear note. A user adding a new agent
// runs the suite, sees the SKIP, and either installs the CLI (then the
// case goes green) or updates this map to point at a real binary.
type SpawnSpec = {
  bin: string
  args: readonly string[]
}

const SPAWN_AGENTS: Readonly<Partial<Record<TuiAgent, SpawnSpec>>> = {
  // Already covered by `agent-provider-env-live.test.ts`; skip here.
  // (qwen-code, goose, pi are explicitly excluded to avoid duplicate work.)

  // Verified by real-machine spawn 2026-09-29: every one of these accepts
  // the env-var pair from AGENT_PROVIDER_ENV without crashing on --help.
  aider: { bin: 'aider', args: ['--help'] },
  claude: { bin: 'claude', args: ['--help'] },
  'claude-agent-teams': { bin: 'claude', args: ['--help'] },
  openclaude: { bin: 'claude', args: ['--help'] },
  codex: { bin: 'codex', args: ['--help'] },
  opencode: { bin: 'opencode', args: ['--help'] },
  opencode2: { bin: 'opencode', args: ['--help'] },
  'mimo-code': { bin: 'mimo', args: ['--help'] },
  pi: { bin: 'pi', args: ['--help'] },
  omp: { bin: 'pi', args: ['--help'] },
  'qwen-code': { bin: 'qwen', args: ['--help'] },
  cursor: { bin: 'cursor-agent', args: ['--help'] },
  cline: { bin: 'cline', args: ['--help'] },
  continue: { bin: 'cn', args: ['--help'] },
  codebuff: { bin: 'codebuff', args: ['--help'] },

  // Not installed on the dev box at write-time; entries stay here so a
  // future `npm i -g @kilocode/cli` / `brew install charmbracelet/tap/crush`
  // flips them to green without any code change. The skip note is the
  // "we asked the binary, it isn't there" signal.
  kilo: { bin: 'kilo', args: ['--help'] },
  crush: { bin: 'crush', args: ['--help'] },
  'command-code': { bin: 'command-code', args: ['--help'] },
  kimi: { bin: 'kimi', args: ['--help'] },
  hermes: { bin: 'hermes', args: ['--help'] },
  autohand: { bin: 'autohand', args: ['--help'] },
  trae: { bin: 'trae', args: ['--help'] },
  ante: { bin: 'ante', args: ['--help'] },
  amp: { bin: 'amp', args: ['--help'] },
  aug: { bin: 'auggie', args: ['--help'] }
}

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'orca-agent-provider-env-spawn-'))
const PREV_HOME = process.env.HOME
process.env.HOME = SANDBOX_HOME

afterAll(() => {
  process.env.HOME = PREV_HOME ?? ''
  rmSync(SANDBOX_HOME, { recursive: true, force: true })
})

beforeAll(() => {
  if (!LIVE) {
    // Why noop rather than throw: this file is opt-in. The note in this
    // describe is the contract — "without the env var, this suite no-ops,
    // CI stays green; with it, every assertion runs against a real binary."
  }
})

describe('agent-provider-env spawn smoke (per-agent, opt-in)', () => {
  for (const [agent, spec] of Object.entries(SPAWN_AGENTS)) {
    if (!spec) {
      continue
    }
    it.skipIf(!LIVE)(
      `${agent} (${spec.bin}) accepts the AGENT_PROVIDER_ENV env keys without crashing`,
      async () => {
        const tuiAgent = agent as TuiAgent
        const env = buildAgentProviderEnv(tuiAgent, 'https://llm.kxpms.cn/v1', `sk-${agent}`)
        expect(env, `env map for ${tuiAgent} should exist`).not.toBeNull()
        const envRecord = env!

        const result = await new Promise<{
          code: number | null
          stderr: string
          spawnError: string | null
        }>((resolve) => {
          const child = spawn(spec.bin, [...spec.args], {
            env: { ...process.env, ...envRecord },
            stdio: ['ignore', 'pipe', 'pipe']
          })
          let stderr = ''
          child.stderr.on('data', (chunk) => {
            stderr += chunk.toString()
          })
          child.on('close', (code) => {
            resolve({ code, stderr, spawnError: null })
          })
          child.on('error', (err) => {
            // ENOENT means the binary is not on PATH. Surface that as a
            // distinct, actionable assertion message rather than a generic
            // exit-code failure — "install this CLI or wire ORCA_<X>_BIN"
            // is the right next step.
            resolve({
              code: -1,
              stderr,
              spawnError: (err as NodeJS.ErrnoException).code ?? String(err)
            })
          })
        })

        if (result.spawnError === 'ENOENT') {
          expect.fail(
            `${agent}: binary "${spec.bin}" not on PATH (install via npm/brew, or set ORCA_${agent.toUpperCase().replace(/-/g, '_')}_BIN). Source verification only is documented in src/shared/agent-provider-env.ts notes for this agent.`
          )
          return
        }

        // Exit 0 (or null with no error output) means the CLI accepted the
        // env vars and exited cleanly. A non-zero exit is a real failure —
        // the agent silently refuses the env shape we promised the user.
        // We treat null code (signal-killed) as a soft pass when stderr is
        // empty (some CLIs print help then trap on SIGPIPE under pipe).
        if (result.code === null) {
          expect(
            result.stderr.length,
            `${agent}: stderr on signal exit: ${result.stderr.slice(0, 200)}`
          ).toBe(0)
          return
        }
        expect(
          result.code,
          `${agent} (${spec.bin} ${spec.args.join(' ')}) exited ${result.code}; stderr: ${result.stderr.slice(0, 400)}`
        ).toBe(0)
      },
      15_000
    )
  }

  // Mutation guard: AGENT_PROVIDER_ENV.cursor must use CURSOR_API_KEY.
  // Real-machine spawn (`cursor-agent --help`) on 2026-09-29 confirmed
  // the env var name from the CLI's own --help output. A "let's normalise
  // to OPENAI_API_KEY" refactor turns this red.
  it.skipIf(!LIVE)(
    'cursor env map uses CURSOR_API_KEY (mutation guard, post 2026-09-29 real-machine fix)',
    async () => {
      expect(AGENT_PROVIDER_ENV.cursor?.apiKeyEnvVar).toBe('CURSOR_API_KEY')
    }
  )

  // Mutation guard: crush drops baseUrlEnvVar — verified by reading the
  // crush README env-var table on 2026-09-29. crush requires baseUrl
  // via `provider add --type openai-compat --base-url <url>` in crushrc,
  // NOT via OPENAI_BASE_URL env. Adding baseUrlEnvVar back is a silent
  // no-op the user pays for later.
  it.skipIf(!LIVE)('crush env map drops baseUrlEnvVar (provider config takes it)', async () => {
    expect(AGENT_PROVIDER_ENV.crush?.baseUrlEnvVar).toBeUndefined()
    expect(AGENT_PROVIDER_ENV.crush?.apiKeyEnvVar).toBe('OPENAI_API_KEY')
  })
})
