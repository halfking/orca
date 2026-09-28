#!/usr/bin/env node
// Feed every argv this project generates to the real orca binary and classify what comes back.
//
// Why: "the flag exists in our compiler" is not "the binary accepts that flag". The kaixuan provider
// preset work shipped 24 green assertions against a shape the CLI silently dropped. Here the same
// class of error is possible in the other direction — we emit argv that the binary would reject —
// and the only way to know is to hand it to the binary.
//
// A runnable invocation fails on runtime_unavailable, which means argument parsing accepted the
// whole command line. A rejected shape fails on an unknown option before any runtime is consulted,
// which is the failure this script exists to catch.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const plan = {
  objective: 'verify generated argv against the real binary',
  base: 'main',
  confirmModels: true,
  models: {
    'strongest-code': 'model-strong',
    cheap: 'model-cheap',
    'strongest-reasoning': 'model-reason'
  },
  tasks: [
    {
      id: 'impl_a',
      role: 'implementer',
      title: 'implement alpha',
      spec: 'do alpha',
      writeSet: ['src/alpha.ts'],
      deps: []
    },
    { id: 'audit_a', role: 'auditor', title: 'audit alpha', spec: 'audit alpha', deps: ['impl_a'] },
    { id: 'merge', role: 'merger', title: 'merge', spec: 'merge', deps: ['audit_a'] }
  ]
}

const { compilePlan } = await import(new URL('./orchestration-wave-plan.mjs', import.meta.url).href)
const compiled = compilePlan(plan)
if (compiled.errors.length > 0) {
  process.stderr.write(`plan does not compile: ${compiled.errors.join('; ')}\n`)
  process.exit(1)
}

function classify(argv) {
  // argv[0] is the executable the generated script substitutes for $ORCA.
  const bin = argv[0]
  if (!bin) {
    return { verdict: 'SKIP', detail: 'no executable in argv' }
  }
  let stdout = ''
  let stderr = ''
  try {
    stdout = execFileSync(bin, argv.slice(1), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    stdout = String(error.stdout ?? '')
    stderr = String(error.stderr ?? '')
  }
  const text = `${stdout}${stderr}`
  if (
    /Unknown flag|Unknown option|Unknown argument|unknown option|unexpected argument/i.test(text)
  ) {
    return { verdict: 'REJECTED', detail: text.replace(/\s+/g, ' ').slice(0, 200) }
  }
  if (
    /runtime_unavailable|not running|Could not read Orca runtime|Start the Orca app/i.test(text)
  ) {
    return { verdict: 'ACCEPTED', detail: 'parsed; runtime not running, as expected' }
  }
  if (/invalid_argument|Missing required|must be one of|expected/i.test(text)) {
    return { verdict: 'SHAPE-ERROR', detail: text.replace(/\s+/g, ' ').slice(0, 200) }
  }
  return { verdict: 'UNKNOWN', detail: text.replace(/\s+/g, ' ').slice(0, 200) || '(no output)' }
}

/**
 * A checker that cannot fail is worse than no checker: it reports seven accepted commands whether
 * or not the binary understands them. These two controls must be rejected, or this script has lost
 * the ability to tell a good argv from a bad one and should say so instead of reporting success.
 */
function runNegativeControls() {
  const controls = [
    {
      name: 'unknown flag',
      argv: ['orca', 'orchestration', 'worker-start', '--task', 't', '--totally-made-up-flag', 'x']
    },
    {
      name: 'missing required --task',
      argv: ['orca', 'orchestration', 'gate-create', '--question', 'x', '--json']
    }
  ]
  const failures = []
  for (const control of controls) {
    const { verdict } = classify(control.argv)
    if (verdict !== 'REJECTED' && verdict !== 'SHAPE-ERROR') {
      failures.push(`${control.name}: classified as ${verdict}, expected a rejection`)
    }
  }
  return failures
}

const controlFailures = runNegativeControls()
if (controlFailures.length > 0) {
  process.stderr.write(
    `checker cannot detect a bad command line, so its verdicts mean nothing:\n${controlFailures
      .map((line) => `  - ${line}`)
      .join('\n')}\n`
  )
  process.exit(1)
}
process.stdout.write('negative controls: both bad command lines were detected\n\n')

const results = []
for (const step of compiled.steps) {
  // Runtime ids and shell variables do not exist outside the generated script; substitute values
  // that are well-formed so any complaint is about the flag shape, not the placeholder.
  const argv = step.argv.map((part) =>
    part.replace(/^\$[A-Z_]+$/, 'task_placeholder').replace(/^\$\{?[A-Z_]+\}?$/, 'task_placeholder')
  )
  const { verdict, detail } = classify(argv)
  results.push({ command: step.kind, argv, verdict, detail })
  process.stdout.write(
    `${verdict.padEnd(11)} ${step.kind.padEnd(13)} ${argv.slice(1, 4).join(' ')}\n`
  )
  if (verdict !== 'ACCEPTED') {
    process.stdout.write(`            -> ${detail}\n`)
  }
}

const bad = results.filter(
  (result) => result.verdict === 'REJECTED' || result.verdict === 'SHAPE-ERROR'
)
const unknown = results.filter((result) => result.verdict === 'UNKNOWN')
process.stdout.write(
  `\n${results.length} commands: ${results.length - bad.length - unknown.length} accepted, ` +
    `${bad.length} rejected, ${unknown.length} unknown\n`
)

const dir = mkdtempSync(join(tmpdir(), 'orca-argv-'))
writeFileSync(join(dir, 'result.json'), JSON.stringify(results, null, 2))
process.stdout.write(`detail: ${join(dir, 'result.json')}\n`)
process.exitCode = bad.length === 0 && unknown.length === 0 ? 0 : 1
