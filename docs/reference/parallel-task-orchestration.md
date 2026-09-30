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

| #   | 失效模式                                        | 后果                                                | 防线                                                                                                                    |
| --- | ----------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| F1  | 两个 worker 共用同一个 worktree                 | 编辑交错、diff 混合、丢改动                         | 一任务一 worktree（`new-child`）                                                                                        |
| F2  | 各自 worktree 但共享依赖目录 / 端口 / 容器 / DB | 测试互相污染，绿红交替                              | spec 里显式分配端口与外部资源名；并行波次必须先定资源表                                                                 |
| F3  | 各自 worktree 但基线不同                        | 合并冲突，甚至静默错误                              | `--base-branch` 显式钉基线；落后 > 20 commit 拒绝派发                                                                   |
| F4  | 写集重叠但无人知晓                              | 合并顺序随机选，冲突成本集中爆发                    | 从 `worker_done --files-modified` 算两两写集交集，产出合并顺序                                                          |
| F5  | 审计者就是编码者（或共享上下文）                | 自己盖章，审计退化为复读                            | 审计是**另一个 worktree / 另一个 Dispatch** 的只读角色，且审计与实现的 agent/model 组合必须不同（编译器与门禁双重强制） |
| F6  | 测试由编码者自己写自己验                        | 测试随实现漂移，等价于没测                          | 测试角色独立 Dispatch，允许低成本模型；测试必须先红后绿                                                                 |
| F7  | 模型路由隐式（协调者随手挑）                    | 成本不可控、质量不可解释、无法复盘                  | 角色矩阵事先声明，落进调度记录，事后按 `launch.effective` 审计                                                          |
| F8  | 调度路径不可见                                  | 出问题只能靠翻 transcript；无法回答"为什么它这么跑" | 调度账本 + 单命令视图                                                                                                   |

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
- **审计必须真的是"第二意见"**：审计任务与它审计的任务若**同一个 agent 且同一个 model**，计划编译器在派发前直接拒绝，合并门禁也会在落地前阻断。理由是：换个 Dispatch、换个 worktree 都救不了"审你的人就是写代码的人"。**同 agent 但不同 model 可以，不同 agent 同 model 也可以**——独立性关乎裁判，不关乎工具。
- **独立性判定 fail-closed**：账本里那条审计**没记 agent** 时门禁关门，不放行。缺数据不是"没问题"，是"没法判断"；把无法检查的独立性当作独立性，等于给"忘了写"发了一张通行证。要么走编译出来的计划（派发时自动落 agent/model），要么手工 `record-done` 时带上 `--agent/--model`——`record-done` 接受这两个参数，正是为了让手工派发和自动派发在门禁眼里没有区别。

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

#### 4.7.4 已修正（P4 实跑后）：形状检查分两层，默认那层不碰运行时

编译出来的 argv 能不能被真实二进制解析，是和"函数返回了正确值"完全不同的一层。kaixuan provider preset 那轮教训过：24 个断言全绿，CLI 却把整个字段静默丢弃。

```text
node config/scripts/orchestration-argv-contract-check.mjs            # schema 层，CI 安全
node config/scripts/orchestration-argv-contract-check.mjs --live     # 实探，需运行中的 Orca
```

**为什么从原来的一层拆成两层**：原实现把"运行时没启动、二进制停在 `runtime_unavailable`"判成 `ACCEPTED`——而这正是开发期一直所处的状态。于是它稳定地报出 7 条 `ACCEPTED`，其中就包括真实运行会失败的那条命令。**参数被解析不等于值被求值。**

| 层                        | 手段                                 | 回答的问题                                     | 副作用                       |
| ------------------------- | ------------------------------------ | ---------------------------------------------- | ---------------------------- |
| schema（默认）            | `orca agent-context` 里二进制自己的 flag 声明 | 我们发的 flag 二进制认不认                   | 无（不起运行时、不建任何东西）|
| 实探（`--live` 显式）     | 真的把命令交给二进制                 | 二进制解析整条命令行后会不会到运行时         | **有**：活着的运行时会执行它解析到的东西 |

实探的归类：`REJECTED`（flag 被拒）/ `SHAPE-ERROR`（flag 认得但必填缺失）/ `REACHABLE`（运行时被问到，值不成立）/ `UNVERIFIED`（运行时根本没被问到——旧的 `ACCEPTED` 就是这一类，现在它让检查失败而不是通过）。

两个反向对照：schema 层用一条不存在的 flag（无副作用），实探层用不存在的 flag 与缺 `--task` 的真实调用；判不出来就非零退出并声明"本检查已失去辨别能力"。

**这一层自己有个教训**：在活着的 Orca 上跑旧版检查时，它**真的建了三个 Task**（`task-create` 被执行了），留在 adopted Run 里，而没有任何命令能删掉它们。所以实探现在是显式 `--live`，并在输出里写明这一点。

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

#### 4.7.6 P4 实跑补上的第四个 bug：**桩收据自己编的形状**

上一步的桩把 `run-create` 答成 `{ result: { id: 'run_stub' } }`，而真实二进制答的是：

```json
{ "result": { "run": { "id": "run_…", "coordinator_handle": "term_…" } } }
```

生成脚本里的 id 提取器只认 `result.task` 和 `result`，于是 `RUN_ID` 是空串。实跑的表现是：**Run 开了、四个 worker 派出去了，然后每一条账本记录都失败**——`Ledger entry requires a non-empty "run"`。

