# 并行任务编排：隔离、同步、审计、合并与调度路径可见性

本文回答一个具体问题：**在 Orca 上并行推进多个任务，怎样让它们互不干扰、同步推进、各自独立审计与测试、最后安全合并，并且让每一条调度路径都可查。**

所有结论都基于本仓库代码与本机 `orca` CLI 实测（`orca` 1.4.197，`agent-context` 报告 237 条命令）。命令与文件证据见文末附录。

---

## 0. 结论摘要

**Orca 上游已经具备大半机制底座**：Run / Task / Dispatch 三级生命周期、git worktree 级放置、`--agent` + `--model` + `--effort` 的每 worker 模型路由、`--deps` 依赖 DAG、`gate-create` 决策门禁、stale-base 漂移保护。**需求 R1（隔离）、R2（同步）、R5（模型路由）不需要新造轮子。**

**三个真实缺口**：

| 缺口                           | 性质                                         | 证据                                             |
| ------------------------------ | -------------------------------------------- | ------------------------------------------------ |
| 审计 / 测试角色无原生约束      | 编排层没有 verdict、reviewer、merge 任何原语 | 237 条命令中无 merge/audit/verdict 动词          |
| 合并无原语、无门禁             | 并行推进的终点（合并）完全没有被建模         | 同上；仅有 dispatch 期 stale-base 保护           |
| 调度路径无单一视图、无历史账本 | 状态是"当前快照"，不是"决策路径"             | DB 无事件表；`worker-start` 收据只在调用瞬间返回 |

**方案分五层**，其中只有 L3（可见性）与 L4（合并）需要新建：

```
L0 规程层  Task spec 契约 + 角色模型矩阵 + 合并协议      —— 文档即代码
L1 编排层  run-create / task-create --deps / worker-start 并行波   —— 现有 CLI
L2 门禁层  gate-create / gate-resolve 阻断波次推进                —— 现有 CLI
L3 可见性层 调度账本（append-only）+ 单命令调度视图 + 写集冲突分析   —— 需新建
L4 合并层  合并协议 + 合并脚本（rebase → 回归 → 合入 → 冲突）      —— 需新建
```

---

## 1. 需求拆解

把原始需求拆成六条原子需求，每条给出**可验收判据**（不满足判据就不算达成）：

| #   | 原子需求                   | 可验收判据                                                                                                                                   |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 多个任务并行推进时互不干扰 | 每个并行任务有独立工作区；写集（will-edit files）两两不交或已知重叠；共享副作用（端口/容器/DB）被显式分配                                    |
| R2  | 同步推进                   | 任务之间用 `--deps` 建模；波次边界显式；"谁在等谁"可枚举，无隐藏阻塞                                                                         |
| R3  | 分别的审计与测试           | 审计与测试是**独立 Dispatch**，独立上下文、独立模型；审计者对实现分支**只读**；每个任务产出一条机器可判定的 verdict                          |
| R4  | 合并                       | 合并顺序由写集重叠度与 verdict 决定；合并前 rebase 到最新基线；合并后跑回归；冲突有明确归属人                                                |
| R5  | 不同角色用不同模型         | 角色→(agent, model, effort) 矩阵事先声明，落进调度记录；实际生效值以 `launch.effective` 为准，不以请求参数为准                               |
| R6  | 所有调度路径可见           | 从 Run 到最终合并的每一次调度决策可**逐条枚举**，含：谁派谁、什么角色、什么模型、放哪个 worktree、基线是什么、当前状态、下一步命令、证据出处 |

**R6 的关键区分**：状态 ≠ 路径。Orca 现在能回答"现在到哪了"（状态），但回答不了"为什么是这个模型/为什么放这个 worktree/谁先合谁后合"（路径）。后者才是合并与复盘真正需要的。

---

## 2. 现状盘点

### 2.1 已经有的（不要重造）

