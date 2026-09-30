# 36 — where the landing branch is (and is not) available

Read-only investigation. No code changed to produce this file.

It exists because the open question after round 5 was "who fills `branch`, and from where?". That
question turns out to be answerable from the code, and the answer is not what either of the previous
two rounds assumed.

## 1. At dispatch time the branch is unknowable — and that is not a bug

`runtime-local-worktree-create-candidate.ts:87-104` computes the branch inside the worktree-create
call, in a collision-avoidance loop:

```js
for (let suffix = 1, attempts = 0; attempts < WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS; suffix += 1) {
  effectiveSanitizedName = getWorktreeCreateCandidate(sanitizedName, suffix)
  branchName = await resolveCreateBranchName(repo.path, ..., effectiveSanitizedName, ...)
```

So the name depends on what is already taken in the repository. That is visible in this run's own
receipts: the worktree is `pilot-impl-a-2` and its branch is `refs/heads/pilot-impl-a-2` — the `-2`
because `pilot-impl-a` existed. A dispatch that has not created its worktree yet **cannot** name the
branch it will land on, so "record the branch at dispatch" is not available as stated.

## 2. Immediately after creation, the runtime does know it

`createWorkerWorktree` returns the full worktree record
(`worker-worktree-creation.ts:134-138`):

```js
return { worktree: created.worktree as Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>, terminalHandle, setupReceipt }
```

and that record carries the branch. From this run's own captured receipt
(`.p4-evidence/20-impl-a-worktree-create.json`):

```text
worktree.branch = refs/heads/pilot-impl-a-2
worktree.id     = b7318008-…::/Users/xutaohuang/orca/workspaces/orca-wt-orca2/pilot-impl-a-2
```

## 3. The orchestration placement throws the branch away

`worker-start-agent-placement.ts:35`:

```js
type PlacedWorktree = { id: string; repoId: string }
```

The rich worktree record from step 2 is narrowed to two fields, and `branch` is not one of them.
**The one field the merge gate needs is dropped at exactly the point where it is known and free.**
This is the same shape as finding 17 one layer up: a field that exists in the system and never
reaches the ledger.

## 4. The ledger's `placement.worktree` cannot be used to recover it

It looks like a worktree identifier and is not one, consistently:

| ledger `placement.worktree` | actual worktree directory |
| ---------------------------- | ------------------------- |
| `new-child` (impl_a, impl_b) | `impl_a-2`, `impl_b` |
| `test_a`, `test_b`, `test_b2`  | `test_a`, `test_b`, `test_b2` |

`new-child` is the CLI selector literal, recorded verbatim. The test rows happen to hold real
directory names. So the same field is two different kinds of thing depending on the row — exactly
what `placement.base` was. Resolving a branch through it would fail the way `placement.base` failed,
and would fail silently for the rows where the names happen to differ.

## What this settles

- "Ask the worker where it landed" is unnecessary: the runtime knows, from the moment the worktree
  exists, without asking anyone.
- "Look it up in the ledger at settle time" does not work: `placement.worktree` is not a usable key.
- The source has to be the worktree record returned by `createWorkerWorktree`, which means
  `PlacedWorktree` has to keep `branch` and the worker-start receipt has to expose it.

That is a small widening of an existing return type, not a design question — but it is a change to
the Orca runtime, which §"风险与边界" of the plan puts outside the default path ("本方案默认走规程
+ 工具路线，不改上游运行时"). It is recorded here, unbuilt, for whoever takes that decision.
