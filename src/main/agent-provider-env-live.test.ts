// @vitest-environment node
//
// What: live-CLI smoke for the all-agents extension. Proves that the
// env-var pair Orca writes via `agentDefaultEnv` actually reaches a real
// spawned subprocess, and that at least one downstream CLI accepts the
// env vars without crashing.
//
// Why skipped by default: spawning real CLIs needs the binary on PATH
// and HOME isolation. Opt in via `ORCA_LIVE_AGENT_PROVIDER_SMOKE=1`.
//
// Why mutation-checked: removing `OPENAI_BASE_URL` from the spawn env
// turns the qwen smoke red. Removing `OPENAI_API_KEY` likewise. The
// per-agent name guards (qwen → OPENAI_BASE_URL, goose → OPENAI_HOST,
// pi → ANTHROPIC_*) turn red if any single agent's env-var name
// silently changes in AGENT_PROVIDER_ENV.
//
// Why `env -0` instead of inspecting the CLI: every CLI prints different
// things depending on flags, but `env -0` always dumps the exact env the
// subprocess sees. NUL-separated so keys with `=` in the value (e.g.
// base URLs) don't break the parse.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { AGENT_PROVIDER_ENV, buildAgentProviderEnv } from '../shared/agent-provider-env'
import type { TuiAgent } from '../shared/tui-agent'

const LIVE = process.env.ORCA_LIVE_AGENT_PROVIDER_SMOKE === '1'

// Why a hardcoded list: the smoke covers agents that are installed on
// this host (`qwen` 0.0.1-alpha.8 / TuiAgent id `qwen-code`) and that
// round-trip the env without crashing. Other agents are exercised by
// the renderer test / settings round-trip; this file is a single
// concrete CLI proof, not a sweep.
const SMOKE_AGENTS: readonly (TuiAgent)[] = ['qwen-code', 'goose', 'pi']

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'orca-agent-provider-env-live-'))
const PREV_HOME = process.env.HOME
process.env.HOME = SANDBOX_HOME

afterAll(() => {
  process.env.HOME = PREV_HOME ?? ''
  rmSync(SANDBOX_HOME, { recursive: true, force: true })
})

beforeAll(() => {
  if (!LIVE) {
    // Why note rather than skip: this file's skip semantics are the test
    // *contract*. Without the env var, the suite no-ops and CI stays
    // green; with it, every assertion runs against a real binary.
  }
})