**一个自造收据的桩，教给检查的是一份运行时从未承诺过的契约。** 桩现在按真实收据作答，检查里多一条断言：每一条账本行的 `run` 都等于真实 Run id（对旧提取器红，对新提取器绿）。

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
# --agent/--model 不是可选项：审计独立性就是拿这两个值去和被审计任务比对，缺了就关门
node config/scripts/orchestration-merge-gate.mjs record-done --run <run> --task audit_a \
  --role auditor --agent claude --model <T> --dep test_a --verdict pass \
  --report reports/audit-a.md \
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
- 覆盖关系读 DAG 而非命名，而且是**传递闭包**：审计等待的是测试任务，测试等待的是实现任务，被判读的代码写在最远端那一跳。`audit_a --dep test_a` 就算覆盖了 `impl_a`，只认直接依赖会让五波模板永远过不了自己的门禁，同时放过"审计者就是实现者"的那一种——两个症状，同一个根因；
- 未审计的落地任务、未完成的任务、未决的 gate、被判 fail 的 gate——全部阻断。

**合并执行**：

- 合并顺序来自账本的写集分析（少冲突先合），不是任务名顺序；
- **合入"已经持有基线分支的那个 worktree"**：整个方案建在 worktree 上，所以 `main` 通常被另一个 worktree 检出着，`git checkout main` 会直接失败（`'main' 已经被工作区 ... 使用`）。合并前先解析基线落在哪，指向那个目录执行；解析不到才退回调用方当前目录。持有基线的工作区有未提交改动时**整个计划拒绝执行**，不做半个合并；
- **默认不 rebase**。rebase 会改写常常已经推送过的特性分支，所以它是 `--rebase` 显式选项；默认路径只报告每个分支落后基线多少个 commit，并提示接受改写时的命令；
- **冲突绝不自动解决**：abort 后把仓库切回基线分支、停在"什么都没发生"的状态，报告冲突分支，归属权交回给人；
- **空计划不得报成功**：账本里没有可落地分支时报 `nothing to merge` 并以非零码退出——"全部合并完成"不能是一句关于零件事的断言。

覆盖测试见 `orchestration-merge-gate.test.mjs`（37 例），其中 14 例在**真实临时 git 仓库**上跑：落后计数、脏工作区拒绝、独立分支合入、冲突中止且不选边、默认不改写分支历史、已合并不重复合、空计划不报成功、**基线被别的 worktree 持有时仍能合入**、**持有基线的工作区是脏的就整单拒绝**。

**已验证的端到端链路**（真实 git 仓库 + 真实账本文件，零手写 JSON）：`record-done` 记实现者完成 → 矛盾 verdict 被写入方拒绝 → 记两次合规审计 → `verify` 开门 → `merge --execute` 合入两个分支，两个文件都落在基线上。

**审计轮在真实 CLI 上的四个正/反例**（真实 git + 真实 JSONL 账本，非单测夹具）：审计未记 agent → `MERGE GATE: CLOSED`，列出每个被审计任务；审计与实现同 agent 同 model → CLOSED，报"rubber stamp"；同 agent 不同 model → OPEN；不同 agent 同 model → OPEN。同时 `main` 只存在于另一个 worktree 时，`verify` 开门、`merge --execute` 把文件合进那个 worktree 的 `main`。

---

## 5. 执行阶段

| 阶段 | 内容                                                                     | 验收标准                                                                      | 状态                                               |
| ---- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| P0   | 本文档 + `.gitignore` 放行 + AGENTS.md 挂链                              | 文档可被 git 跟踪，AGENTS.md 可跳转                                           | ✅ 完成                                            |
| P1   | **L3 可见性**：调度账本记录器 + 单命令调度视图                           | 合成 Run 数据产出完整视图：树、DAG 阻塞、argv、写集重叠矩阵                   | ✅ 完成（19 例测试 + CLI 端到端 + lint/format）   |
| P2   | **L0/L1 规程落地**：角色矩阵 + Task spec 模板 + 五波命令骨架编译         | 一个计划编译出完整 `orca` 命令序列，且非法计划在派发前就被拒                  | ✅ 完成（40 例测试 + 脚本生成 + `bash -n` 校验）   |
| P3   | **L2/L4 门禁与合并**：verdict 校验器 + 合并脚本（rebase→回归→合入→冲突） | verdict 契约 fail-closed；真实 git 仓库上完成合入，冲突被显式报告而非静默处理 | ✅ 完成（37 例 + 端到端闭环，14 例跑真实 git 仓库） |
| 审计 | **对上述三层做批判式复核**：模板跑自己门禁、失败方向、worktree 真路径 | 模板形状能过自己的门禁；负例真被拒；基线在别的 worktree 时真能合            | ✅ 完成（4 个真实 CLI 正/反例 + 修复见 4.7.3）    |
| P4   | **真实 pilot**：在本仓库用两个真实任务跑完整链路                         | 两个任务零互相干扰、各自出 verdict、按建议顺序合并、账本可复盘                | 进行中：wave 0/1 已实跑，见 4.7.7 与 4.7.8        |

#### 4.7.7 P4 真实 pilot：前四个缺陷只有真跑才看得见

P2/P3 的"已验证"全部是**桩验证**。P4 在真 Orca（`/Applications/Orca.app` 1.4.197）里派发真实 worker，四个缺陷当场暴露，**每一个在修复前的检查里都是全绿**：