| 需求        | Orca 机制                                                                                                                       | 证据                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| R1 隔离     | `--worktree new-child` / `new-top-level` / `current` / `<selector>`，每 worker 独立 git worktree 与终端                         | `orca orchestration worker-start --help`；`src/main/runtime/rpc/methods/orchestration/worker/worker-worktree-creation.ts` |
| R2 同步     | `--deps <json_array>` 依赖；Task 状态机 `pending/ready/dispatched/completed/failed/blocked/circuit_broken`；`task-list --ready` | `db/lifecycle-transition.ts:67,81`；`worker/task-deps-argument.ts`                                                        |
| R2 门禁     | `gate-create` / `gate-resolve` / `gate-list`，按 Task 阻断                                                                      | `rpc/methods/orchestration/gates/gates.ts`                                                                                |
| R5 模型路由 | `--agent claude\|codex\|cursor\|antigravity\|muse\|zcode\|opencode\|opencode2` + `--model <id>` + `--effort <level>`            | `worker/worker-launch-preferences.ts`                                                                                     |
| R2 漂移     | 基线落后 > 20 commit 拒绝派发；spec 内 `allow-stale-base: true` 可覆盖                                                          | `coordinator-stale-base-flag.ts:4,6`；`coordinator-task-dispatch.ts:82-91`                                                |
| 状态可查    | `run-show` / `task-list` / `dispatch-show` / `worker-list` / `worker-show` / `gate-list`，均可 `--json`                         | `orca orchestration --help`                                                                                               |
| 存活判据    | `live` / `unverifiable` / `exited` 三态；`projection.attention` + 字面 `projection.nextAction` argv                             | `worker/worker-list-projection.ts`                                                                                        |

**记录能力的底子已经有了**：`worker_dispatches` 表存 `start_options`(JSON)、`effects`(JSON)、`residual_resources`(JSON)、`stage`、`worktree_id`、`agent_terminal_handle`（`db/schema/create-core-tables-sql.ts:144-162`）。也就是说**每次调度的原始参数已经落库**——只是没有任何命令把它们按"路径"呈现出来。这是 L3 成本低的原因。

### 2.2 缺的

1. **没有 merge / audit / verdict / review 任何原语**。`orca agent-context --json` 全量扫描 237 条命令，与 merge/audit/verdict 相关的只有 `worktree rm` 和一条在说明里提到 review 的 `orchestration send`。合并这件事在上游编排模型里根本不存在——Run 的终点是"所有 Dispatch 结算"，不是"变更合入基线"。
2. **审计没有独立性约束**。上游 `coordinator-loop.md` 只写了"review-only `worker_done` 授权综合发现，不授权协调者改文件"，这是一条**纪律**，不是机制。
3. **没有历史事件流**。DB 里有当前状态快照与 `mutation_receipts`，但没有 append-only 的调度事件表。
4. **没有写集冲突分析**。`worker_done --files-modified` 提供了原料，但没人计算任务两两之间的文件重叠，也就没人据此决定合并顺序。

### 2.3 同生态已有组件：`Orca-Orchestration`（`orca-dag`）

本机 `~/workspace/ai/orca-orchestration` 存在一个独立项目 **Orca-Orchestration**，它**不是** Orca 上游的一部分，而是包在 `orca` CLI 外面的第三块：

| 它已做                   | 实现方式                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------- |
| DAG 实时可视化           | 轮询 `task-list --json`，dagre 布局 + React Flow 渲染                               |
| 每节点选 harness / model | `server/src/config.ts` 存 `.orca-dag.config.json`（Orca 的 task 没有 harness 字段） |
| 自驱动 coordinator       | 找出所有 `ready` 任务，按并发上限并行 `worker-start`，`worker_done` 后自动回收      |

它证明了一件重要的事：**Orca 是故意不做调度器的**（官方 skill 原话：_"Agents still choose placement and concurrency; Orca does not schedule workers."_）。所以 DAG 循环放在上层是符合上游设计的，不是绕路。

但它**没有**覆盖本文的三个缺口——源码里搜 `audit|verdict|merge|files-modified` 只命中 `saveConfig` 的对象合并和一处 `legacy` 审计墓碑注释：

- 无审计 verdict 契约，节点干完就是干完了；
- 无合并阶段，合并不是 DAG 里的一个节点类型；
- 无写集记录，因此也没有重叠矩阵和合并顺序。

**结论：不重复造 DAG 可视化与并行派发。** 本方案的价值集中在它没有的三件事——角色模型矩阵、审计/合并协议、调度路径账本，并且以 CLI 侧 companion 的形态与它共存（它画图，本工具给出可复制的 argv 与合并顺序）。

### 2.4 一个容易被忽略的上游约束

`--model` / `--effort` **只对 claude / codex / cursor / antigravity / muse 生效**，opencode 与 zcode 拒绝 `--model`，跑自己 config 里的模型；`--effort` 必须配 `--model`，且两者都不能与 `--terminal` 组合。这意味着**模型矩阵不能写成"角色 → 任意模型"的自由映射**，必须按 agent 分支声明。上游另有纪律：只在用户点名模型时才传 `--model`，否则继承用户默认——矩阵要显式声明才传。

