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

**Who writes it?** Whoever settles the task — and the honest answer here is *nobody does it
automatically*. Measured across the tree: `worker-done` appears **0 times** in the compiler, **0
times** in the generated-script stub, and **0 times** in any of this pilot's four driver scripts.
Every `worker-done` line in `run_f8f2a6573946.jsonl` was appended by the coordinator by hand, as
inline JSON, during the run. That is also why the supervised worker's process cannot supply it: the
worker does not know where its work will be committed — the coordinator committed on its behalf.

So the design answer is: **`branch` goes on `worker-done`, written by the settling party, and
today that party is a human.** Making it fail closed therefore means deciding what a settle flow
looks like when there is no automated settler — otherwise a hand-written ledger would stop merging
entirely, which is correct but not usable.

## What the ledger should have said for run_f8f2a6573946

| task     | `placement.base` recorded (fork from) | landing branch (missing)   | commit   |
| -------- | ------------------------------------- | -------------------------- | -------- |
| impl_a   | `pilot/p4-two-task-pilot`              | `halfking/impl_a-2`        | `f5e8094c9` |
| impl_b   | `pilot/p4-two-task-pilot`              | `halfking/impl_b`          | `e02925230` |
| test_a   | `halfking/impl_a-2`                    | `halfking/test_a`          | `60d6036c8` |
| test_b   | `halfking/impl_b`                      | — (rejected, nothing landed) | —     |

Note the first row: the landing branch is `halfking/impl_a-2`, not `halfking/impl_a`. The `-2` is
why a name-guessing fix would also be wrong — the ledger has to record the real ref.

## The cheap alternative, measured and rejected

Before adding a field, the obvious cheaper fix is to let the repository answer: for each task, find
branches that carry write-set commits the fork base does not have. That needs no schema change and
no settle helper. Measured against this run (`.p4-evidence/resolve-branch-from-repo.mjs`):

| variant                                          | result                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| strict: branch forked exactly at the base tip     | 1/4 resolved, three silent misses — the base moves on after dispatch, so a correct branch stops equalling the tip |
| relaxed: drop the fork check, keep the write set  | 3/4 ambiguous, and the one unique hit is **wrong** — `test_b` resolves to `feat/orchestration-schedule-ledger` |

The second row is the reason this alternative is rejected rather than preferred. **An
inference-based fix does not fail loudly where it is unsure — it returns a confident wrong
answer.** A wrong branch merges cleanly and quietly, which is strictly worse than today's honest
state (a gate reading a field that means the wrong thing, and printing that field in its plan
where a reader can see it).

So the ledger must carry the landing branch, and the branch-setter must record it: the repository
cannot recover it afterwards, and least of all once a branch is reset onto its parent, where
nothing on disk distinguishes the two.

## Blast radius: the gate tool only

The compiled wave plan is not affected. For the merge task the compiler emits `gate-create` — a
human decision gate — and no merge command and no branch resolution
(`orchestration-wave-plan.mjs:325-348`); it emits no `worker-done` step at all. So the wrong
resolution lives in exactly one place: `buildMergePlan`, which is invoked by the coordinator
(as `.p4-evidence/p4-finish.mjs` does), not by the generated script.

## The change, in four parts

1. `normalizeEntry` (`orchestration-schedule-ledger.mjs:44-71`) gains `branch: raw.branch ?? null`,
   and `foldLedger` carries it the same way it carries `runtimeTaskId`.
2. `branchOf` reads `task.branch`. When it is null the plan carries a blocker naming the task,
   instead of silently substituting `placement.base`.
3. Whoever writes `worker-done` writes `branch` — and since nothing writes `worker-done`
   automatically today, this step needs a settle helper that takes the landing branch and refuses
   to write the entry without it. That helper is the real work here; the field itself is one line.
   Without it, "fail closed" just means hand-written ledgers stop merging.
4. The fixtures at `orchestration-merge-gate.test.mjs:64,73` are corrected to fork-from semantics,
   plus one regression test that feeds a realistic two-link chain and asserts the plan names
   `feature/test` — the case the current suite cannot express.

## How to prove it

    node .p4-evidence/repro-branch-resolution.mjs

Before the change: the `forked-from` block prints `test_a -> feature/impl`.
After: it must print `test_a -> feature/test`, and the existing 56 tests must still pass against
the corrected fixtures. A fix that only makes the repro pass while the fixtures stay landing-shaped
has not fixed anything — it has just moved the lie.
