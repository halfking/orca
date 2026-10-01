import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The CLI is the contract a settle step actually consumes: it prints a landing branch, or exits
 * non-zero with nothing on stdout. A library-only resolver would parse correctly in a unit test
 * and still be unreachable from the shell — which is how "implemented" quietly means "never run".
 * These cases drive the real binary so the exit code itself is under test.
 *
 * The positive case is the one thing this file can do without a running Orca: an empty-effects
 * receipt and a receipt whose worktree.show cannot answer must both fail closed. A receipt that
 * DOES carry a worktree effect still needs the runtime, so it is covered by the unit tests, not
 * here.
 */
const CLI = join(import.meta.dirname, 'orchestration-landing-branch.mjs')

function runCli(receipt, ...extra) {
  const dir = mkdtempSync(join(tmpdir(), 'landing-branch-cli-'))
  const path = join(dir, 'receipt.json')
  writeFileSync(path, typeof receipt === 'string' ? receipt : JSON.stringify(receipt))
  try {
    const stdout = execFileSync('node', [CLI, path, ...extra], { encoding: 'utf8' })
    return { code: 0, stdout: stdout.trim() }
  } catch (error) {
    return { code: error.status ?? 1, stdout: (error.stdout ?? '').trim() }
  }
}

describe('orchestration-landing-branch CLI', () => {
  it('exits non-zero and prints usage when given no receipt', () => {
    let code = 0
    let stdout = ''
    try {
      stdout = execFileSync('node', [CLI], { encoding: 'utf8' }).trim()
    } catch (error) {
      code = error.status ?? 1
    }
    expect(code).not.toBe(0)
    expect(stdout).toBe('')
  })

  it('fails closed on a receipt with no worktree effect', () => {
    const result = runCli({ ok: true, result: { effects: [] } })
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
  })

  it('fails closed when worktree.show cannot answer (runtime unreachable)', () => {
    // The worktree id is well-formed, so the only reason this cannot resolve is that the runtime
    // cannot be reached — the exact state a settle step must refuse rather than paper over.
    const result = runCli({
      ok: true,
      result: { effects: [{ kind: 'worktree', id: 'repo::/nonexistent/wt-cli-negative' }] }
    })
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
  })

  it('fails closed on an error receipt', () => {
    const result = runCli({ ok: false, error: { code: 'task_not_startable' } })
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
  })
})