---

## 3. 失效模式：并行为什么会不可靠

方案必须逐条对上这些失效模式，否则只是"看起来有流程"。

| #   | 失效模式                                        | 后果                                                | 防线                                                                       |
| --- | ----------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------- |
| F1  | 两个 worker 共用同一个 worktree                 | 编辑交错、diff 混合、丢改动                         | 一任务一 worktree（`new-child`）                                           |
| F2  | 各自 worktree 但共享依赖目录 / 端口 / 容器 / DB | 测试互相污染，绿红交替                              | spec 里显式分配端口与外部资源名；并行波次必须先定资源表                    |
| F3  | 各自 worktree 但基线不同                        | 合并冲突，甚至静默错误                              | `--base-branch` 显式钉基线；落后 > 20 commit 拒绝派发                      |
| F4  | 写集重叠但无人知晓                              | 合并顺序随机选，冲突成本集中爆发                    | 从 `worker_done --files-modified` 算两两写集交集，产出合并顺序             |
| F5  | 审计者就是编码者（或共享上下文）                | 自己盖章，审计退化为复读                            | 审计是**另一个 worktree / 另一个 Dispatch** 的只读角色，模型与编码者不同档 |
| F6  | 测试由编码者自己写自己验                        | 测试随实现漂移，等价于没测                          | 测试角色独立 Dispatch，允许低成本模型；测试必须先红后绿                    |
| F7  | 模型路由隐式（协调者随手挑）                    | 成本不可控、质量不可解释、无法复盘                  | 角色矩阵事先声明，落进调度记录，事后按 `launch.effective` 审计             |
| F8  | 调度路径不可见                                  | 出问题只能靠翻 transcript；无法回答"为什么它这么跑" | 调度账本 + 单命令视图                                                      |

---

## 4. 方案设计

### 4.1 四条原则

1. **隔离靠机制，不靠自觉**：并行任务默认分配独立 worktree；写集在 spec 里声明，冲突在派发前就能算出来。
2. **同步靠 DAG + 门禁，不靠轮询等待**：依赖用 `--deps` 声明，跨波次推进用 gate 阻断，`--ready` 是唯一事实来源。
3. **编码 / 测试 / 审计三分角色**：三种角色三种模型档位，互不复用上下文，审计者对实现分支只读。
4. **调度路径是一等公民数据**：每一次调度决策都必须落成可枚举记录，合并顺序、复盘、成本归因都从这份记录推导，而不是从记忆推导。

### 4.2 角色—模型矩阵

模型档位（`T`=最强推理 / `S`=最强编码 / `C`=低成本），agent 限定在上游真正支持 `--model` 的集合内：

| 角色          | agent                | model | effort | 写权限               | 放置                        | 说明                                 |
| ------------- | -------------------- | ----- | ------ | -------------------- | --------------------------- | ------------------------------------ |
| `coordinator` | 用户当前会话         | —     | —      | 只编排，不改实现文件 | `current`                   | 不做实现                             |
| `implementer` | codex                | S     | high   | 可写自己的 worktree  | `new-child`                 | 主力编码档                           |
| `test-author` | claude               | C     | medium | 只写测试文件         | `new-child`                 | 低价档，允许改测试不改实现           |
| `auditor`     | claude               | T     | high   | **只读**             | `new-child`（检出实现分支） | 独立上下文，禁止修改                 |
| `merger`      | coordinator 执行协议 | —     | —      | 在基线 worktree 合并 | `current`                   | 合并是确定性动作，不交给模型自由发挥 |

**约束**：上游纪律要求"用户没点名模型就不传 `--model`"。所以矩阵是**声明式**的——先由用户/项目确认这张表，确认后才在派发时显式传 `--model/--effort`；未确认时继承 agent 默认，绝不静默挑一个。

### 4.3 隔离模型

```
base worktree (main)                     ← 协调者 + 合并者，唯一允许合入的地方
├── new-child  task-1/<slug>             ← implementer-A，只写自己的写集
├── new-child  task-2/<slug>             ← implementer-B，写集与 A 不交
├── new-child  task-2/audit              ← auditor-B，只读检出 task-2 分支
└── new-child  task-1/audit              ← auditor-A，只读检出 task-1 分支
```

