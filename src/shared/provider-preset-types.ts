// What: 供应商预置（provider preset）共享类型。给 Codex / ClaudeCode / OpenCode
// 三类 agent 各加 OpenAI 兼容厂商的预设：内置两个 kaixuan 端点（local / kxpms），
// 以及用户可在 Orca UI 里新增 / 编辑 / 删除的任意 Custom 端点（GLM / Kimi / Groq 等）。
//
// Why: Orca 现有架构不暴露第三方 provider 切换入口（Codex 走 config-mirror 单向
// 镜像用户 ~/.codex/config.toml，ClaudeCode 走 ~/.claude/settings.json 的 env，
// OpenCode 走 ~/.config/opencode/opencode.json）。这里新发明 "preset" 概念，
// IPC handler 负责把内置或自定义 preset 持久化到对应 agent 的 system config。
//
// Why both built-in and custom share the same shape: the apply functions
// (codex-apply-provider-preset.ts, claude-apply-provider-preset.ts,
// opencode-apply-provider-preset.ts) need a single definition shape to write
// the model_providers table / env entry / provider map. Custom entries reuse
// the same on-disk schema — the difference is only that custom ones come from
// the user's registry (GlobalSettings.customProviders) while built-in ones
// come from KAIXUAN_PRESETS below.

export type KaixuanPresetId = 'kaixuan-local' | 'kaixuan-kxpms'

/** All preset ids the renderer ships by default. Used to filter out Orca-owned
 *  blocks from system config without accidentally clobbering the user's own
 *  [model_providers.<user-id>] entries.
 *
 *  Why a string Set rather than a literal union: custom providers share the
 *  same registry as built-ins for strip / rewrite logic, so the filter has to
 *  accept user-defined ids at runtime. */
export const BUILT_IN_PROVIDER_IDS: ReadonlySet<string> = new Set<KaixuanPresetId>([
  'kaixuan-local',
  'kaixuan-kxpms'
])

export type ProviderPresetAgentId = 'codex' | 'claude' | 'opencode'

export type ProviderPresetDefinition = {
  /** Unique id within the registry.
   *  - Built-in: 'kaixuan-local' / 'kaixuan-kxpms'.
   *  - Custom: any user-chosen string. The apply functions use this verbatim
   *    as the Codex [model_providers.<id>] table key and the OpenCode
   *    provider.<id> map key, so it must satisfy both TOML table-header
   *    and JSON object-key rules (no '.', no leading whitespace, etc.).
   *    Validation lives in renderer form validation; the main process trusts
   *    whatever the renderer hands it. */
  id: string
  /** 人类可读名称（在 AccountsPane section 标题里出现） */
  label: string
  /** Codex 用的 model_provider 字段值，写入 `model_provider = "<modelProviderName>"` */
  modelProviderName: string
  /** Codex 端 [model_providers.<id>] 表里的 name 字段 */
  codexProviderName: string
  /** Codex config.toml 的 base_url 值（含 /v1 后缀） */
  codexBaseUrl: string
  /** ClaudeCode env.ANTHROPIC_BASE_URL 值（不含 /v1） */
  claudeBaseUrl: string
  /** OpenCode provider.<id>.baseURL 值（含 /v1 后缀） */
  opencodeBaseUrl: string
  /** OpenCode provider.<id>.apiKey 字段从环境变量读取时的变量名 */
  envKeyName: string
  /**
   * OpenCode provider.<id>.models 的 key 列表。
   *
   * Why this is mandatory (verified 2026-09-28 against opencode 1.14.33):
   * a provider entry without `models` is NOT registered — `opencode models <id>`
   * answers `Provider not found: <id>`. So a config carrying only
   * `{npm, name, options}` parses fine and still leaves the agent unusable.
   */
  opencodeModelIds: readonly string[]
}

/**
 * 两个 preset 共用的 model 目录。
 *
 * 每一项都对照两个网关的实时 `/v1/models` 核对过（2026-09-28）：
 * kxpms 返回 601 个 model，local 返回 668 个，下表 10 项在两边都存在。
 * 上游的 minimax 线是 `minimax-m2.7-highspeed` 之类的命名，不存在
 * `minimax-m2.7-quickspeed` —— 早先的清单里那一项是从别处抄来的，
 * 在两边都 404，会让 opencode 列出一个点进去就报错的 model。
 * 新增条目前请先跑 `src/shared/provider-preset-model-catalog.live.test.ts`
 * （默认 skip，用 ORCA_LIVE_GATEWAY_TESTS=1 显式开启）复核。
 */
const KAIXUAN_MODEL_IDS: readonly string[] = [
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'glm-5.1',
  'glm-5.2',
  'gpt-5.4',
  'gpt-5.5',
  'mimo-v2.5',
  'mimo-v2.5-pro',
  'minimax-m2.7',
  'minimax-m3'
]