| # | 缺陷                                                                 | 现场表现                                                                 | 为什么检查没抓到                                       | 修法                                          |
| - | -------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------- |
| 1 | 生成脚本从不带 `--from`                                                | 第一条派发就死：`selector_not_found`，而 selector 是 `new-child`        | 桩二进制对任何命令都给收据，不校验参数                  | 从 run-create 收据取 `coordinator_handle`，每条派发都带；取不到就拒绝发脚本 |
| 2 | argv 校验把"运行时没启动"判成 `ACCEPTED`                             | 它稳定报 7 条 `ACCEPTED`，其中包含真实会失败的那条                      | 开发期运行时一直没启动，fail-open 恰好是常态            | 拆成 schema（默认）+ 实探（`--live`）；未求值即 `UNVERIFIED` 并让检查失败 |
| 3 | `claude` 没有预信任预设                                                | 每个 claude worker 停在首次启动的信任弹窗，dispatch 死在 `agent_readiness` | 桩不启动 agent，弹窗不存在                             | `preflightTrust: 'claude'`，只写 `~/.claude.json` 的 `hasTrustDialogAccepted` |
| 4 | 桩自造 `run-create` 收据形状                                          | Run 开了、worker 派出去了，然后每条账本记录都失败（`run` 为空）          | 桩答的是 `{result:{id}}`，真实是 `{result:{run:{id}}}`   | 桩按真实收据作答 + 断言每行 `run` 非空           |

> **审计修正（2026-10-01，见 §4.7.10）**：本节第 2、4 行的"修法"当时**只有实现、没有守卫**。`orchestration-argv-contract-check.mjs` 与 `orchestration-generated-script-check.mjs` 既没有测试文件，也不在 `pnpm test` 或任何 CI workflow 里——把它们退回修复前的状态，测试套件全绿。表中"为什么检查没抓到"一列对这两条是成立的，但整节读起来像"修完即有回归保护"，那是错的。

**还有一个不是本仓库的**：opencode 的 `bash`/`edit` 权限默认 `ask`，而 supervised worker 没人值守，于是每个 worker 卡在自己的权限弹窗上。和缺陷 3 同源——**任何"必须有人在终端里点一下"的首次启动流程，都会让 supervised 派发停在 `agent_readiness`**。本次由协调者代答"Allow always"（opencode 侧的措辞是"until OpenCode is restarted"，即会话级，不是全局配置）。

**关于第 1 条，值得单独记住**：报错信息指向 `--worktree` 的 selector，而真正的原因是命令从头到尾没有指名 Run 的协调者。`worker-start` 被 fence 在绑定到该 Run 的终端上，`--worktree new-child` 又要通过同一个绑定去解析协调者工作区。同一条 argv 加 `--from` 就起得来，不加就失败——**一个指错位置的错误信息，比错误本身更贵**。

#### 4.7.8 P4 第二轮：wave 0 收口时又挖出四条

第一轮修完四个缺陷后，pilot 继续跑到 wave 1，暴露出的问题性质变了——**不再是"跑不起来"，而是"跑起来了但结论是假的"**。

| #   | 缺陷                                                                   | 现场表现                                                                                                          | 修法                                                                             |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 5   | 空账本让合并门禁报 `OPEN`                                               | `verify --ledger <空文件>` 与 `--ledger <不存在>` 都打 `MERGE GATE: OPEN`、退出 0                                  | 空折叠成为带理由的 blocker；不存在的路径按名字拒绝；两条 CLI 用例（红→绿已证） |
| 6   | worker 的验收命令比仓库自己的门松                                       | impl_a 交付 15 处 `no-useless-escape`；impl_b 把测试文件顶到 727 行（上限 600 且禁止豁免）——**两者验收命令都绿**     | 协调者代修 lint；测试拆文件 + 共享 fixture                                          |
| 7   | 模板从不要求 worker 提交                                                | 审计以分支检出，settled dispatch 又收不到追问（`dispatch_inactive`），所以未提交的工作在审计眼里不存在               | 由协调者代记提交，作者归属与代做项写进 commit message                             |
| 8   | 测试任务改了 runner                                                     | test_b 把 merge-gate 测试从 vitest 改写成 `node:test`：`node --test` 全过，项目真正用的 vitest 报 **"Tests no tests"** | 改动被拒；spec 里的 acceptance 命令本身要按项目 runner 写                          |

**第 8 条是这一轮最值得记住的**：一个测试文件可以在某个 runner 下全绿，同时在项目真正使用的 runner 下**一个用例都不跑**。它不会被"测试通过"发现，只会被"这个文件跑起来到底跑了几个用例"发现。

**而它的根因在 spec 上，不在 worker 上**：pilot 计划里给 test_b 写的验收命令是 `node --test …`，而这个仓库用 vitest。worker 忠实执行了 spec，spec 才是错的。**编排里"每条 spec 都自带可机器判定的验收"这条规则，同时意味着 spec 写错会把整个波次带偏，而门禁无从发现。**

**另外两条与围栏同源**：`task-create` 没有 `--run`，它永远建在终端当前绑定的 Run 上；重跑生成的脚本会开新 Run 并把协调者终端重新绑过去，于是上一轮的任务对 `task-create` 变成"另一个 Run 的依赖"。续跑一个 Run 必须先 `orca orchestration run-use --id <run> --from <handle>` 绑回去。