每条 Task spec 的强制字段（扩上游 Task-spec 契约）：

- **Target**：组件/文件范围
- **Change**：要产出的具体结果
- **Constraints**：不变量、兼容边界、禁改区
- **Ownership**：本任务可写的文件清单（写集）+ 外部资源分配（端口/容器/DB 名）
- **Baseline**：`--base-branch` 的 ref
- **Observable acceptance**：可机器判定的验收（命令 + 期望输出）
- **Portability note**（仅测试角色）：必须先看到红再看到绿

### 4.4 DAG 模板（五波）

```text
wave 0  plan          coordinator 拆任务、分配写集与资源、定角色模型矩阵
wave 1  implement     implementer × N   并行，deps=[]        （new-child，互不干扰）
wave 2  self-test     test-author × N    deps=[impl]         低价档，只写测试
wave 3  audit         auditor × N        deps=[impl, test]   只读，产出 verdict
wave 4  merge         merger             deps=[audit]        串行，按写集重叠度排序
```

命令骨架：

```text
orca orchestration run-create --objective "<目标>" --json

# wave 1
orca orchestration task-create --spec "<impl spec>" --task-title "impl-1" --deps '[]' --json
orca orchestration worker-start --task <impl_task> \
  --worktree new-child --name task-1 --base-branch main \
  --agent codex --model <S> --effort high --json

# wave 3 审计（独立 worktree，只读检出实现分支）
orca orchestration task-create --spec "<audit spec>" --task-title "audit-1" \
  --deps '["<impl_task>","<test_task>"]' --json
orca orchestration worker-start --task <audit_task> \
  --worktree new-child --name task-1-audit --base-branch <impl branch> \
  --agent claude --model <T> --effort high --json

# 门禁：审计未 pass 则合并波次不启动
orca orchestration gate-create --task <merge_task> \
  --question "audit-1 verdict = pass ?" --options '["pass","fail"]' --json
```

### 4.5 审计协议（verdict 契约）

审计 worker 的 `worker_done` 必须给出机器可判定的结论，而不是散文：

```
verdict: pass | pass_with_findings | fail
findings: [{file, line, severity, evidence}]   每条含 file:line、严重级、可复现证据
regression: {command, result}                  跑了什么命令，实际输出是什么
reportPath: <报告路径>
```

`blockers` 不单独成字段：阻断项就是 `findings` 里 `severity: "blocker"` 的那些，避免同一件事有两个真相来源。

- `fail` → 该 Task 的 merge Task 被 gate 阻断，走修复 → 重审（`--retry-of <dispatch_id>`，重跑时必须重复原 worktree/agent 选择，不继承放置）。
- `pass_with_findings` → 归入"下一 owner"清单（上游 `coordinator-loop.md` 明确：review-only 的 `worker_done` 只授权综合发现，不授权协调者改文件；修复要么派工，要么明确交给用户）。
- **审计者禁止修改实现文件**——发现问题的动作是产出 finding，不是自己修。
- **`regression` 是"分别的测试"落地的地方**：verdict 必须附带跑过的命令和它的实际输出。`result` 允许是失败的——那正是 `fail` verdict 该有的样子——但必须存在。**没有 regression 的 verdict 是关于"测过了"的声明，不是证据。**

### 4.6 合并协议

1. **收集**：所有 Task 的 `worker_done --files-modified` → 写集。
2. **排序**：计算写集两两交集 → 重叠度矩阵 → 决定合并顺序（重叠少的先合，把冲突面压到最小），冲突对单独走人工。
3. **前置校验**：verdict 必须 `pass` 或 `pass_with_findings`；gate 必须 resolved。
4. **rebase**：每个实现分支 rebase 到**当前**基线（不是派发时的基线）。Orca 的 stale-base 阈值 20 只保护派发期，合并期必须重新校验。
5. **合入 + 回归**：每合一个跑一次受影响测试；全量回归在最后一个。
6. **归属**：冲突不自动解。冲突落到明确的 owner（通常是该 Task 的 implementer，走 `--retry-of` 或新 Task）。

### 4.7 调度路径可见性（L3，本方案的核心新增）

**调度账本（append-only）**：每个 Run 一份 JSONL，追加而非覆盖，每条是一个调度决策：

