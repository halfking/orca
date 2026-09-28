// What: 端到端 live smoke：拿一个用户注册表风格的 provider（含点 id、自定义 base URL、
// 自定义 model 列表）走 apply → 写到 isolated HOME 下的 system config → 起真机
// Codex / ClaudeCode / OpenCode 二进制去加载和调用。补 kaixuan-provider-preset-live-audit.md
// 与 handoff 文件明确点出的"还没证据覆盖"环节（risk 1：自定义 dotted id 走完整链路）。
//
// Why: v4 之前的 audit 全部只验到「写出来的文件 TOML/JSON 字符串长得对」。那只能
// 覆盖 writer 形状，**不**覆盖 consumer 行为——`b2cc5f8c4` 的 `env_key` 静默吞 key
// 与 `40f9210d9` 的 TOML 表头引号化都靠这次真机 smoke 才能在用户路径上发现。
//
// Why dotted id `glm-5.2`: v4 UI 的 placeholder 就是它；这正是「用户在 Orca 设置里
// 真会敲进去的 id」。Hand-off 文件明确把它作为「自定义 path 还没被真机证」的样本。
//
// Why isolated HOME: handoff 文件明文警告 — `applyCodexProvider` 走 `homedir()`，
// `applyClaudeProvider` 走 `CLAUDE_CONFIG_DIR || homedir()`，
// `applyOpenCodeProvider` 走 `XDG_CONFIG_HOME || homedir()`。**任何一个** apply 跑在
// 真用户 HOME 上都会污染 `~/.codex/config.toml` / `~/.claude/settings.json` /
// `~/.config/opencode/opencode.json`。所以这一文件强制设置三个 env var 到 mktemp 出来的
// 临时目录，apply 与 spawn 都吃同一份临时目录。
//
// 运行（opt-in）：
//   ORCA_LIVE_KAIXUAN_AUDIT=1 \
//     npx vitest run --config config/vitest.config.ts \
//       src/main/kaixuan-provider-preset-dotted-id-live.test.ts
//
// 失败分类：
//   - 「config 没有解析 / provider 没被注册 / dotted id 嵌套成子表」 → 真实缺陷，红
//   - 「HTTP / 网关错误 / auth 失败」 → 记录原因，不红（审计目标只是「写到磁盘后
//     CLI 吃不吃」，不是「真打到 LLM」）
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { applyCodexProvider } from './codex/codex-apply-provider-preset'
import { applyClaudeProvider } from './claude/claude-apply-provider-preset'
import { applyOpenCodeProvider } from './opencode/opencode-apply-provider-preset'
import { BUILT_IN_PROVIDER_IDS, type ProviderPresetDefinition } from '../shared/provider-preset-types'

// Local install of the same codex-cli version the previous audit verified against.
// Lives outside the repo so it doesn't pollute the worktree or get committed.
const CODEX_BIN = '/tmp/orca-kaixuan-audit/2026-09-29/node_modules/@openai/codex/bin/codex.js'
const CLAUDE_BIN = '/Users/xutaohuang/.local/bin/claude'
const OPENCODE_BIN = '/Users/xutaohuang/.opencode/bin/opencode'

// What: v4 UI placeholder id, dotted, plus a custom base URL pointing at the local
// kaixuan gateway (no auth) and a curated model subset (NOT the full kxpms catalog —
// a real user picks the models they actually want).
const CUSTOM_DOTTED_PROVIDER: ProviderPresetDefinition = {
  id: 'glm-5.2',
  label: 'GLM 5.2 (live-audit custom registry entry)',
  modelProviderName: 'glm-5.2',
  codexProviderName: 'GLM 5.2 (live-audit custom)',
  codexBaseUrl: 'http://127.0.0.1:8782/v1',
  claudeBaseUrl: 'http://127.0.0.1:8782',
  opencodeBaseUrl: 'http://127.0.0.1:8782/v1',
  envKeyName: 'OPENAI_API_KEY',
  opencodeModelIds: ['glm-5.2', 'gpt-5.5', 'mimo-v2.5-pro']
}

const KNOWN_IDS_FOR_THIS_REGISTRY = new Set<string>([
  ...BUILT_IN_PROVIDER_IDS,
  CUSTOM_DOTTED_PROVIDER.id
])

// What: result of a real-CLI smoke. `ok` is true iff the CLI reached the
// post-config-load phase. `outcome` classifies the failure (if any) so the
// test can fail closed on config-shape issues but stay open for network blips.
type CliSmoke = {
  binary: string
  argv: string[]
  outcome: 'config-loaded-and-call-attempted' | 'config-rejected' | 'cli-missing' | 'spawn-error'
  exitCode: number | null
  stdoutTail: string
  stderrTail: string
  configParseError?: string
}