#### 4.7.9 P4 第三轮：拒绝一次交付，牵出九条"状态不是它自称的那种状态"

第二轮留下的 test_b 是 `failed`，而 wave 2 的审计按依赖排在它后面。要重派它，先得回答"failed 到底意味着什么"——四条都在这里现形。

| #   | 缺陷                                                                | 现场表现                                                                                              | 为什么值得单独记                                                                                 |
| --- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 9   | 运行时的 Task 状态是**进程级**的，不是**结论级**的                    | test_b 第 1 次的 agent 进程干净退出，运行时把 Task 记成 `completed`；被拒的是交付物，不是进程        | 依赖它的 audit_b 按运行时图就是"可调度"的——**被拒的交付物在运行时眼里是已完成的**              |
| 10  | 账本 `fold` 是**逐字段后写覆盖**，一次重试会把两次 attempt 拼成一个不存在的状态 | `test_b` 在视图里同时是 `state=ready`（第 2 次）与 `outcome=failed`（第 1 次），`placement` 指向 `test_b2`，而它记录的唯一写集来自已被拒的 `test_b` worktree | 账本文件是 append-only 的，**丢/串的是视图**；更糟的是写集按并集累积，重叠矩阵与"建议合并顺序"因此建立在任何单次 attempt 都没产生过的写集上 |
| 11  | `--retry-of` 只认**失败的 Task**，且不接受新的 `--spec`               | 运行时认为 test_b 成功了，于是重试路径本身用不了；就算它是失败的，重试也只会把同一条错 spec 再发一遍    | **spec 层面的缺陷无法靠重试修复**——而第二轮的缺陷 8 恰恰是 spec 层面的                            |
| 12  | worker 卡在弹窗上时，编排视图与"正在思考"**不可区分**                | 代答弹窗的监听器到期退出后，worker 空等约 15 分钟；整段时间 `worker-show` 恒为 `state=ready, stage=input_accepted, lastFailure=null` | 存活信号存在但对这条路径失效（详见下文）；**只报"还在跑"的视图支撑不了"该不该继续等"**             |
| 13  | `writeSet` 是**建议**的，但下游一律当它是**权威**的                    | impl_b 声明写集 2 个文件、实际改 5 个，越出 3 个（含 2 个测试文件）；`writeSet` 全仓只被用于"只读任务必须为空"与"算重叠矩阵"，**从不与实际改动比对** | 编译期算出的合并顺序与冲突归属来自**声明**；实现者越界时，那两件事都建立在不完整的文件集上         |
| 14  | 提交钩子在提交**过程中**改文件，提交记录的是改之前的字节                | lint-staged 的 `oxfmt --write`：提交时 596 有效行、oxlint 绿；提交后工作树 656 行、`max-lines` 红   | "提交是绿的"不等于"提交进去的内容过了门"；门验的是被改写前的副本                                   |
| 15  | 折叠视图的 JSON 带着 `findings`，**文本渲染把它丢了**                    | test_b 被协调者判为"跑成了但整批丢弃"，文本回放里只有 `completed succeeded`，看不出任何拒绝         | 证据在账本里，但**人读的那份视图里没有**；复盘的人看到的是"它过了"                                 |
| 16  | 本地 `main` ref 可能**过期且被别的会话占用**，拿它当合并基线会验错东西     | 本地 `main` = `5441ce7c4`，检出在另一个会话的 worktree `orca-wt-ledger`；`origin/main` = `102deffa7`，**本项目推的 5 个提交一个都不在本地 main 上** | 第一次合并预演跑在过期基线上，三个分支"全部干净"——**这个结论什么也没证明** |
| 17  | 门禁把任务的 **`placement.base`（从哪 fork）当成要合的分支**；而"落在哪个分支"账本里根本没有字段 | 真 run 上打印的 ORDER 是 `impl_a→pilot/p4-two-task-pilot`、`test_a→halfking/impl_a-2`、`impl_b→pilot/…`、`test_b→halfking/impl_b`——**`halfking/test_a` 永远不会被合** | 门会自信地打印一份错误的计划并照着执行；**这是"门读了它没读的东西"里最贵的一种** |

第 10 条的判据是那句老话：**门报的每个集合/每个状态，先问"它是怎么被构造出来的"**。`foldLedger` 按 `entry.task` 归并，然后**对每个字段独立做后写覆盖**（`config/scripts/orchestration-schedule-ledger.mjs:145-196`），`files` 更是**只并不清**。于是一次重试不会"让失败消失"，而是造出一个**两次 attempt 拼接出来的状态**——它比纯粹的旧状态和新状态都更坏，因为没有任何一次 attempt 真的处于这个状态：

```text
  wave 1
    test_b    test-author  opencode  -  -  ready  failed  test_b2@halfking/impl_b  files=1
```

`ready` 来自第 2 次的 `worker-start`，`failed` 来自第 1 次的 `worker-done`，`test_b2` 来自第 2 次的 `placement`，而 `files=1` 里那个 `config/scripts/orchestration-merge-gate.test.mjs` 来自**已被拒绝的第 1 次**。再往前走一步：第 2 次一旦写下 `outcome=succeeded`，失败就彻底看不见了。

**最贵的一环在下游**：写集是并集，所以 `WRITE-SET OVERLAP` 与 `SUGGESTED MERGE ORDER` 是建立在一个任何单次 attempt 都没产生过的写集上算出来的。本次靠显式写 `attempt: 2` 与 `supersedes` 把它留在账本里——但这是**协调者的自觉，不是工具的保证**。

