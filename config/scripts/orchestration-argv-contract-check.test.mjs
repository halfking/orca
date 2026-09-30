import { describe, expect, it } from 'vitest'
import { argvCheckExitCode, classifyProbeResult } from './orchestration-argv-contract-check.mjs'

/**
 * These exist because two of the eight defects the P4 pilot fixed had no guard at all, and the
 * one that did had a guard nothing ran.
 *
 * Defect 2 — the argv check used to report ACCEPTED for a command line it had only parsed. The fix
 * splits it into a schema layer and a `--live` probe, and makes an unexercised shape UNVERIFIED
 * and failing. The exit-code decision then lived inline at the bottom of a script that also does
 * filesystem and subprocess work. Mutating `UNVERIFIED` to `ACCEPTED` left the file green and there
 * was no test to notice, because the check has no vitest file of its own.
 *
 * Defect 4 — the generated-script stub used to answer `{result:{id}}`, a shape no binary emits. It
 * was fixed, and `verify:orchestration-generated-script` does catch a regression, but nothing in
 * `pnpm test` and no workflow in .github/workflows runs that script. The guard existed and was
 * never executed.
 */
describe('argv check exit code', () => {
  const schemaOk = []
  const schemaBad = [{ name: 'x', detail: 'bad flag' }]

  it('passes when the schema layer is clean and no live probe ran', () => {
    expect(argvCheckExitCode({ schemaBad: schemaOk, probeResults: undefined })).toBe(0)
  })

  it('fails when the schema layer found something', () => {
    expect(argvCheckExitCode({ schemaBad: schemaBad, probeResults: undefined })).toBe(1)
  })

  it('fails when a live probe came back unverified, because unexercised is unproven', () => {
    const probe = [{ verdict: 'UNVERIFIED', detail: 'parsed, runtime not consulted' }]
    expect(argvCheckExitCode({ schemaBad: schemaOk, probeResults: probe })).toBe(1)
  })

  it('records the gap instead of hiding it when the operator asks for --allow-unverified', () => {
    const probe = [{ verdict: 'UNVERIFIED', detail: 'parsed, runtime not consulted' }]
    expect(
      argvCheckExitCode({ schemaBad: schemaOk, probeResults: probe, allowUnverified: true })
    ).toBe(0)
  })

  it('fails on a rejected, shape-error or unknown verdict', () => {
    for (const verdict of ['REJECTED', 'SHAPE-ERROR', 'UNKNOWN']) {
      expect(argvCheckExitCode({ schemaBad: schemaOk, probeResults: [{ verdict }] })).toBe(1)
    }
  })

  it('passes when every probed shape was actually exercised', () => {
    expect(
      argvCheckExitCode({ schemaBad: schemaOk, probeResults: [{ verdict: 'REACHABLE' }] })
    ).toBe(0)
  })

  it('does not accept an empty probe array as proof', () => {
    // An empty array means --live ran and produced nothing. That is silence, not success.
    expect(argvCheckExitCode({ schemaBad: schemaOk, probeResults: [] })).toBe(1)
  })
})

/**
 * The exit-code tests above feed it verdicts. These feed it text, because the classification is a
 * second, independent way the same fix can be undone — and the first attempt at guarding this file
 * guarded only the exit code. Changing the classifier to say ACCEPTED left the suite green.
 */
describe('probe result classification', () => {
  it('calls a runtime-down error unverified, not accepted', () => {
    for (const text of [
      'runtime_unavailable',
      'Orca is not running',
      'Could not read Orca runtime',
      'Start the Orca app first'
    ]) {
      expect(classifyProbeResult(text).verdict).toBe('UNVERIFIED')
    }
  })

  it('calls an unknown flag rejected', () => {
    expect(classifyProbeResult('Unknown flag: --nope').verdict).toBe('REJECTED')
  })

  it('calls a missing required value a shape error', () => {
    expect(classifyProbeResult('Missing required argument --task').verdict).toBe('SHAPE-ERROR')
  })

  it('feeds the whole chain: runtime down classifies unverified, and that fails the check', () => {
    const probe = [classifyProbeResult('runtime_unavailable')]
    expect(probe[0].verdict).toBe('UNVERIFIED')
    expect(argvCheckExitCode({ schemaBad: [], probeResults: probe })).toBe(1)
  })
})