const LIVE = process.env.ORCA_LIVE_KAIXUAN_AUDIT === '1'

// Why a real key: the local kaixuan gateway (127.0.0.1:8782) requires a valid
// bearer / x-api-key. A placeholder token is rejected with `authentication_error`
// and the CLIs then either hang or retry, masking the real question — did the
// applied config load? The key is read from the user's local env at test time;
// the test skips with a clear message when it is unset, so the file remains
// portable.
const LIVE_KEY = process.env.ACC_KAIXUAN_KEY ?? process.env.ORCA_KAIXUAN_KEY ?? ''

describe.skipIf(!LIVE)('kaixuan provider preset — custom dotted-id live e2e', () => {
  let isolatedHome: string
  let previousEnv: {
    HOME: string | undefined
    XDG_CONFIG_HOME: string | undefined
    CLAUDE_CONFIG_DIR: string | undefined
    ORCA_USER_DATA_PATH: string | undefined
    OPENAI_API_KEY: string | undefined
  }

  beforeEach(() => {
    if (LIVE_KEY.length === 0) {
      throw new Error(
        'ORCA_LIVE_KAIXUAN_AUDIT=1 is set but no gateway key is available. ' +
          'Export ACC_KAIXUAN_KEY (or ORCA_KAIXUAN_KEY) with a valid local-gateway token before running.'
      )
    }
    isolatedHome = mkdtempSync(join(tmpdir(), 'orca-kaixuan-live-'))
    previousEnv = {
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      // The codex apply path resolves its user data path from `os.homedir()`;
      // we also belt-and-suspenders it via ORCA_USER_DATA_PATH in case a future
      // call goes through a code path that reads it (see codex-home-paths.ts:54).
      ORCA_USER_DATA_PATH: process.env.ORCA_USER_DATA_PATH,
      // OpenCode's `{env:OPENAI_API_KEY}` placeholder needs this exported at
      // opencode startup; local gateway ignores the value.
      OPENAI_API_KEY: process.env.OPENAI_API_KEY
    }
    process.env.HOME = isolatedHome
    process.env.XDG_CONFIG_HOME = isolatedHome
    process.env.CLAUDE_CONFIG_DIR = join(isolatedHome, '.claude')
    process.env.ORCA_USER_DATA_PATH = join(isolatedHome, '.orca-userdata')
    process.env.OPENAI_API_KEY = LIVE_KEY
  })

  afterEach(() => {
    rmSync(isolatedHome, { recursive: true, force: true })
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  // ---- Codex ---------------------------------------------------------------

  it('Codex: writes the dotted id under a quoted table header and the live binary accepts it', () => {
    const result = applyCodexProvider(CUSTOM_DOTTED_PROVIDER, KNOWN_IDS_FOR_THIS_REGISTRY, {
      apiKey: LIVE_KEY
    })
    expect(result.error).toBeNull()
    const configPath = join(isolatedHome, '.codex', 'config.toml')
    const written = readFileSync(configPath, 'utf-8')

    // Shape — quoted header (Defect 5: `40f9210d9` quotes it because bare-key
    // TOML cannot contain a dot).
    expect(written).toContain('[model_providers."glm-5.2"]')
    // No env_key alongside an inline token (Defect 1: `b2cc5f8c4`).
    expect(written).not.toMatch(/env_key.*glm-5\.2|glm-5\.2[\s\S]{0,200}env_key/)
    // And the inline token IS there as experimental_bearer_token.
    expect(written).toContain('experimental_bearer_token = "')
    // ChatGPT auth flow off — third-party gateways do not have its scope.
    expect(written).toContain('requires_openai_auth = false')

    const smoke = runCodexSmoke(isolatedHome)
    classifyAndAssert(smoke, 'codex', written, 'call')
  }, 120_000)

  // ---- ClaudeCode ----------------------------------------------------------

  it('ClaudeCode: writes the dotted id in env.ANTHROPIC_BASE_URL and the live binary accepts it', () => {
    const result = applyClaudeProvider(CUSTOM_DOTTED_PROVIDER, {
      apiKey: LIVE_KEY
    })
    expect(result.error).toBeNull()
    const configPath = join(isolatedHome, '.claude', 'settings.json')
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8782')
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe(LIVE_KEY)
    // The dotted id is not a Claude provider table key — the apply path must
    // NOT add it to settings.json under any other shape (e.g. a stray
    // `providers` map or model override). Be precise: only env.* is allowed.
    expect(Object.keys(written).filter((k) => k !== 'env')).toEqual([])

    const smoke = runClaudeSmoke(isolatedHome)
    classifyAndAssert(smoke, 'claude', JSON.stringify(written), 'call')
  }, 120_000)

  // ---- OpenCode ------------------------------------------------------------

  it('OpenCode: registers the dotted id with a non-empty models map and the live binary lists it', () => {
    const result = applyOpenCodeProvider(CUSTOM_DOTTED_PROVIDER, KNOWN_IDS_FOR_THIS_REGISTRY, {
      apiKey: LIVE_KEY
    })
    expect(result.error).toBeNull()
    // Why `opencode/opencode.json` (not `.config/opencode/opencode.json`):
    // `resolveOpenCodeConfigDirectory` short-circuits to `$XDG_CONFIG_HOME/opencode`
    // when XDG_CONFIG_HOME is set — see src/shared/opencode-config-directory.ts:5.
    // The `.config` segment only joins when XDG_CONFIG_HOME is *unset*. Setting it
    // to isolatedHome makes the canonical path `isolatedHome/opencode/opencode.json`.
    const configPath = join(isolatedHome, 'opencode', 'opencode.json')
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))

    // Defect 3: provider without `models` is never registered. Confirm map
    // exists, keys are exactly the custom subset, and baseURL/apiKey live
    // under `options` (opencode schema requirement, not the top of the entry).
    const entry = written.provider?.['glm-5.2']
    expect(entry).toBeDefined()
    expect(entry.options.baseURL).toBe('http://127.0.0.1:8782/v1')
    expect(entry.options.apiKey).toBe(LIVE_KEY)
    const modelIds = Object.keys(entry.models ?? {})
    expect(modelIds.sort()).toEqual(['glm-5.2', 'gpt-5.5', 'mimo-v2.5-pro'])

    const smoke = runOpenCodeSmoke(isolatedHome)
    classifyAndAssert(smoke, 'opencode', JSON.stringify(written), 'list')
  }, 120_000)

  // ---- shared helpers ------------------------------------------------------

  function classifyAndAssert(
    smoke: CliSmoke,
    agent: string,
    onDiskShape: string,
    mode: 'call' | 'list'
  ): void {
    // Audit the binary's pre-call phase: any error mentioning "config",
    // "provider", or "TOML" indicates the writer produced something the
    // consumer rejects. Network/auth errors are reported but do not fail the
    // audit — the live audit's bar is "writer shape", not "LLM reachable".
    if (smoke.outcome === 'cli-missing') {
      throw new Error(
        `${agent} binary missing at ${smoke.binary}. Install @openai/codex@0.158.0 or fix the path in this test.`
      )
    }
    if (smoke.outcome === 'spawn-error') {
      throw new Error(
        [
          `${agent} spawn failed before the smoke could run:`,
          `binary: ${smoke.binary}`,
          `argv: ${smoke.argv.join(' ')}`,
          `error: ${smoke.stderrTail}`
        ].join('\n')
      )
    }
    const configRejectionSignals = [
      /model_providers/i,
      /provider not found/i,
      /toml/i,
      /unrecognized field/i,
      /unknown key/i,
      /provider name must not be empty/i,
      /settings\.json.*invalid/i,
      /config parse/i,
      /failed to load config/i
    ]
    const combined = `${smoke.stderrTail}\n${smoke.stdoutTail}`
    for (const re of configRejectionSignals) {
      if (re.test(combined)) {
        throw new Error(
          [
            `${agent} REJECTED the applied config. Config-shape signal matched: ${re}`,
            `--- on-disk shape ---`,
            onDiskShape,
            `--- ${agent} stderr (tail) ---`,
            smoke.stderrTail,
            `--- ${agent} stdout (tail) ---`,
            smoke.stdoutTail
          ].join('\n')
        )
      }
    }
    // Why the per-mode success check: codex + claude are call-mode smokes
    // (they invoke the model and the round-tripped reply should contain the
    // expected magic string). opencode's `models` subcommand is a list-mode
    // smoke (no network call) — its success criterion is that the dotted id
    // appears as a path prefix in the output (`glm-5.2/<model-id>`).
    if (smoke.outcome === 'config-loaded-and-call-attempted') {
      if (mode === 'call') {
        const successMarker = 'ORCA_KAIXUAN_DOTTED_OK'
        if (!smoke.stdoutTail.includes(successMarker) && !smoke.stderrTail.includes(successMarker)) {
          throw new Error(
            [
              `${agent} did not return the expected reply token "${successMarker}".`,
              `Either the writer-encoded provider was not used, or the call did not`,
              `complete. exitCode=${smoke.exitCode} — see streams below.`,
              `--- ${agent} stdout (tail) ---`,
              smoke.stdoutTail,
              `--- ${agent} stderr (tail) ---`,
              smoke.stderrTail
            ].join('\n')
          )
        }
      } else {
        const listMarker = 'glm-5.2/'
        if (!smoke.stdoutTail.includes(listMarker)) {
          throw new Error(
            [
              `${agent} did not list the dotted-id provider in the expected shape.`,
              `Expected to find "glm-5.2/<model-id>" lines in stdout, got:`,
              smoke.stdoutTail
            ].join('\n')
          )
        }
      }
    }
    // Soft-pass: write the call outcome so a human can read it from the test
    // log even when the network blip is non-fatal.
    // eslint-disable-next-line no-console
    console.log(
      `[kaixuan-live] ${agent}: outcome=${smoke.outcome} exit=${smoke.exitCode ?? 'null'}`
    )
  }
})

