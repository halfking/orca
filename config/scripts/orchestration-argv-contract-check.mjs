#!/usr/bin/env node
// Check every argv this project generates against the real orca binary, without disturbing anything.
//
// Why: "the flag exists in our compiler" is not "the binary accepts that flag". The kaixuan provider
// preset work shipped 24 green assertions against a shape the CLI silently dropped. Here the same
// class of error is possible in the other direction — we emit argv that the binary would reject —
// and the only way to know is to ask the binary itself.
//
// Two checks, because one alone has already lied twice:
//
//   1. Schema (always): every flag we emit is looked up in `orca agent-context`, the binary's own
//      declaration. No runtime, no side effects, runs in CI.
//   2. Live probe (only with --live): the command is actually invoked. A live runtime EXECUTES what
//      it parses — running this check against a running app created three real Tasks in the adopted
//      Run, and nothing in the tool could undo them. So the probe is opt-in, and it is a shape
//      check, not a dry run: it says nothing about placement, ids, or bindings.
//
// A probe against a stopped runtime is not a pass. The binary refuses at the runtime gate and never
// resolves the values inside the argv, so every command came back "accepted" while a real run of
// that same argv failed with `selector_not_found`. Parsed is not exercised.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LIVE = process.argv.includes('--live')
const ALLOW_UNVERIFIED = process.argv.includes('--allow-unverified')

/**
 * The binary's own declaration of every command: command path -> the flags it accepts.
 * Reading this cannot create a Task, which is the whole reason it is the default check.
 */
function commandFlagIndex() {
  const raw = execFileSync('orca', ['agent-context', '--json'], { encoding: 'utf8' })
  const context = JSON.parse(raw)
  const index = new Map()
  for (const command of context.commands ?? []) {
    const path = (command.path ?? []).join(' ')
    index.set(path, new Set(command.flags ?? []))
  }
  return index
}

/**
 * Flags a command line uses that the binary does not declare. Shared by the check and its control,
 * so the control exercises the same comparison rather than a second implementation of it.
 */
function undeclaredFlagsFor(flagIndex, path, argv) {
  const declared = flagIndex.get(path)
  if (!declared) {
    return null
  }
  // The schema names flags without their leading dashes; comparing the raw argv would report every
  // command as undeclared, which is a checker that is wrong in the loud direction and never useful.
  return flagsIn(argv)
    .map((entry) => entry.flag.replace(/^--/, ''))
    .filter((flag) => !declared.has(flag))
}