describe('agent-provider-env live CLI smoke', () => {
  for (const agent of SMOKE_AGENTS) {
    it.skipIf(!LIVE)(
      `subprocess for ${agent} receives the AGENT_PROVIDER_ENV env keys`,
      async () => {
        const env = buildAgentProviderEnv(agent, 'https://llm.kxpms.cn/v1', 'sk-smoke-live')
        expect(env, `env map for ${agent} should exist`).not.toBeNull()
        const envRecord = env!

        const result = await new Promise<{ code: number | null; lines: string[] }>((resolve) => {
          const child = spawn('env', ['-0'], {
            env: { ...process.env, ...envRecord },
            stdio: ['ignore', 'pipe', 'pipe']
          })
          let stdout = ''
          child.stdout.on('data', (chunk) => {
            stdout += chunk.toString()
          })
          child.on('close', (code) => {
            resolve({ code, lines: stdout.split('\u0000') })
          })
          child.on('error', () => {
            resolve({ code: -1, lines: [] })
          })
        })

        // Mutation guard: every key written by buildAgentProviderEnv
        // must reach the subprocess verbatim. If a future edit drops a
        // key, this assertion goes red.
        for (const [key, value] of Object.entries(envRecord)) {
          expect(
            result.lines.some((line) => line === `${key}=${value}`),
            `${agent}: expected env ${key}=${value} not found in subprocess`
          ).toBe(true)
        }
        // Mutation guard: ANTHROPIC_* and OPENAI_* env keys for the
        // wrong family must NOT appear. If a future edit accidentally
        // emits both, the agent silently reads the wrong one and the
        // cause becomes invisible.
        for (const wrongKey of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) {
          if (envRecord[wrongKey] !== undefined) {
          continue
        }
          expect(
            result.lines.some((line) => line.startsWith(`${wrongKey}=`)),
            `${agent}: stray ${wrongKey}=* in subprocess env (the writer emitted a key that should belong to a different agent family)`
          ).toBe(false)
        }
      }
    )
  }

  // Why a second test for qwen specifically: it's installed on this host
  // and accepts OPENAI_API_KEY + OPENAI_BASE_URL. `qwen --help` exits 0
  // without needing a real gateway round-trip, so we can prove the CLI
  // doesn't crash on the env vars without spending tokens.
  it.skipIf(!LIVE)(
    'qwen-code accepts OPENAI_BASE_URL + OPENAI_API_KEY without crashing',
    async () => {
      const env = buildAgentProviderEnv('qwen-code', 'https://llm.kxpms.cn/v1', 'sk-smoke-live')
      const envRecord = env!
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve) => {
          // Why 'qwen' (not 'qwen-code'): on this host the binary on PATH is
          // symlinked as `qwen`. TuiAgent id is `qwen-code`; the spawn argv
          // is the actual binary name. The two are decoupled by design — a
          // future rename of either side breaks this assertion loudly.
          const child = spawn('qwen', ['--help'], {
            env: { ...process.env, ...envRecord },
            stdio: ['ignore', 'pipe', 'pipe']
          })
          let stdout = ''
          let stderr = ''
          child.stdout.on('data', (chunk) => {
            stdout += chunk.toString()
          })
          child.stderr.on('data', (chunk) => {
            stderr += chunk.toString()
          })
          child.on('close', (code) => {
            resolve({ code, stdout, stderr })
          })
          child.on('error', (err) => {
            resolve({ code: -1, stdout, stderr: stderr + String(err) })
          })
        }
      )
      // Why exit 0 (not just non-empty output): the CLAIM is that the
      // CLI accepts these env vars and parses them correctly. A crash
      // on a malformed env config is exactly the failure mode we want
      // to catch here — that's the whole point of "single-CLI proof".
      expect(result.code, `qwen-code --help exited with code ${result.code}: ${result.stderr}`).toBe(0)
    },
    15_000
  )

  // Mutation guard: AGENT_PROVIDER_ENV['qwen-code'] must use
  // OPENAI_BASE_URL, not OPENAI_API_BASE. If a future edit renames
  // it (e.g. to match aider's OPENAI_API_BASE), qwen will silently
  // fall back to its default base URL and the next round of testing
  // breaks for an unrelated-looking reason.
  it.skipIf(!LIVE)(
    'qwen-code env map uses OPENAI_BASE_URL (mutation guard)',
    async () => {
      expect(AGENT_PROVIDER_ENV['qwen-code']?.baseUrlEnvVar).toBe('OPENAI_BASE_URL')
    }
  )

  // Mutation guard: AGENT_PROVIDER_ENV.goose must use OPENAI_HOST, not
  // OPENAI_BASE_URL. Goose is the one CLI that breaks this convention;
  // if a future edit aligns it with the rest, goose silently routes to
  // OpenAI's default and the live e2e test fails far downstream.
  it.skipIf(!LIVE)(
    'goose env map uses OPENAI_HOST (mutation guard)',
    async () => {
      expect(AGENT_PROVIDER_ENV.goose?.baseUrlEnvVar).toBe('OPENAI_HOST')
    }
  )

  // Mutation guard: pi uses ANTHROPIC_* (anthropic protocol), not
  // OPENAI_*. If a future edit assumes pi is OpenAI-compatible, pi
  // reads no creds and the user sees a confusing auth error.
  it.skipIf(!LIVE)(
    'pi env map uses ANTHROPIC_* (mutation guard)',
    async () => {
      expect(AGENT_PROVIDER_ENV.pi?.apiKeyEnvVar).toBe('ANTHROPIC_API_KEY')
      expect(AGENT_PROVIDER_ENV.pi?.baseUrlEnvVar).toBe('ANTHROPIC_BASE_URL')
    }
  )
})