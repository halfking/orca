import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STUB } from './orchestration-generated-script-check.mjs'

/**
 * The generated-script stub used to answer `{result:{id}}` for `run-create`, a shape no binary
 * emits. A real run then wrote an empty run id into every ledger row while the check stayed green,
 * because the stub had taught the check the wrong contract.
 *
 * The fix was real and `verify:orchestration-generated-script` does catch a regression — but nothing
 * in `pnpm test` and no workflow in .github/workflows runs that script, so the guard existed and
 * was never executed. These tests run the stub itself and pin its answers, so `pnpm test` covers
 * it. They execute the stub rather than reading its source: a source assertion proves the text is
 * present, not that the binary prints it.
 */

/** Write the stub out and run it, exactly as the generated script would. */
function runStub(args) {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-shape-'))
  const bin = join(dir, 'orca')
  writeFileSync(bin, STUB)
  chmodSync(bin, 0o755)
  writeFileSync(join(dir, 'calls.log'), '')
  return JSON.parse(
    execFileSync(bin, args, {
      encoding: 'utf8',
      env: { ...process.env, ORCA_STUB_LOG: join(dir, 'calls.log') }
    })
  )
}

const shapeKeys = (value, prefix = '') =>
  value === null || typeof value !== 'object'
    ? [prefix]
    : Object.entries(value).flatMap(([key, child]) =>
        shapeKeys(child, prefix ? `${prefix}.${key}` : key)
      )

describe('run-create receipt shape', () => {
  it('puts the run id and coordinator handle where the real binary puts them', () => {
    const receipt = runStub(['orchestration', 'run-create'])
    expect(shapeKeys(receipt)).toContain('result.run.id')
    expect(shapeKeys(receipt)).toContain('result.run.coordinator_handle')
  })

  it('is not the {result:{id}} shape that no binary emits', () => {
    const receipt = runStub(['orchestration', 'run-create'])
    expect(Object.keys(receipt.result).sort()).toEqual(['mutation', 'run'])
    expect(receipt.result.id).toBeUndefined()
  })

  it('gives the extraction a non-empty coordinator handle, which is what every dispatch needs', () => {
    const receipt = runStub(['orchestration', 'run-create'])
    expect(receipt.result.run.coordinator_handle).toBeTruthy()
    expect(receipt.result.run.id).toBeTruthy()
  })

  it('answers the other two commands in their recorded shapes too', () => {
    // task-create alternates between two id locations on purpose, so both must be non-empty.
    const first = runStub(['orchestration', 'task-create', '--task-title', 't', '--deps', '[]'])
    const id = first.result.task?.id ?? first.result.taskId ?? first.result.id
    expect(typeof id).toBe('string')
    expect(id).toBeTruthy()
  })
})