/** Flags we emit, paired with the value that follows them. A trailing flag has no value. */
function flagsIn(argv) {
  const flags = []
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      flags.push({ flag: argv[i], value: argv[i + 1] ?? null })
    }
  }
  return flags
}

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
    // Why this is not ACCEPTED: with the runtime down the binary rejects the argv at the runtime
    // gate and never resolves the values inside it. A real run of this same command then failed on
    // `selector_not_found` — a verdict this class would have reported as fine. Parsed is not
    // exercised, and only an exercised shape was ever worth calling accepted.
    return {
      verdict: 'UNVERIFIED',
      detail: 'parsed, but the runtime was not consulted; start Orca (`orca open`) to exercise it'
    }
  }
  if (/invalid_argument|Missing required|must be one of|expected/i.test(text)) {
    return { verdict: 'SHAPE-ERROR', detail: text.replace(/\s+/g, ' ').slice(0, 200) }
  }
  // The runtime was reached and answered with a state complaint — no task bound, no coordinator,
  // no such worktree. None of that is about the flag surface, and it is the only evidence that the
  // binary understood the command at all. The error code is reported so a real defect (a selector
  // form the runtime cannot resolve, say) is still visible instead of being filed as "accepted".
  if (/"ok"\s*:\s*false/.test(text)) {
    const code = text.match(/"code"\s*:\s*"([^"]+)"/)?.[1] ?? 'runtime_error'
    return { verdict: 'REACHABLE', detail: `runtime consulted, refused on state: ${code}` }
  }
  if (/"ok"\s*:\s*true/.test(text)) {
    return { verdict: 'REACHABLE', detail: 'runtime consulted and accepted the command' }
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

const flagIndex = commandFlagIndex()

// Check 1 — schema. No runtime, no side effects, and the only check that can run in CI.
const schemaResults = []
for (const step of compiled.steps) {
  const path = step.argv.slice(1, 3).join(' ')
  const declared = flagIndex.get(path)
  if (!declared) {
    schemaResults.push({
      command: step.kind,
      argv: step.argv,
      verdict: 'NO-SUCH-COMMAND',
      detail: path
    })
    process.stdout.write(`NO-SUCH-COMMAND ${step.kind.padEnd(13)} ${path}\n`)
    continue
  }
  const undeclared = undeclaredFlagsFor(flagIndex, path, step.argv)
  const verdict = undeclared.length === 0 ? 'IN-SCHEMA' : 'UNDECLARED-FLAG'
  schemaResults.push({
    command: step.kind,
    argv: step.argv,
    verdict,
    detail: undeclared.length === 0 ? path : `${path} does not declare ${undeclared.join(', ')}`
  })
  process.stdout.write(`${verdict.padEnd(11)} ${step.kind.padEnd(13)} ${path}\n`)
  if (undeclared.length > 0) {
    process.stdout.write(`            -> ${schemaResults.at(-1).detail}\n`)
  }
}
// A schema check that cannot fail is a decoration. This control is the same shape as a real
// emission with one invented flag, and it must come back UNDECLARED-FLAG — with no runtime, no
// Task, and no side effect of any kind.
const controlPath = 'orchestration worker-start'
const controlArgv = [
  'orca',
  'orchestration',
  'worker-start',
  '--task',
  't',
  '--totally-made-up-flag',
  'x'
]
const controlUndeclared = undeclaredFlagsFor(flagIndex, controlPath, controlArgv)
const controlVerdict = controlUndeclared?.includes('totally-made-up-flag')
  ? 'UNDECLARED-FLAG'
  : 'IN-SCHEMA'
if (controlVerdict !== 'UNDECLARED-FLAG') {
  process.stderr.write(
    `schema check cannot see an invented flag on ${controlPath}, so a green result means nothing\n`
  )
  process.exit(1)
}
process.stdout.write(
  `\nschema control: an invented flag on ${controlPath} was reported UNDECLARED-FLAG\n`
)

const schemaBad = schemaResults.filter(
  (result) => result.verdict === 'UNDECLARED-FLAG' || result.verdict === 'NO-SUCH-COMMAND'
)
process.stdout.write(
  `\nschema: ${schemaResults.length - schemaBad.length}/${schemaResults.length} emitted command lines ` +
    'use only flags the binary declares\n'
)

// Check 2 — live probe. Opt-in, and never a pass on a runtime that was not consulted.
let probeResults = []
if (LIVE) {
  const controlFailures = runNegativeControls()
  if (controlFailures.length > 0) {
    process.stderr.write(
      `checker cannot detect a bad command line, so its probe verdicts mean nothing:\n${controlFailures
        .map((line) => `  - ${line}`)
        .join('\n')}\n`
    )
    process.exit(1)
  }
  process.stdout.write('\nnegative controls: both bad command lines were detected\n\n')
  for (const step of compiled.steps) {
    // Runtime ids and shell variables do not exist outside the generated script; substitute values
    // that are well-formed so any complaint is about the flag shape, not the placeholder. Terminal
    // handles and task ids are not the same string, and a runtime that accepts one shape while
    // rejecting the other is exactly the bug this script exists to catch.
    const argv = step.argv.map((part) =>
      part.replace(/^\$\{?[A-Z_]+\}?$/, (name) =>
        /TASK|DEP|GATE/.test(name) ? 'task_placeholder' : 'term_placeholder'
      )
    )
    const { verdict, detail } = classify(argv)
    probeResults.push({ command: step.kind, argv, verdict, detail })
    process.stdout.write(
      `${verdict.padEnd(11)} ${step.kind.padEnd(13)} ${argv.slice(1, 4).join(' ')}\n`
    )
    if (verdict === 'REJECTED' || verdict === 'SHAPE-ERROR' || verdict === 'UNVERIFIED') {
      process.stdout.write(`            -> ${detail}\n`)
    }
  }
  const bad = probeResults.filter(
    (result) => result.verdict === 'REJECTED' || result.verdict === 'SHAPE-ERROR'
  )
  const unknown = probeResults.filter((result) => result.verdict === 'UNKNOWN')
  const unverified = probeResults.filter((result) => result.verdict === 'UNVERIFIED')
  const reachable = probeResults.filter((result) => result.verdict === 'REACHABLE')
  process.stdout.write(
    `\nprobe: ${reachable.length} reached the runtime, ${bad.length} rejected, ` +
      `${unknown.length} unknown, ${unverified.length} unverified\n`
  )
  if (unverified.length > 0) {
    process.stdout.write(
      'unverified means the runtime was never consulted, so those shapes are unproven. Start Orca\n' +
        '(`orca open`) and re-run; pass --allow-unverified only to record the gap.\n'
    )
  }
  probeResults = { bad: bad.length, unknown: unknown.length, unverified: unverified.length }
} else {
  process.stdout.write(
    '\nprobe: skipped. Pass --live to hand the command lines to a running Orca; note that a live\n' +
      'runtime executes what it parses, so the probe creates real Tasks.\n'
  )
}

const dir = mkdtempSync(join(tmpdir(), 'orca-argv-'))
writeFileSync(
  join(dir, 'result.json'),
  JSON.stringify({ schema: schemaResults, probe: probeResults }, null, 2)
)
process.stdout.write(`detail: ${join(dir, 'result.json')}\n`)
const probeFailed =
  Array.isArray(probeResults) &&
  (probeResults.some(
    (result) =>
      result.verdict === 'REJECTED' ||
      result.verdict === 'SHAPE-ERROR' ||
      result.verdict === 'UNKNOWN'
  ) ||
    (probeResults.some((result) => result.verdict === 'UNVERIFIED') && !ALLOW_UNVERIFIED))
process.exitCode = schemaBad.length === 0 && !probeFailed ? 0 : 1