// ---- CLI smoke drivers -----------------------------------------------------

function runCodexSmoke(isolatedHome: string): CliSmoke {
  // `codex exec` is the cheapest end-to-end probe: it loads the config,
  // resolves the model_provider, picks the model, then either calls or fails
  // with a network/auth error. A config-shape failure surfaces *before* the
  // network call (e.g. "model_providers.glm-5: provider name must not be
  // empty" for the unquoted-header bug, "Missing environment variable:
  // OPENAI_API_KEY" for the env_key clash).
  //
  // Why `gpt-5.5` not `glm-5.2`: the local gateway (127.0.0.1:8782) lists
  // glm-5.2 in `/v1/models` and serves it via `/v1/messages` and
  // `/v1/chat/completions`, but answers `503 No available provider` on
  // `/v1/responses` (the path codex uses with `wire_api = "responses"`).
  // `gpt-5.5` is the only catalog model that is actually routable through
  // *all three* of the local gateway's API paths. Recording this as a
  // catalog-routing gap, not a writer-shape gap, in the audit doc.
  return spawnAndCapture({
    binary: CODEX_BIN,
    argv: [
      'exec',
      '--skip-git-repo-check',
      '--model',
      'gpt-5.5',
      'Reply with exactly: ORCA_KAIXUAN_DOTTED_OK'
    ],
    env: { HOME: isolatedHome, CODEX_HOME: join(isolatedHome, '.codex') },
    timeoutMs: 90_000
  })
}