第 9、11 条合起来给出一条规程：**被拒的交付物要先把运行时 Task 改成 `failed`，再用新 Task 重派**。改状态不是记账美观问题——不改，`audit_b` 的依赖就会由一个被拒的 Task 满足。

**第 12 条：无人值守的 worker 卡在弹窗上时，编排视图与"正在思考"不可区分。** 这一条是撞出来的——代答权限弹窗的监听器有 25 分钟截止，21:01 退出，而弹窗在那之后才出现，于是 worker 空等了约 15 分钟。整段时间里 `worker-show` 的输出没有任何变化：

```text
status: dispatched | state: ready | stage: input_accepted | lastFailure: null
```

机制上这不是偶然。设计里确实有存活信号——`dispatch_contexts.last_heartbeat_at` 加上 `warnStaleDispatches`（`src/main/runtime/orchestration/coordinator-task-dispatch.ts:19-25`）——但它对这条路径不成立，原因有三层叠加：

1. 心跳由 worker **主动发消息**写入（`lifecycle-reconciliation.ts:171`），而 supervised 的 TUI worker（opencode / claude）不发心跳，所以 `last_heartbeat_at` 一直是 `null`。本次实测就是 `null`。
2. `getStaleDispatches` 的判据是 `last_heartbeat_at IS NULL OR …`（`db/dispatch-context/dispatch-completion.ts:104-108`），**`null` 直接算过期**——一个健康但不发心跳的长任务，在这条规则下从第一分钟起就是"过期"的。
3. 就算判据命中，`warnStaleDispatches` 也**只打日志、绝不自动失败**（注释写明：宁可漏报不可误杀）。

三层叠起来的结果是：唯一还能用的信号是 `result.terminal.lastOutputAt`——它确实在 `worker-show` 的 JSON 里，但它是**终端字段，不是 dispatch 的存活字段**，没有任何 CLI 汇总它。

**判据**：一个只报"还在跑"的视图，无法支撑"该不该继续等"这个决定。本次浪费的 15 分钟不是 worker 的问题，是**协调者只能靠人肉盯终端才发现它卡住了**。任何无人值守链路（定时任务、CI、跨会话接力）都会踩到同一条。

**第 13 条是这一轮最贵的结构性发现，而且它的后果是**测试任务本身失去意义**。`writeSet` 在全仓只有两个消费者：`orchestration-wave-plan.mjs:154,157` 用它校验"只读任务的写集必须为空、能落地的任务必须声明写集"，以及 `:195-196` 用它算编译期的重叠矩阵。**没有任何地方把它和 worker 实际改了什么做比对。** 实测：

```text
impl_a: 声明 2 / 实际 2    越出: 无
impl_b: 声明 2 / 实际 5    越出: + merge-gate-test-fixtures.mjs
                              + orchestration-merge-gate-record.test.mjs
                              + orchestration-merge-gate.test.mjs
test_a: 声明 1 / 实际 1    越出: 无
test_b: 声明 1 / 实际 1    越出: 无
```

impl_b 越界写了两个测试文件，而它下游的 test_b 的任务就是"给这个特性补测试"。于是 test_b 第 2 次跑出来的 4 个用例，**逐条都是 impl_b 已经写过的**——不是"覆盖相似"，是 impl_b 连 `resultingCommit` 的 40 位十六进制、以及第二个条目的 commit 等于 base HEAD 都断言过了。

净增覆盖：**0**。干净的 impl_b 是 43 例通过（37 + 6），worker 的版本是 41 例在一个文件里，等于把同样的 43 例拆散重排再加 4 条重复。

**所以这不是 worker 的错，是我写的 spec 错了**——第三次了（缺陷 8 的 runner、这一轮的重复覆盖、加上第 13 条本身）。而 spec 会错，根因是**写集没有被强制**：如果编排在 worker settle 时比对"实际改动 ⊆ 声明写集"，impl_b 越界那一刻就会被拦下，test_b 的 spec 也就能写出真正没人覆盖的东西。

**判据**：一道只被"声明"喂饱、从不与现实对账的门，等于没有门。合并顺序、冲突归属、"这个文件归谁"——这三件事全都建立在 worker 自报的写集上，而自报是全世界最容易出错的输入。

第 14 条是同一族的另一个形状：**门验的不是提交进去的那份内容**。lint-staged 的 `oxfmt --write` 在 pre-commit 里就地改文件，于是"oxlint 绿"验的是格式化**前**的字节，提交记录的也是那份，格式化产物留在工作树里——而它把这个文件从 596 有效行推到 656，直接顶破同一文件上的 `max-lines 600`。上一轮 impl_b 撞的 600 行墙、这一轮 test_b 撞的同一堵墙，都是这么来的：**一个 600 行的上限，配一个只会把行数往上加的格式化器。**

第 15 条最朴素但最该记：`foldLedger` 确实把 `findings` 带进了视图的 **JSON**，可文本渲染只打 `verdict / outcome / placement / files`。所以 test_b 那条"跑成了但整批丢弃"的判定，**在账本里，在 JSON 里，在人读的那份回放里不在**。复盘的人看到的是 `completed succeeded`。

