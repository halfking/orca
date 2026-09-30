# P4 pilot — where this stands

Run: `run_f8f2a6573946`. Ledger: `../.orca/orchestration-ledger/run_f8f2a6573946.jsonl`.
Plan: `../p4-pilot-plan.json`. Findings: `docs/reference/parallel-task-orchestration.md` §4.7.7–4.7.9.

## What ran

| wave | task        | agent   | outcome                                                     |
| ---- | ----------- | ------- | ----------------------------------------------------------- |
| 0    | impl_a      | opencode| accepted — barriers in the compiled wave plan               |
| 0    | impl_b      | opencode| accepted — `merge --record-to` trail                         |
| 1    | test_a      | opencode| accepted — 36 cases, both runners                            |
| 1    | test_b ×2   | opencode| **rejected twice**, recorded as such                        |
| 2    | audit_a/b   | cursor  | **not dispatched** — no independent agent available          |
| —    | merge       | —       | **not executed** — gate closed, and see finding 17           |

test_b attempt 1 rewrote a vitest file to `node:test`; attempt 2 passed 41 cases but all four
were duplicates of coverage impl_b had already shipped. Both rejections are in the ledger.

## Two things stand between this and done

1. **An independent audit agent.** `cursor-agent` is installed but not logged in. Every other
   route was measured: claude has no cc-switch provider with a `base_url`; apiclaude/apigpt report
   insufficient balance; opencode-go needs a subscription; glm-5.2 reports an expired token;
   `kaixuan/minimax-m3` is the implementers' own model and cannot be the auditor. Run
   `cursor-agent login`, then:

       P4_AUDIT_AGENT=cursor node .p4-evidence/p4-finish.mjs preflight
       P4_AUDIT_AGENT=cursor node .p4-evidence/p4-finish.mjs audit

2. **Finding 17 — the gate merges the wrong branch.** `buildMergePlan` resolves a task's branch
   from `placement.base`, which is the branch it forked *from*. The branch it landed on is not in
   the ledger at all. On this run that means `halfking/test_a` would never be merged and
   `halfking/impl_a-2` would be merged in its place. **Do not run `merge --execute` against the
   real ledger until this is fixed** — the gate's own output is the only warning you get.

## What is already measured, so nobody has to measure it again

| file                                                                   | what it establishes                                                                 |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `30-gate-before-audit.txt`                                             | the gate was closed before any test work, with reasons named                        |
| `31-gate-after-test-b2.txt`                                            | the same gate after the retry: only audit verdicts remain                          |
| `32-merge-order-preflight.txt`                                         | the suggested order merges cleanly on origin/main; 81 tests, oxlint clean, gates pass |
| `33-closed-gate-execute-guard.txt`                                     | `merge --execute` refuses while closed and leaves the repository untouched          |
| `34-open-gate-execute-merge.txt`                                       | `merge --execute` really does merge in order when open — the machine is not broken   |
| `repro-branch-resolution.mjs`                                          | finding 17, in two lines of output; exits 0 on the bug                              |
| `resolve-branch-from-repo.mjs`                                         | the cheap fix (infer the branch from git) measured and rejected                      |
| `finding-17-proposed-fix.md`                                           | the fix shape, its cost, and the design question left open                          |

Taken together: the merge machinery is sound in both directions and is fed one wrong ref.

## Cleanup notes

- `../../orca-wt-orca2/test_b2` still holds the four rejected cases as an uncommitted diff — the
  evidence for that rejection. `halfking/test_b2` points at `e02925230`, same as `halfking/impl_b`.
- `.orca/orchestration-ledger/r.jsonl` is a truncated file from an abandoned dispatch; not committed.
- The shared worktree `../../orca` and the other session's `../orca-wt-ledger` were never touched.