```json
{
  "ts": "...",
  "wave": 3,
  "task": "task_...",
  "dispatch": "task_...",
  "role": "auditor",
  "agent": "claude",
  "model": "...",
  "effort": "high",
  "placement": { "worktree": "task-1-audit", "base": "feature/task-1", "isolation": "worktree" },
  "state": "ready",
  "stage": "accepted",
  "liveness": "live",
  "next_action": ["orca", "orchestration", "worker-show", "--dispatch", "task_...", "--json"],
  "evidence": { "files_modified": ["src/a.ts"], "report_path": "..." },
  "verdict": null,
  "gate": null
}
```

来源全部是现有 CLI 的 `--json` 收据，不新增运行时状态：

- `worker-start --json` 收据（含 `start_options` 等价信息、`effects`、`failedStage`、`recovery`）
- `worker-list --json`（`projection.liveness` / `projection.attention` / `projection.nextAction`）
- `gate-create/gate-resolve --json`
- `worker_done` 投递里的 `--files-modified` / `--report-path` / `--outcome`

**单命令调度视图**：一条命令回答四个问题——

1. **现在到哪了**：Run → Task → Dispatch 树，每个节点带状态、角色、模型、放置、存活。
2. **谁在等谁**：DAG 依赖边 + 未满足的 gate。
3. **现在能做什么**：把每个"现在可执行"的步骤还原成可直接粘贴的 argv。
4. **合并没有风险吗**：写集重叠矩阵、verdict 汇总、建议合并顺序、冲突对。

这条视图同时是**审计工具**：R6 的"路径可见"与 R4 的"合并决策"共用同一份数据，不存在两套真相。

#### 4.7.1 已实现：`config/scripts/orchestration-schedule-ledger.mjs`

一个零依赖 Node ESM 脚本，两个子命令：

```text
# 记录：单条或批量（每行一条 JSON）
node config/scripts/orchestration-schedule-ledger.mjs record --run <run_id> \
  --entry '{"task":"impl_a","event":"worker-start","role":"implementer","agent":"codex",
            "model":"gpt-5.5","effort":"high",
            "placement":{"worktree":"task-a","base":"main"},"state":"dispatched"}'

# 查看：一条命令回答四个问题
node config/scripts/orchestration-schedule-ledger.mjs view --ledger <path>
node config/scripts/orchestration-schedule-ledger.mjs view --ledger <path> --json
```

视图固定输出六段：`SCHEDULING PATH`（按 DAG 深度分波的调度树）、`BLOCKING`（未满足依赖与未决门禁）、`ACTIONABLE NOW`（当前可执行步骤的直接 argv）、`WRITE-SET OVERLAP`（两两写集重叠矩阵与需指派的冲突对）、`SUGGESTED MERGE ORDER`（少冲突优先）、`ROLE COVERAGE`（角色模型矩阵覆盖情况）。

设计约束（都是踩过的坑）：

- **账本是 append-only JSONL**，默认落在 `<cwd>/.orca/orchestration-ledger/<run>.jsonl`；只消费 `orca ... --json` 收据，不改运行时。
- **它是所有 worker 共享的唯一文件，所以并发写入必须安全**。这一点是被实测过的，不是假设：25 个并发写入者、单行最大约 6.3KB，零撕裂、零丢写。支撑它的是 POSIX 下 `O_APPEND` 单次 `write()` 的原子性——注意这条不适用于管道（`PIPE_BUF` 规则），所以实现里不能用"拼起来再写"的读改写。
- **测试必须有鉴别力**：把 `appendEntry` 换成读改写后，同样的测试会失败（8 进程 × 20KB 开始丢写，16 × 50KB 出现撕裂行）。参数是照着这个对照标定的，不是拍脑袋定的——太弱的测试对着写坏的实现也会全绿。深度压测用 `config/scripts/orchestration-ledger-concurrency-stress.mjs`。
- **波次由 DAG 推导，不采信记录值**——`wave = 1 + max(dep.wave)`，避免手写 wave 与真实依赖漂移。
- **未知即阻断**：依赖未出现在账本里按"未满足"处理，fail closed。
- **合并队列只收可落地任务**：`coordinator` / `auditor` / `merger` 不进入合并顺序；**写集未记录的可落地任务排最后**——未知不等于小。
- 覆盖测试见 `config/scripts/orchestration-schedule-ledger.test.mjs`（19 例，覆盖解析失败、折叠、DAG 波次、门禁、写集矩阵、合并顺序、渲染，以及跨进程并发写入）。

#### 4.7.2 已实现：`config/scripts/orchestration-role-matrix.mjs` + `orchestration-wave-plan.mjs`