第 16 条是这一轮差点让我交出假结论的坑。合并预演第一次跑完，**三个分支全部干净合并**——但那个基线是本地 `main`（`5441ce7c4`），而它检出在**另一个会话的 worktree** `orca-wt-ledger` 里，且**不含本项目推上 `origin/main` 的那 5 个提交**（`origin/main` 已经是 `102deffa7`）。在过期基线上"合并干净"什么也不证明。改用 `origin/main` 重跑才是有效证据：

```text
base: origin/main = 102deffa7
  halfking/impl_a-2: clean
  halfking/test_a:   clean
  halfking/impl_b:   clean
  halfking/test_b:   （已 reset 回 impl_b，无新内容）
  合并结果：vitest 4 文件 81 例全过 / oxlint 干净 /
            generated-script PASS / argv-contract schema 9/9
```

**判据**：多 worktree 仓库里，`main` 是一个**被某个 worktree 占用、可能长期不动**的本地 ref。凡是要"合到 main"，先问一句**这个 main 是不是远端那个**——`git merge-base --is-ancestor <你刚推的提交> main` 一行就能验。

**第 17 条是整个 pilot 最贵的一条，而且它让 `merge --execute` 在修好之前不能碰。**

`buildMergePlan` 这样取分支（`config/scripts/orchestration-merge-gate.mjs:130`）：

```js
const branchOf = (id) => view.folded.tasks.find((t) => t.id === id)?.placement?.base ?? null
```

`placement.base` 是任务**从哪儿 fork 出来**的。任务**落在哪个分支**在账本里**没有字段可放**——`normalizeEntry` 根本没有 `branch`（`orchestration-schedule-ledger.mjs:44-71`）。于是门禁对每个任务都合它的**父分支**。在真实 run 上它打印出来的计划是：

```text
ORDER
  1. impl_a   pilot/p4-two-task-pilot
  2. test_a   halfking/impl_a-2
  3. impl_b   pilot/p4-two-task-pilot
  4. test_b   halfking/impl_b
```

`halfking/test_a` **一次都不会被合**；`test_a` 那一格放的是 impl_a 的分支；impl_a 和 impl_b 两格指向同一个 pilot 分支。**它会照着这份计划执行。**

**为什么 56 例的测试套件抓不到**：夹具把 `placement.base` 填成**落地分支**——`base: 'feature/a'`（`orchestration-merge-gate.test.mjs:64,73`）——恰好是实现假设的那一种含义。**夹具复刻了被测代码的误解，于是套件在一个错误行为上是绿的。** 编译器与协调者写的账本填的是 fork 起点，两边对 `base` 这个词的用法根本不一致，而且没有任何地方把它们对齐过。

复现脚本（同一份代码，两种填法，两份计划）：

```text
$ node .p4-evidence/repro-branch-resolution.mjs
ground truth:  impl_a: forked from feature/impl, landed on feature/impl
               test_a: forked from feature/impl, landed on feature/test

MERGE PLAN when placement.base means "forked from" (what a real writer emits):
  impl_a -> feature/impl
  test_a -> feature/impl      ← 父分支，错的

MERGE PLAN when placement.base means "landed on" (what the test fixtures emit):
  impl_a -> feature/impl
  test_a -> feature/test      ← 夹具那一种，所以套件绿
```

**判据**：一份门禁测试的夹具，如果它的字段含义是**照着实现写的**，那它测的是"实现和自己的假设一致"，不是"实现对"。**先问这个字段在真实写入方眼里是什么意思**，再问夹具怎么填的。

**修法的形状（已落地，见 §4.7.10；本段的取舍过程保留在此）**：`normalizeEntry` 加 `branch` 字段，`foldLedger` 透传，`branchOf` 改读它；**并且在 `branch` 缺失时必须 fail closed，而不是回落到 `placement.base`**——回落到今天这个字段，正是这个缺陷的成因。缺失时该报什么、写 `worker-done` 时谁负责填它，都是要先定下来的设计问题，不是顺手改一行。

**另一条边界（实测，非推断）**：worker 终端的环境**不是**从派发里注入的。`buildAgentStartupPlan` 只在 `args.agentEnv` 存在时带上 `env`（`src/shared/tui-agent-startup.ts:95`），而 `agentEnv` 来自 `resolveTuiAgentLaunchEnv(agent, settings.agentDefaultEnv)`（`src/shared/agent-startup-plan-inputs.ts:60`）——**Orca 的应用设置**，不是账本派发。所以"用环境变量绕开一份坏的用户配置"在派发链上不成立：临时 `XDG_CONFIG_HOME` 能让命令行探测通过，worker 终端仍会读用户那份原配置。真正的出口是 Orca 设置里的 `agentDefaultEnv.opencode`，那是应用级设置、影响所有 opencode 终端。

#### 4.7.10 P4 第四轮：不采信上一轮"已修"，逐条做变异验证

前三节的叙述有一个共同的毛病：**修法写得像完成了，但没人核过"修完的东西有没有被守住"**。这一轮把已推上 `origin/main` 的 5 个提交逐条查守卫，查出 3 条是"只是声明"——代码改了、文档写了，但没有任何测试会在它退回原状时变红。

**方法**：每条修法先写测试，再**故意把代码退回修复前的状态**，确认门真的会红。绿不算数，红才算数。

