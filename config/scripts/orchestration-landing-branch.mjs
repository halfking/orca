/**
 * Where a task's work landed, resolved from the worker's own start receipt.
 *
 * Why this exists: the merge gate merges the branch a task landed ON, and a five-wave run that
 * recorded nothing merged every task's parent instead (defect 17). `placement.base` is the branch a
 * task forked FROM, so it can never answer this, and `placement.worktree` is not a usable key
 * either — it holds the CLI selector literal `new-child` for a `--worktree new-child` dispatch and
 * a real directory name for the test rows, i.e. two different kinds of thing depending on the row.
 *
 * The branch is unknowable at dispatch time (the name is computed in a collision-avoidance loop
 * during worktree creation) and known the moment the worktree exists. The worker-start receipt
 * already carries the created worktree's id in `effects` (`{kind:'worktree', id: <worktreeId>}`),
 * and `worktree.show` — an existing public RPC — resolves that id to the full record including
 * `branch`. So the whole path is read-only and touches no Orca runtime source.
 *
 * Fail-closed, always: a task whose branch cannot be proven blocks the plan rather than being
 * merged from a guess. There is deliberately NO fallback to `placement.base` — that fallback was
 * the original defect, and a wrong branch merges cleanly and quietly.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** The ref prefix the runtime reports; the ledger records the short name. */
const HEADS_PREFIX = 'refs/heads/'

/**
 * The worktree id from a worker-start receipt, or null when the receipt cannot name one.
 *
 * A dispatch records at most one worktree effect, but the shape is read defensively: an effects
 * array can hold terminal/setup/dispatch_input rows too, and a receipt that is missing, an error
 * envelope, or carries no worktree effect must not resolve to a branch.
 */
export function worktreeIdFromReceipt(receipt) {
  const effects = receipt?.result?.effects ?? receipt?.effects
  if (!Array.isArray(effects)) {
    return null
  }
  const ids = [
    ...new Set(
      effects
        .filter((effect) => effect?.kind === 'worktree' && typeof effect.id === 'string' && effect.id)
        .map((effect) => effect.id)
    )
  ]
  // More than one distinct worktree means the receipt does not single out a landing site; refuse
  // rather than pick, because a guess here merges the wrong branch without a word.
  return ids.length === 1 ? ids[0] : null
}

/**
 * `refs/heads/feature/x` -> `feature/x`. Git accepts either form, but the ledger records short
 * names, so normalize once here instead of teaching every consumer both spellings.
 */
export function normalizeBranch(raw) {
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim()
  if (trimmed === '') {
    return null
  }
  return trimmed.startsWith(HEADS_PREFIX) ? trimmed.slice(HEADS_PREFIX.length) : trimmed
}

/**
 * The branch a worktree id actually points at, via the `worktree.show` RPC.
 *
 * `showWorktree` is injected so this is unit-testable without a running Orca. The default shells
 * out to the CLI, which is the only read path a settle step needs.
 */
export function branchFromWorktreeId(worktreeId, showWorktree = defaultShowWorktree) {
  if (typeof worktreeId !== 'string' || worktreeId === '') {
    return null
  }
  const record = showWorktree(worktreeId)
  return normalizeBranch(record?.branch)
}

/**
 * End to end: worker-start receipt -> landing branch, or null when it cannot be proven.
 *
 * Returns null — never a guess — so the caller can let the gate block the task instead of merging
 * the wrong branch.
 */
export function landingBranchFromReceipt(receipt, showWorktree = defaultShowWorktree) {
  const worktreeId = worktreeIdFromReceipt(receipt)
  if (worktreeId === null) {
    return null
  }
  try {
    return branchFromWorktreeId(worktreeId, showWorktree)
  } catch {
    // worktree.show failing (selector_not_found, runtime down) is unproven, not empty.
    return null
  }
}

/** The real read path: `orca worktree show <id> --json`. Throws if the runtime cannot answer. */
function defaultShowWorktree(worktreeId) {
  const stdout = execFileSync('orca', ['worktree', 'show', worktreeId, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return JSON.parse(stdout)?.result?.worktree ?? null
}

/**
 * CLI: `node orchestration-landing-branch.mjs <worker-start-receipt.json> [--json]`.
 *
 * Prints the landing branch, or exits non-zero with nothing on stdout when it cannot be proven.
 * The exit code is the contract: a settle step that shells out to this must fail loudly rather than
 * record a guessed branch, because a wrong branch merges cleanly and quietly.
 */
function main(argv) {
  const path = argv.find((arg) => arg !== '--json')
  if (!path) {
    process.stderr.write(
      'usage: orchestration-landing-branch.mjs <worker-start-receipt.json> [--json]\n'
    )
    process.exitCode = 1
    return
  }
  const receipt = JSON.parse(readFileSync(path, 'utf8'))
  const branch = landingBranchFromReceipt(receipt)
  if (branch === null) {
    process.stderr.write(
      'cannot prove a landing branch from this receipt (no worktree effect, or worktree.show failed); ' +
        'refusing to guess\n'
    )
    process.exitCode = 1
    return
  }
  process.stdout.write(`${branch}\n`)
}

if (process.argv[1] && process.argv[1].endsWith('orchestration-landing-branch.mjs')) {
  main(process.argv.slice(2))
}
