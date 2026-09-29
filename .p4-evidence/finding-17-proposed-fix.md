# P4 finding 17 — proposed fix, not landed

Status: **proposal**. The gate's merge semantics are not changed here; this file is the analysis
that makes the change mechanical once the design question below is answered.

## What is wrong

`orchestration-merge-gate.mjs:130`

    const branchOf = (id) => view.folded.tasks.find((t) => t.id === id)?.placement?.base ?? null

`placement.base` is where a task forked FROM. The branch a task landed ON is not in the ledger at
all, so the gate merges the parent branch of every task. `halfking/test_a` never gets merged.

## Who is right, and who is the odd one out

Every writer in the tree fills `placement.base` with the fork point, consistently:

| writer                                          | what it puts in `placement.base`      |
| ----------------------------------------------- | ------------------------------------- |
| `config/scripts/orchestration-wave-plan.mjs:273` | `base` (the plan's base)              |
| `.p4-evidence/p4.mjs:61`                         | `launch.base`                         |
| `.p4-evidence/p4-wave1.mjs:84`                   | `task.base`                           |
| `.p4-evidence/p4-retry-test-b.mjs:95`            | `'halfking/impl_b'`                   |
| `.p4-evidence/p4-finish.mjs:184`                 | `task.base`                           |

The **test fixtures are the only thing that disagrees** — they put the landing branch there
(`orchestration-merge-gate.test.mjs:64,73`: `base: 'feature/a'`). So this is a reader bug plus a
fixture that mirrors it, not five writers that mean different things.

## The design question, and why it mostly answers itself

The naive fix — "fall back to something sensible when `branch` is missing" — is the trap, because
the current fallback *is* the defect.

The question looks like "should a missing `branch` fail closed?" and the answer is yes, because
there is no other correct answer. The genuinely open part is narrower than it first appears:

**Which entry carries `branch`?** Not `worker-start` — at that moment the landing branch does not
exist yet. The worker-start line in the compiler (`orchestration-wave-plan.mjs:273`) is emitted
before any branch is created, so `branch` can only go on **`worker-done`**.

**Who writes it?** Whoever settles the task. In this pilot that was the coordinator, because the
supervised worker's process does not know where its work will be committed — the coordinator
committed on the worker's behalf. That is the general shape: the settling party records the branch
it landed the work on.

## What the ledger should have said for run_f8f2a6573946

| task     | `placement.base` recorded (fork from) | landing branch (missing)   | commit   |
| -------- | ------------------------------------- | -------------------------- | -------- |
| impl_a   | `pilot/p4-two-task-pilot`              | `halfking/impl_a-2`        | `f5e8094c9` |
| impl_b   | `pilot/p4-two-task-pilot`              | `halfking/impl_b`          | `e02925230` |
| test_a   | `halfking/impl_a-2`                    | `halfking/test_a`          | `60d6036c8` |
| test_b   | `halfking/impl_b`                      | — (rejected, nothing landed) | —     |

Note the first row: the landing branch is `halfking/impl_a-2`, not `halfking/impl_a`. The `-2` is
why a name-guessing fix would also be wrong — the ledger has to record the real ref.

## The change, in four parts

1. `normalizeEntry` (`orchestration-schedule-ledger.mjs:44-71`) gains `branch: raw.branch ?? null`,
   and `foldLedger` carries it the same way it carries `runtimeTaskId`.
2. `branchOf` reads `task.branch`. When it is null the plan carries a blocker naming the task,
   instead of silently substituting `placement.base`.
3. The compiler's generated `worker-done` step writes `branch` from the commit the coordinator
   recorded. The stub in `orchestration-generated-script-check.mjs` has to answer the new field.
4. The fixtures at `orchestration-merge-gate.test.mjs:64,73` are corrected to fork-from semantics,
   plus one regression test that feeds a realistic two-link chain and asserts the plan names
   `feature/test` — the case the current suite cannot express.

## How to prove it

    node .p4-evidence/repro-branch-resolution.mjs

Before the change: the `forked-from` block prints `test_a -> feature/impl`.
After: it must print `test_a -> feature/test`, and the existing 56 tests must still pass against
the corrected fixtures. A fix that only makes the repro pass while the fixtures stay landing-shaped
has not fixed anything — it has just moved the lie.