| 缺陷 / 字段 | 上一轮的状态 | 变异结果 | 这一轮的补法 |
| --- | --- | --- | --- |
| 缺陷 17（`branchOf` 读错字段） | 已修，但夹具本身是错的 | 夹具改成 fork-from 语义后**红 9 例** | `branch` 字段 + fail closed + 2 条回归；变异退回 `placement.base` **红 3 例**；去掉 `unplaced` 计入 `ready` **红 1 例** |
| 缺陷 2（argv UNVERIFIED fail-closed） | **无测试文件、无自证、CI 不跑** | `UNVERIFIED` 改回 `ACCEPTED`，32 例全绿 | 抽出 `argvCheckExitCode` / `classifyProbeResult` 为导出纯函数 + 新建 `orchestration-argv-contract-check.test.mjs`（11 例）；变异分类器 **红 2 例** |
| 缺陷 4（桩收据形状） | 只有 `verify:` 脚本能抓，`pnpm test` 不跑 | 桩退回 `{result:{id}}`，测试套件**察觉不到** | 导出 `STUB` + 把执行体包进 `main()` + 新建 `orchestration-run-create-receipt-shape.test.mjs`（4 例，真实执行桩）；变异 **红 4 例** |
| `runtimeTaskId` 回读 | 从未被断言 | 置 `null`，19 例全绿 | 在 `orchestration-schedule-ledger.test.mjs` 加 2 例（`runtimeTaskId` 与 `branch` 回读）；变异各 **红 1 例** |

**顺带修掉的一个真 bug**：argv 检查在 probe 数组为空时返回 **0**（fail-open）——正是缺陷 2 自己要消灭的形状，只是换了层。现在返回 1。

**这一轮最该记住的是变异暴露出的三件事：**

1. **门全绿和门覆盖我，是两件事。** 三个空缺里有两个（缺陷 2、缺陷 4）的测试文件**根本不存在**。上一轮我核对的是"有测试、有覆盖"，没有做的是"退回原状看它会不会红"——而只有后者能区分"守住了"和"只是写下来了"。

2. **export 出来之前，一个纯函数没法被测。** `classifyProbeResult` 和桩 `STUB` 都是包在执行体里的：不导出就只能靠 import 整个模块去触发副作用，而副作用一旦在变异时抛异常，测试框架报的是 **`Tests no tests`**——和缺陷 8（test_b 把 vitest 改写成 `node:test`）**完全同族**。一个"文件跑起来一个用例都没跑"的现象，既可能是 runner 写错，也可能是 import 侧效应炸了，两者的修法不同，别混为一谈。

3. **夹具会替实现说谎，而且夹具自己可以被守卫。** 缺陷 17 的夹具把 `placement.base` 填成落地分支，正是实现的误解。把它改成 fork-from 语义，门当场红 9 例——**修好夹具比修好代码更需要先看一眼**。

**一条顺带的工程约束**：`orchestration-merge-gate.test.mjs` 曾经 604 有效行，顶破 `.oxlintrc.json` 对 `**/*.mjs` 的 `max-lines: 600`（与缺陷 14 同一堵墙）。分支解析那 4 例拆到新文件 `orchestration-merge-gate-branch.test.mjs`，原文件回到 562 行。**每加一批测试都要先问它会不会把某个文件顶破上限**，因为上限破了之后最省事的动作是豁免，而豁免会把门变成装饰。

**当前门禁**：`config/scripts/orchestration-*.test.mjs` 共 10 个文件 / 153 例全绿；`oxlint config/scripts/ src/main/agent-trust-presets.ts` 无输出；`verify:orchestration-generated-script` PASS；`verify:orchestration-argv-contract` schema 7/7（probe 需 `--live`，未跑）。

**这一轮差点重复它自己刚发现的错误。** 上面每个测试文件都验证过"退回原状会红"，但**没人问过"它会不会真被跑"**。自查结果是：会——但我第一次自查时用的命令是错的。

```text
npx vitest run config/scripts/orchestration-*.test.mjs          # 我先报的那条
→ 走默认配置，不带那三个 setupFiles，不是 pnpm test 会走的路径
```

**接线链（逐段核实）**：`config/vitest.config.ts` 的 `include` 含 `config/scripts/**/*.test.mjs` → `unit-tests.yml:49` 跑**全套**（只有 `--exclude` 列表，其中 `config/scripts` 出现 **0** 次）并按 8 个 shard 切分 → 由 `pr.yml:610` 触发。用真实 config 重跑 `npx vitest run --config config/vitest.config.ts config/scripts/orchestration-`，10 文件 / 153 例通过。

**但仍有一类门没有接线，必须点名列出来**：

| 门 | 在 `pnpm test` | 在 CI | 备注 |
| --- | --- | --- | --- |
| `orchestration-*.test.mjs`（本轮 4 个文件） | 是 | 是（8 shard 之一） | 已核实 |
| `verify:orchestration-generated-script` | 否 | **否**（`.github/` 中 0 次命中） | 纯手工；其核心逻辑已被 `orchestration-run-create-receipt-shape.test.mjs` 覆盖，但**脚本自身的 argv/退出码行为**仍只靠手跑 |
| `verify:orchestration-argv-contract` | 否 | **否** | 同上；且 `--live` 探针**从未跑过**（它会创建真实 Task） |
| `verify:orchestration-ledger-concurrency` | 否 | **否** | 压测，耗时大概是被排除在 CI 之外的原因 |

