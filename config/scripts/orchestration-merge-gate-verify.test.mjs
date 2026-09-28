import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/** The gate as a child process, so these cases read its exit code and not only its API. */
const gatePath = join(import.meta.dirname, 'orchestration-merge-gate.mjs')

/** Run the gate and hand back what a caller would see, including the exit code it exits with. */
function gate(args) {
  try {
    return {
      stdout: execFileSync('node', [gatePath, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }),
      status: 0
    }
  } catch (error) {
    return {
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
      status: error.status ?? 0
    }
  }
}

describe('a ledger with nothing in it', () => {
  // Found live during P4: `verify` on an empty file — and on a path that does not exist — printed
  // MERGE GATE: OPEN and exited 0. The gate reported success on the absence of evidence, and a typo
  // in --ledger looked exactly like approval to merge.
  it('closes on an empty ledger, and says so in the exit code as well as the verdict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-gate-empty-'))
    try {
      const ledger = join(dir, 'empty.jsonl')
      writeFileSync(ledger, '')
      const { stdout, status } = gate(['verify', '--ledger', ledger, '--json'])
      const result = JSON.parse(stdout)
      expect(result.ready).toBe(false)
      expect(result.blockers.join(' ')).toContain('ledger records no task')
      expect(status).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a ledger path that does not exist instead of folding it into an empty pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-gate-missing-'))
    const { stderr, status } = gate(['verify', '--ledger', join(dir, 'nope.jsonl')])
    rmSync(dir, { recursive: true, force: true })
    expect(stderr).toContain('no such ledger')
    expect(status).toBe(1)
  })
})