/** 两个 kaixuan preset 都在这里 hard-code，作为 SSOT。 */
export const KAIXUAN_PRESETS: Readonly<Record<KaixuanPresetId, ProviderPresetDefinition>> = {
  'kaixuan-local': {
    id: 'kaixuan-local',
    label: 'Kaixuan Local (127.0.0.1:8782)',
    modelProviderName: 'kaixuan-local',
    codexProviderName: 'Kaixuan Local (127.0.0.1:8782)',
    codexBaseUrl: 'http://127.0.0.1:8782/v1',
    claudeBaseUrl: 'http://127.0.0.1:8782',
    opencodeBaseUrl: 'http://127.0.0.1:8782/v1',
    envKeyName: 'OPENAI_API_KEY',
    opencodeModelIds: KAIXUAN_MODEL_IDS
  },
  'kaixuan-kxpms': {
    id: 'kaixuan-kxpms',
    label: 'Kaixuan KXPMS (llm.kxpms.cn)',
    modelProviderName: 'kaixuan-kxpms',
    codexProviderName: 'Kaixuan KXPMS (llm.kxpms.cn)',
    codexBaseUrl: 'https://llm.kxpms.cn/v1',
    claudeBaseUrl: 'https://llm.kxpms.cn',
    opencodeBaseUrl: 'https://llm.kxpms.cn/v1',
    envKeyName: 'OPENAI_API_KEY',
    opencodeModelIds: KAIXUAN_MODEL_IDS
  }
}

export const KAIXUAN_PRESET_ORDER: readonly KaixuanPresetId[] = ['kaixuan-local', 'kaixuan-kxpms']

/** A preset id is interpolated into a TOML table header, a TOML double-quoted
 *  string value, a JSON object key and a regex alternation (the apply functions
 *  run every id through escapeRegex). Only characters that would terminate or
 *  split one of those constructs are rejected. */
const INTERPOLATABLE_PROVIDER_ID_PATTERN = /^[A-Za-z0-9_.|@:+-]+$/u
const SAFE_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** True when `id` can be embedded in a TOML header / quoted value, a JSON key
 *  and a regex alternation without corrupting any of them.
 *
 *  What it does NOT cover: `[model_providers.<id>]` is written unquoted, so an
 *  id containing `.` is read by TOML as a nested table and Codex then cannot
 *  resolve `model_providers["glm-5.2"]`. OpenCode and the registry itself are
 *  fine with dots. Fixing that means quoting the table header in
 *  codex-apply-provider-preset.ts — tracked as a known gap, not guarded here. */
export function isProviderPresetIdInterpolationSafe(id: string): boolean {
  return INTERPOLATABLE_PROVIDER_ID_PATTERN.test(id)
}

/** True when `name` is a portable environment variable name — it is written
 *  straight into `env_key = "<name>"` and into the ClaudeCode env block. */
export function isSafeEnvKeyName(name: string): boolean {
  return SAFE_ENV_KEY_PATTERN.test(name)
}

/** IPC handler 入参：apply 一个 preset 到指定 agent 时使用。`provider` 是完整
 *  定义（renderer 从 built-in + 自定义 registry 解析后传入），handler 不需要
 *  知道 provider 是 built-in 还是自定义。 */
export type ProviderPresetApplyRequest = {
  agentId: ProviderPresetAgentId
  provider: ProviderPresetDefinition | null
  /**
   * 可选：用 env key 名（如 OPENAI_API_KEY）直接指定一个值，Orca 写到目标 agent 的
   * config 时直接嵌入。不传则保留 agent 原有的 env_key / API key 行为。
   */
  apiKey?: string | null
}

/** IPC handler 出参。 */
export type ProviderPresetApplyResult = {
  agentId: ProviderPresetAgentId
  /** The provider id that was applied (built-in or custom); null when cleared. */
  providerId: string | null
  /** 写入的目标配置文件绝对路径；providerId 为 null 时表示清空回归系统默认。 */
  configPath: string
  /** 成功时为 null；失败时是错误描述。 */
  error: string | null
}

/** Shared `window.api.providerPresets` 接口——preload 暴露。 */
export type ProviderPresetApi = {
  applyCodex: (args: {
    provider: ProviderPresetDefinition | null
    apiKey?: string | null
  }) => Promise<ProviderPresetApplyResult>
  applyClaude: (args: {
    provider: ProviderPresetDefinition | null
    apiKey?: string | null
  }) => Promise<ProviderPresetApplyResult>
  applyOpenCode: (args: {
    provider: ProviderPresetDefinition | null
    apiKey?: string | null
  }) => Promise<ProviderPresetApplyResult>
  /**
   * 当前生效的 provider id（从对应 agent 的 system config 中读出）。
   * `knownProviders` 是 renderer 已知的 built-in + custom 列表，handler 用来
   * 反查 baseUrl 匹配到 provider id。如果 system config 里有一个未在
   * knownProviders 中出现的 provider，handler 返回 providerId 为 null（不
   * 自动 fallback 到任何 built-in）。
   */
  getCurrent: (args: {
    agentId: ProviderPresetAgentId
    knownProviders: readonly ProviderPresetDefinition[]
  }) => Promise<{
    providerId: string | null
    configPath: string
  }>
}