**判据**：「有测试」与「测试守住」之间还隔着「测试被执行」这一段，而这一段**完全静默**——接线没做时，本地绿、CI 绿、review 绿，只是从来没有任何一次提交会因它失败。**加守卫而不接线，是最常见的腐化方式，且不会留下任何痕迹。** 上表应当被视为待办：要么接进 CI，要么明确承认它们是手工门——两者都行，唯独不能默认它已经被覆盖。

**这一轮先搞错了一件事，纠正后才发现真正的洞。** 上一轮我写"全仓没有任何自动 `worker-done` 写入方"，依据是编译器 / 桩 / 四个驱动脚本各 0 次命中。这个结论**是错的**——写入方有两个，而且一直都在：

| 写入方 | 入口 | 契约校验 | 能带 `branch` 吗 |
| --- | --- | --- | --- |
| `orchestration-schedule-ledger.mjs record` | `--entry/--stdin/--receipts` | 无 | **能**（通用 JSON 透传） |
| `orchestration-merge-gate.mjs record-done` | 逐字段 flag | 有（`buildDoneEntry` 校验裁决/报告/回归） | **不能**——修之前 |

错在哪：我的 grep 只搜了"谁自动调用它"，没有搜"谁**提供**写入能力"。前者为 0 不代表写入方不存在，只代表**没接进派发流**。**一个 0 至少要问两次它到底在数什么。**

**而这条纠正直接挖出了一个真的洞。** `record-done` 是协调者按文档会用的那条命令，它走 `doneInput()` + `buildDoneEntry()`——两处都是**白名单式**构造字段，`branch` 都不在里面：

```js
// orchestration-verdict-contract.mjs，buildDoneEntry
reportPath: input.report ?? null,
filesModified: input.file,     // ← 没有 branch
```

后果比"少个字段"更糟：**传了也不报错，直接被丢掉。** 也就是说缺陷 17 的修法在官方路径上是**不可用的**——协调者老老实实走 `record-done`，branch 被静默吞掉，门继续报 `NOT PLANNED`，而所有人都会以为"我已经记了"。

**判据**：**一个白名单式构造函数，会把"调用方传了但你没接"这件事变成静默。** 逐字段构造的好处是不给字段留模糊空间，代价是新增字段必须同时改三处（构造、CLI 解析、契约）——而**漏改的失败模式是沉默的**。凡是逐字段构造的形状，**每个字段都要有一条"我传了它、它真的到了"的测试**。

修法：`doneInput()` 与 `buildDoneEntry()` 各加一行 `branch`，两条测试分别守住两层。变异验证——丢掉 `buildDoneEntry` 里的 `branch` → **红 2**（含 CLI 那条）；让 `doneInput` 不转发 → **红 1**（只有 CLI 那条红，两层独立）。

**"回填 branch 后计划对不对"已用真实账本实测**（`.p4-evidence/35-merge-plan-with-branch.txt`，可由 `backfill-branch.mjs` 复现）。修复前每行都是父分支、`halfking/test_a` 根本不在计划里；回填后：

```text
ORDER
  1. impl_a         halfking/impl_a-2
  2. test_a         halfking/test_a
  3. impl_b         halfking/impl_b     | shares files with test_b
  4. test_b         halfking/test_b2    | shares files with impl_b
```

**剩下的问题已做过只读勘查，答案是确定的（`.p4-evidence/36-where-the-branch-is-available.md`）**，它比"需要人来定"具体得多：

1. **派发时不知道落地分支，而且这是对的。** `runtime-local-worktree-create-candidate.ts:87-104` 在一个**避让循环**里算分支名——名字取决于仓库里什么已被占用。本 run 自己的收据就是证据：worktree 叫 `pilot-impl-a-2`、分支是 `refs/heads/pilot-impl-a-2`，那个 `-2` 因为 `pilot-impl-a` 已存在。所以"派发时把 branch 记下来"**不成立**。
2. **创建完的那一刻，运行时就知道。** `createWorkerWorktree` 返回完整的 worktree 记录（`worker-worktree-creation.ts:134-138`），其中带 `branch`——实测 `worktree.branch = refs/heads/pilot-impl-a-2`。
3. **编排层把它扔了。** `worker-start-agent-placement.ts:35` 是 `type PlacedWorktree = { id: string; repoId: string }`：把上面那条完整记录**裁成两个字段**，`branch` 不在其中。**门禁唯一需要的字段，恰好在它免费可得的那一点被丢掉。** 这与缺陷 17 是同一形状，只是高一层。
4. **账本的 `placement.worktree` 也不能用来反查。** 它看着像标识符其实不是：impl_a / impl_b 两行记的是 CLI 选择器字面量 `new-child`（实际目录叫 `impl_a-2`），test_a / test_b / test_b2 才是真目录名。**同一个字段在不同行是两种东西**——和 `placement.base` 一模一样，靠它反查会静默失败。

**所以问题不是"谁来记"，而是"记哪个字段"**：来源只能是 `createWorkerWorktree` 返回的 worktree 记录，需要 `PlacedWorktree` 保留 `branch` 并由 worker-start 收据暴露出来。**"问 worker 落在哪"是多余的**（运行时不用问就知道），**"settle 时查账本"是走不通的**（字段不可用）。

这是一个既有返回类型的**小幅拓宽**，不是设计题——但它要改 Orca 运行时，而本文档"风险与边界"一节把改上游运行时明确划在默认路径之外。**记录在案，未实现**，等一个愿意做这个决定的人。

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
