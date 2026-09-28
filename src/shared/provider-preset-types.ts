// What: 供应商预置（provider preset）共享类型。给 Codex / ClaudeCode / OpenCode
// 三类 agent 各加两个 kaixuan 端点（local / kxpms）的内置预设，
// 让用户能在 Orca UI 一键启用/关闭。
//
// Why: Orca 现有架构不暴露第三方 provider 切换入口（Codex 走 config-mirror 单向
// 镜像用户 ~/.codex/config.toml，ClaudeCode 走 ~/.claude/settings.json 的 env，
// OpenCode 走 ~/.config/opencode/opencode.json）。这里新发明 "preset" 概念，
// IPC handler 负责把 kaixuan preset 持久化到对应 agent 的 system config。

export type KaixuanPresetId = 'kaixuan-local' | 'kaixuan-kxpms'

export type ProviderPresetAgentId = 'codex' | 'claude' | 'opencode'

export type KaixuanPresetDefinition = {
  /** preset ID，对应 GlobalSettings.<agent>KaixuanPreset 的取值 */
  id: KaixuanPresetId
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

/** 两个 preset 共用的 model 目录。取自用户已在生产验证的 kaixuan 模型清单。 */
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
  'minimax-m2.7-quickspeed',
  'minimax-m3'
]

/** 两个 kaixuan preset 都在这里 hard-code，作为 SSOT。 */
export const KAIXUAN_PRESETS: Readonly<Record<KaixuanPresetId, KaixuanPresetDefinition>> = {
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

/** IPC handler 入参：apply 一个 preset 到指定 agent 时使用。 */
export type ProviderPresetApplyRequest = {
  agentId: ProviderPresetAgentId
  presetId: KaixuanPresetId | null
  /**
   * 可选：用 env key 名（如 OPENAI_API_KEY）直接指定一个值，Orca 写到目标 agent 的
   * config 时直接嵌入。不传则保留 agent 原有的 env_key / API key 行为。
   */
  apiKey?: string | null
}

/** IPC handler 出参。 */
export type ProviderPresetApplyResult = {
  agentId: ProviderPresetAgentId
  presetId: KaixuanPresetId | null
  /** 写入的目标配置文件绝对路径；presetId 为 null 时表示清空回归系统默认。 */
  configPath: string
  /** 成功时为 null；失败时是错误描述。 */
  error: string | null
}

/** Shared `window.api.providerPresets` 接口——preload 暴露。 */
export type ProviderPresetApi = {
  applyCodex: (args: {
    presetId: KaixuanPresetId | null
    apiKey?: string | null
  }) => Promise<ProviderPresetApplyResult>
  applyClaude: (args: {
    presetId: KaixuanPresetId | null
    apiKey?: string | null
  }) => Promise<ProviderPresetApplyResult>
  applyOpenCode: (args: {
    presetId: KaixuanPresetId | null
    apiKey?: string | null
  }) => Promise<ProviderPresetApplyResult>
  /** 当前生效的 preset id（从对应 agent 的 system config 中读出）。 */
  getCurrent: (args: { agentId: ProviderPresetAgentId }) => Promise<{
    presetId: KaixuanPresetId | null
    configPath: string
  }>
}