把 4.2 的矩阵和 4.4 的 DAG 从文档变成可执行件：

```text
node config/scripts/orchestration-wave-plan.mjs init --plan plan.json --objective "<目标>"
node config/scripts/orchestration-wave-plan.mjs emit --plan plan.json --json          # 结构化步骤 + 告警
node config/scripts/orchestration-wave-plan.mjs emit --plan plan.json --allow-warnings  # 可执行 shell
```

**派发前拒绝，而不是派发时失败**（error 阻断 emit，warning 需显式 `--allow-warnings`）：

| 拒绝/告警                                              | 挡住的是哪类并行事故                           |
| ------------------------------------------------------ | ---------------------------------------------- |
| 依赖指向不存在的任务、依赖成环                         | 任务永远等不到 ready，或派发器空转             |
| 审计角色带写集                                         | 审计者自己改了代码，verdict 失去独立性         |
| 同波次两个任务抢同一端口/容器/库                       | worktree 隔离不了仓库外的资源碰撞              |
| 合并节点不依赖某个审计                                 | 未审计的改动直接落地                           |
| 两个落地任务写集重叠                                   | 合并期冲突集中爆发（降级为告警，因为顺序可解） |
| 给 opencode/zcode 传 `--model`、传了 effort 却没 model | 运行时会拒的 flag，编译期先拒                  |
| 模型未确认                                             | 告警"agent 默认值生效"，成本不可预期的显式提醒 |

设计约束：

- **波次由 DAG 推导**，不读计划里手写的 wave。
- **图不可排序时（成环或依赖未知），资源冲突检查不再豁免任何一对任务**——排不出顺序就不能断言"它们不会同时跑"。
- **矩阵不内置任何模型 id**：上游规定只在用户点名时才传 `--model`，所以 tier 只表达"需要哪一档"，具体 id 由计划 `confirmModels: true` 后显式提供。
- **角色默认 effort 在没有 model 时被静默丢弃**（binary 会拒 `--effort` 无 `--model`），但计划里**手写**的 effort 无 model 是硬错误。
- 生成的 shell 用 heredoc 承载多行 spec、用 shell 变量承载真实 Task id（`--deps "[\"${TASK_A}\"]"`），每个 Dispatch/Gate 都自动写一条账本。
- 覆盖测试见 `orchestration-role-matrix.test.mjs`（12 例）与 `orchestration-wave-plan.test.mjs`（21 例）。

#### 4.7.4 已验证：生成的命令形状真的被 orca 二进制接受

编译出来的 argv 能不能被真实二进制解析，是和"函数返回了正确值"完全不同的一层。kaixuan provider preset 那轮教训过：24 个断言全绿，CLI 却把整个字段静默丢弃。所以：

```text
node config/scripts/orchestration-argv-contract-check.mjs
```

把编译器产出的每条命令直接喂给 `orca` 二进制并归类：`ACCEPTED`（参数解析通过，因运行时未启动而停在 `runtime_unavailable`）、`REJECTED`（二进制不认这个 flag）、`SHAPE-ERROR`（flag 认得但必填参数缺失）、`UNKNOWN`。

**脚本每次运行先跑两个反向对照**（不存在的 flag、缺 `--task`），两者都必须被判为拒绝；判不出来就直接非零退出并说明"本检查已失去辨别能力"——一个无法失败的检查器比没有检查器更糟。

当前结果：7 条命令全部 `ACCEPTED`，含 `--worktree new-child`、`--base-branch`、`--setup`、`--deps`、`--agent`、`--model`、`--effort` 与 gate 的 `--options`。

#### 4.7.5 已验证：生成的脚本被真正执行过

前两项验的是"文本对不对"，这一项验的是"跑起来对不对"。用一个桩 `orca`（返回结构真实的收据，task id 故意在 `result.task.id` 与 `result.taskId` 两处轮换）把生成的脚本 `bash` 跑一遍，再检查：脚本是否跑完、每个任务是否创建、每个派发是否发生、`--deps` 展开后是否仍是合法 JSON 且装的是真实 id、账本里是否落了正确的 dispatch id、波次与依赖是否解析成 implement / audit / merge。

```text
pnpm run verify:orchestration-generated-script
```

**这一步抓到了三个只做语法检查永远发现不了的 bug**：

