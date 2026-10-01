import { describe, expect, it } from 'vitest'
import {
  branchFromWorktreeId,
  landingBranchFromReceipt,
  normalizeBranch,
  worktreeIdFromReceipt
} from './orchestration-landing-branch.mjs'

/**
 * The landing branch comes from the worker's own start receipt, not from `placement.base` (the
 * branch it forked FROM) and not from `placement.worktree` (the CLI selector literal). The
 * worker-start receipt names the created worktree in `effects`, and `worktree.show` resolves that
 * id to a record carrying `branch` — so the whole path is read-only and needs no runtime change.
 *
 * The positive controls use the real receipt shapes captured from the P4 run: the worktree id is
 * the composite `<repoId>::<abs path>` the runtime reports, and the branch comes back fully
 * qualified as `refs/heads/...`, which is why normalizeBranch exists at all.
 */

/** A worker-start receipt as the runtime actually returns it: `result.effects`. */
const receiptWithWorktree = (worktreeId) => ({
  ok: true,
  result: {
    dispatchId: 'dispatch-1',
    state: 'ready',
    effects: [
      { kind: 'worktree', action: 'created_child', id: worktreeId },
      { kind: 'terminal', role: 'agent', id: 'term-1' },
      { kind: 'setup', action: 'default', state: 'not_configured' }
    ]
  }
})

const REPO_WORKTREE_ID =
  'b7318008-3185-41d4-8f51-07c3e09ec492::/Users/xutaohuang/orca/workspaces/orca-wt-orca2/impl_a-2'

describe('worktreeIdFromReceipt', () => {
  it('reads the worktree id out of a real worker-start receipt', () => {
    expect(worktreeIdFromReceipt(receiptWithWorktree(REPO_WORKTREE_ID))).toBe(REPO_WORKTREE_ID)
  })

  it('ignores terminal and setup effects', () => {
    const receipt = receiptWithWorktree(REPO_WORKTREE_ID)
    expect(receipt.result.effects.filter((e) => e.kind === 'worktree')).toHaveLength(1)
    expect(worktreeIdFromReceipt(receipt)).toBe(REPO_WORKTREE_ID)
  })

  it('refuses a receipt that names no worktree', () => {
    expect(worktreeIdFromReceipt({ ok: true, result: { effects: [] } })).toBeNull()
  })

  it('refuses a missing, error, or malformed receipt', () => {
    expect(worktreeIdFromReceipt(null)).toBeNull()
    expect(worktreeIdFromReceipt(undefined)).toBeNull()
    expect(worktreeIdFromReceipt({ ok: false, error: { code: 'task_not_startable' } })).toBeNull()
    expect(worktreeIdFromReceipt({ result: { effects: 'not-an-array' } })).toBeNull()
  })

  it('refuses when the receipt names two different worktrees rather than picking one', () => {
    const receipt = receiptWithWorktree(REPO_WORKTREE_ID)
    receipt.result.effects.push({ kind: 'worktree', action: 'reused', id: 'repo::other' })
    expect(worktreeIdFromReceipt(receipt)).toBeNull()
  })
})

describe('normalizeBranch', () => {
  it('strips refs/heads to the short name the ledger records', () => {
    expect(normalizeBranch('refs/heads/halfking/impl_a-2')).toBe('halfking/impl_a-2')
    expect(normalizeBranch('refs/heads/pilot-impl-a-2')).toBe('pilot-impl-a-2')
  })

  it('leaves an already-short name alone', () => {
    expect(normalizeBranch('halfking/impl_a-2')).toBe('halfking/impl_a-2')
  })

  it('refuses empty and non-string branches', () => {
    expect(normalizeBranch('')).toBeNull()
    expect(normalizeBranch('   ')).toBeNull()
    expect(normalizeBranch(null)).toBeNull()
    expect(normalizeBranch(undefined)).toBeNull()
  })
})

describe('branchFromWorktreeId', () => {
  it('resolves the branch through worktree.show', () => {
    const asked = []
    const branch = branchFromWorktreeId(REPO_WORKTREE_ID, (id) => {
      asked.push(id)
      return { id, branch: 'refs/heads/halfking/impl_a-2' }
    })
    expect(branch).toBe('halfking/impl_a-2')
    expect(asked).toEqual([REPO_WORKTREE_ID])
  })

  it('refuses an empty worktree id without asking anything', () => {
    let asked = 0
    expect(
      branchFromWorktreeId('', () => {
        asked += 1
        return { branch: 'refs/heads/x' }
      })
    ).toBeNull()
    expect(asked).toBe(0)
  })
})

describe('landingBranchFromReceipt', () => {
  const showWorktree = (id) => ({ id, branch: `refs/heads/halfking/${id.slice(-8)}` })

  it('resolves end to end from a real receipt', () => {
    expect(landingBranchFromReceipt(receiptWithWorktree(REPO_WORKTREE_ID), showWorktree)).toBe(
      'halfking/impl_a-2'
    )
  })

  it('returns null — never a guess — when the receipt cannot name a worktree', () => {
    expect(landingBranchFromReceipt({ ok: false, error: { code: 'selector_ambiguous' } })).toBeNull()
  })

  it('returns null when worktree.show throws: unproven is not empty', () => {
    const boom = () => {
      throw new Error('selector_not_found')
    }
    expect(landingBranchFromReceipt(receiptWithWorktree(REPO_WORKTREE_ID), boom)).toBeNull()
  })

  it('returns null when the worktree record carries no branch', () => {
    expect(landingBranchFromReceipt(receiptWithWorktree(REPO_WORKTREE_ID), () => ({ id: 'x' }))).toBeNull()
  })
})