function runClaudeSmoke(isolatedHome: string): CliSmoke {
  // `claude -p` non-interactive print mode — the same recipe the original
  // audit doc used to verify the path end-to-end. Why no `--bare`: in
  // isolated `CLAUDE_CONFIG_DIR` with `ANTHROPIC_AUTH_TOKEN` set, `--bare`
  // made codex-cli spend its 90s budget retrying the gateway with
  // different credentials; without it the call returns in ~6s.
  return spawnAndCapture({
    binary: CLAUDE_BIN,
    argv: ['-p', 'Reply with exactly: ORCA_KAIXUAN_DOTTED_OK'],
    env: { HOME: isolatedHome, CLAUDE_CONFIG_DIR: join(isolatedHome, '.claude') },
    timeoutMs: 90_000
  })
}

function runOpenCodeSmoke(isolatedHome: string): CliSmoke {
  // `opencode models <id>` lists the provider + its model keys. The cheapest
  // way to confirm the dotted id is registered AND has a non-empty models
  // map (Defect 3). No network call is made.
  //
  // Success criterion: the output contains the dotted id as a path
  // prefix (`<dotted-id>/<model-id>`), NOT the ORCA_KAIXUAN_DOTTED_OK
  // reply token — `opencode models` does not initiate a model call.
  return spawnAndCapture({
    binary: OPENCODE_BIN,
    argv: ['models', 'glm-5.2'],
    env: { HOME: isolatedHome, XDG_CONFIG_HOME: isolatedHome },
    timeoutMs: 20_000
  })
}

function spawnAndCapture({
  binary,
  argv,
  env,
  timeoutMs = 45_000
}: {
  binary: string
  argv: string[]
  env: Record<string, string>
  timeoutMs?: number
}): CliSmoke {
  const fileExists = existsSync(binary)
  if (!fileExists) {
    return {
      binary,
      argv,
      outcome: 'cli-missing',
      exitCode: null,
      stdoutTail: '',
      stderrTail: ''
    }
  }
  const result = spawnSync(binary, argv, {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: timeoutMs
  })
  const stderrTail = (result.stderr ?? '').slice(-2000)
  const stdoutTail = (result.stdout ?? '').slice(-2000)
  const errored = result.error
  if (errored) {
    return {
      binary,
      argv,
      outcome: 'spawn-error',
      exitCode: null,
      stdoutTail,
      stderrTail: errored.message
    }
  }
  // Spawn returned without throwing — the binary at least started. Whether
  // the config loaded correctly is determined by classifyAndAssert scanning
  // the output for config-shape rejection signals.
  return {
    binary,
    argv,
    outcome: 'config-loaded-and-call-attempted',
    exitCode: result.status,
    stdoutTail,
    stderrTail
  }
}