1. **账本记的是运行时 id 而不是计划名**——`task_3` 顶掉了 `impl_a`，于是 DAG 依赖、波次、合并顺序全部对不上。修法是账本以计划 id 为键，运行时 id 另存 `runtimeTaskId`；任务被重建时视图不会与产生它的计划脱节。
2. **多依赖时 `--deps` 生成非法 JSON**——`["task_7,"task_9"]`，少一个右引号。单个依赖时完全正常，所以更隐蔽。
3. **账本条目被整个丢掉**——shell helper 里写的是 `{...entry}`，而 `entry` 是 JSON **字符串**，展开成的是 `{0:'{',1:'"'…}`。结果每次派发写进账本的 `role`/`agent`/`model`/`placement`/`state`/`nextAction` **全是 null**：调度路径可见这个特性会只记 id，等于没有。

第 3 条是这一整轮最值得记住的：**82 个单测全绿、argv 契约全绿、`bash -n` 通过，而特性本身是不工作的。** 只有把脚本真正执行一次、把产出的账本真正读一遍，才看得见。

#### 4.7.3 已实现：`config/scripts/orchestration-merge-gate.mjs`

把 4.5 的 verdict 契约和 4.6 的合并协议变成 fail-closed 的两道闸：

```text
node config/scripts/orchestration-merge-gate.mjs verify --ledger <path>          # 退出码 0=可合
node config/scripts/orchestration-merge-gate.mjs merge  --ledger <path> --repo <path> --base <ref> [--execute] [--rebase]
```

**闭环：`worker_done` 必须被记录下来。** 门禁读的是账本里的 verdict / findings / report / 改动文件——如果没有写入方，这些字段永远不存在，每次真实运行都会报"landed without an audit verdict"。`record-done` 就是这个写入方，**不手写 JSON**：

```text
# 实现者完成（不需要 verdict）
node config/scripts/orchestration-merge-gate.mjs record-done --run <run> --task impl_a \
  --role implementer --outcome succeeded --file src/a.ts

# 审计者记录结论；--finding 可重复，--dep 指明它审计谁
node config/scripts/orchestration-merge-gate.mjs record-done --run <run> --task audit_a \
  --role auditor --dep impl_a --verdict pass --report reports/audit-a.md \
  --regression '{"command":"pnpm test","result":"ok"}'

node config/scripts/orchestration-merge-gate.mjs record-done --run <run> --task audit_b \
  --role auditor --dep impl_b --verdict pass_with_findings --report reports/b.md \
  --regression '{"command":"pnpm test","result":"1 failing"}' \
  --finding '{"file":"src/b.ts","line":21,"severity":"minor","evidence":"missing edge case"}'
```

**契约在写入时就校验**，不是等到门禁再报：`pass` 却带 findings、缺 `reportPath`、**缺 `regression`**、未知 verdict——当场拒绝并非零退出。理由是矛盾的 verdict 一旦落盘就会变成"事实"，在三步之后才被发现，代价是整个 Run 白跑。

**verdict 契约**（任何一条不满足就关门）：

- `verdict` 必须是 `pass | pass_with_findings | fail`；
- `pass` 却带 findings、`pass_with_findings` 却没 findings、`fail` 却没有任何 blocker 级 finding——**声明与证据自相矛盾即拒绝**；
- 每条 finding 必须有 `file:line` 和可复现 evidence；
- **任何 verdict 都必须有 `reportPath`**：没人能重读的审计不是审计，是一句声明；
- 覆盖关系读 DAG 而非命名：`audit_a` 审计 `impl_a`，因为它的 `deps` 指向 `impl_a`；
- 未审计的落地任务、未完成的任务、未决的 gate、被判 fail 的 gate——全部阻断。

**合并执行**：

- 合并顺序来自账本的写集分析（少冲突先合），不是任务名顺序；
- **默认不 rebase**。rebase 会改写常常已经推送过的特性分支，所以它是 `--rebase` 显式选项；默认路径只报告每个分支落后基线多少个 commit，并提示接受改写时的命令；
- **冲突绝不自动解决**：abort 后把仓库切回基线分支、停在"什么都没发生"的状态，报告冲突分支，归属权交回给人；
- **空计划不得报成功**：账本里没有可落地分支时报 `nothing to merge` 并以非零码退出——"全部合并完成"不能是一句关于零件事的断言。

覆盖测试见 `orchestration-merge-gate.test.mjs`（30 例），其中 8 例在**真实临时 git 仓库**上跑：落后计数、脏工作区拒绝、独立分支合入、冲突中止且不选边、默认不改写分支历史、已合并不重复合、空计划不报成功。

**已验证的端到端链路**（真实 git 仓库 + 真实账本文件，零手写 JSON）：`record-done` 记实现者完成 → 矛盾 verdict 被写入方拒绝 → 记两次合规审计 → `verify` 开门 → `merge --execute` 合入两个分支，两个文件都落在基线上。

---

## 5. 执行阶段

| 阶段 | 内容                                                                     | 验收标准                                                                      | 状态                                               |
| ---- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| P0   | 本文档 + `.gitignore` 放行 + AGENTS.md 挂链                              | 文档可被 git 跟踪，AGENTS.md 可跳转                                           | ✅ 完成                                            |
| P1   | **L3 可见性**：调度账本记录器 + 单命令调度视图                           | 合成 Run 数据产出完整视图：树、DAG 阻塞、argv、写集重叠矩阵                   | ✅ 完成（17/17 测试 + CLI 端到端 + lint/format）   |
| P2   | **L0/L1 规程落地**：角色矩阵 + Task spec 模板 + 五波命令骨架编译         | 一个计划编译出完整 `orca` 命令序列，且非法计划在派发前就被拒                  | ✅ 完成（33 例测试 + 脚本生成 + `bash -n` 校验）   |
| P3   | **L2/L4 门禁与合并**：verdict 校验器 + 合并脚本（rebase→回归→合入→冲突） | verdict 契约 fail-closed；真实 git 仓库上完成合入，冲突被显式报告而非静默处理 | ✅ 完成（30 例 + 端到端闭环，8 例跑真实 git 仓库） |
| P4   | **真实 pilot**：在本仓库用两个真实任务跑完整链路                         | 两个任务零互相干扰、各自出 verdict、按建议顺序合并、账本可复盘                | 待定（需授权）                                     |

**风险与边界**

- 真实 pilot 需要启动 Orca app、创建多个 worktree、消耗模型额度，属于需要明确授权的动作。
- 改 Orca 源码补 merge/audit 原语属于 PR 级工程，不在默认路径内；本方案默认走"规程 + 工具"路线，不改上游运行时。
- 上游纪律"只在用户点名模型时传 `--model`"与角色矩阵存在张力，解法是矩阵需显式确认后才生效。

---

## 附录 A：命令速查

```text
orca status --json                                   # 运行时可用性
orca orchestration run-create --objective "<目标>" --json
orca orchestration task-create --spec "<spec>" --deps '[]' --json
orca orchestration task-list --ready --brief --json  # 唯一事实来源
orca orchestration worker-start --task <id> --worktree new-child --name <n> \
    --base-branch <ref> --agent codex --model <id> --effort high --json
orca orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
orca orchestration worker-list --run <id> --terminal-state reclaimable --json
orca orchestration gate-create --task <id> --question "<q>" --options '["pass","fail"]' --json
orca orchestration gate-resolve --gate <id> --choice pass --json
orca orchestration worker-release --dispatch <id> --json
```

## 附录 B：证据索引

| 结论                                        | 文件                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| Task 状态机                                 | `src/main/runtime/orchestration/db/lifecycle-transition.ts:67,81`               |
| Dispatch 状态机与 `start_options`/`effects` | `src/main/runtime/orchestration/db/schema/create-core-tables-sql.ts:144-162`    |
| stale-base 阈值 20 与 `allow-stale-base`    | `src/main/runtime/orchestration/coordinator-stale-base-flag.ts:4,6`             |
| stale-base 拒绝派发路径                     | `src/main/runtime/orchestration/coordinator-task-dispatch.ts:82-91`             |
| worktree 创建                               | `src/main/runtime/rpc/methods/orchestration/worker/worker-worktree-creation.ts` |
| 模型/effort 生效值                          | `.../worker/worker-launch-preferences.ts`                                       |
| 依赖解析                                    | `.../worker/task-deps-argument.ts`                                              |
| 门禁                                        | `src/main/runtime/rpc/methods/orchestration/gates/gates.ts`                     |
| 存活投影                                    | `.../worker/worker-list-projection.ts`                                          |
| 无 merge/audit 原语                         | `orca agent-context --json` 全量 237 命令扫描                                   |
| 模型档位限制                                | `orca skills get orchestration --reference references/coordinator-loop.md`      |
| 放置与 worktree 语义                        | `orca skills get orchestration --reference references/placement-and-remote.md`  |
