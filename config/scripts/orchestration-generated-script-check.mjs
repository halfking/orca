#!/usr/bin/env node
// A stub `orca` binary that answers the three commands the wave compiler emits.
//
// Why this exists: the generated script is the artifact a coordinator actually runs, and a script
// that is syntactically valid can still capture the wrong ids, build malformed --deps JSON, or
// write the wrong rows into the ledger. None of that shows up in a syntax check or a unit test,
// because both only ever look at the text. Running the script against a stub that hands back
// realistic receipts exercises the parts the compiler cannot unit test: shell expansion, id
// extraction, and what actually lands in the ledger.
//
// Receipt shapes here cover the three places a task id can plausibly live, so a failure says which
// one the extraction missed rather than just "no id".

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildView, parseLedger } from './orchestration-schedule-ledger.mjs'
import { compilePlan } from './orchestration-wave-plan.mjs'

const STUB = `#!/usr/bin/env node
// Stand-in for the orca CLI: records what it was asked for, answers with a receipt.
import { appendFileSync, readFileSync, existsSync } from 'node:fs'

const log = process.env.ORCA_STUB_LOG
const args = process.argv.slice(2)
const command = args[1]
appendFileSync(log, JSON.stringify(args) + '\\n')

const next = (prefix) => prefix + '_' + (existsSync(log) ? readFileSync(log, 'utf8').split('\\n').length : 0)
const flag = (name) => {
  const at = args.indexOf(name)
  return at === -1 ? null : args[at + 1]
}

if (command === 'run-create') {
  process.stdout.write(JSON.stringify({ result: { id: 'run_stub', runId: 'run_stub', coordinator_handle: 'term_stub', objective: flag('--objective') } }))
} else if (command === 'task-create') {
  const title = flag('--task-title')
  const deps = flag('--deps')
  // Alternate the id location so the extraction fallback is exercised, not just the happy path.
  const id = next('task')
  const payload = { title, deps }
  if ((readFileSync(log, 'utf8').split('\\n').length % 2) === 0) {
    process.stdout.write(JSON.stringify({ result: { task: { id, ...payload } } }))
  } else {
    process.stdout.write(JSON.stringify({ result: { id, taskId: id, ...payload } }))
  }
} else if (command === 'worker-start') {
  process.stdout.write(JSON.stringify({
    result: { dispatchId: next('disp'), state: 'ready', stage: 'accepted', setup: { state: 'complete' },
      launch: { requested: {}, effective: {} }, effects: [], residualResources: [] }
  }))
} else if (command === 'gate-create') {
  process.stdout.write(JSON.stringify({ result: { gate: { id: 'gate_stub', resolved: false } } }))
} else {
  process.stdout.write(JSON.stringify({ error: { code: 'invalid_argument', message: 'unsupported ' + command } }))
}
`

const dir = mkdtempSync(join(tmpdir(), 'orca-e2e-'))
const logPath = join(dir, 'orca-calls.jsonl')
writeFileSync(logPath, '')

const stubPath = join(dir, 'orca')
writeFileSync(stubPath, STUB)
chmodSync(stubPath, 0o755)

const plan = {
  objective: 'two independent changes, audited, merged behind one gate',
  base: 'main',
  confirmModels: false,
  tasks: [
    {
      id: 'impl_a',
      role: 'implementer',
      title: 'implement alpha',
      spec: 'do alpha',
      writeSet: ['src/a.ts'],
      deps: []
    },
    {
      id: 'impl_b',
      role: 'implementer',
      title: 'implement beta',
      spec: 'do beta',
      writeSet: ['src/b.ts'],
      deps: []
    },
    { id: 'audit_a', role: 'auditor', title: 'audit alpha', spec: 'audit alpha', deps: ['impl_a'] },
    { id: 'audit_b', role: 'auditor', title: 'audit beta', spec: 'audit beta', deps: ['impl_b'] },
    { id: 'merge', role: 'merger', title: 'merge', spec: 'merge all', deps: ['audit_a', 'audit_b'] }
  ]
}

const compiled = compilePlan(plan)
if (compiled.errors.length > 0) {
  process.stderr.write(`plan does not compile: ${compiled.errors.join('; ')}\n`)
  process.exit(1)
}

// Emit through the CLI, not the internal renderer, so the file under test is the one an operator
// would actually get.
const planPath = join(dir, 'plan.json')
writeFileSync(planPath, JSON.stringify(plan, null, 2))
const script = execFileSync(
  'node',
  [
    join(import.meta.dirname, 'orchestration-wave-plan.mjs'),
    'emit',
    '--plan',
    planPath,
    '--allow-warnings'
  ],
  { encoding: 'utf8' }
)
const scriptPath = join(dir, 'run.sh')
writeFileSync(scriptPath, script)

let runOutput = ''
let runFailed = false
try {
  runOutput = execFileSync('bash', [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ORCA_STUB_LOG: logPath },
    cwd: dir
  })
} catch (error) {
  runFailed = true
  runOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`
}

const calls = readFileSync(logPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line))
const ledgerPath = join(dir, '.orca', 'orchestration-ledger', 'run_stub.jsonl')
const ledgerExists = readFileSync(ledgerPath, 'utf8').length > 0

const failures = []
const check = (label, condition, detail = '') => {
  if (!condition) {
    failures.push(`${label}${detail ? `: ${detail}` : ''}`)
  }
  process.stdout.write(
    `${condition ? 'OK  ' : 'FAIL'} ${label}${condition || !detail ? '' : ` — ${detail}`}\n`
  )
}

check('generated script runs to completion', !runFailed, runOutput.slice(0, 300))
check('every task was created', calls.filter((call) => call[1] === 'task-create').length === 5)
check(
  'every dispatched role was started',
  calls.filter((call) => call[1] === 'worker-start').length === 4
)
check(
  'the merge wave became a gate, not an agent',
  calls.filter((call) => call[1] === 'gate-create').length === 1
)
// Verified live on orca 1.4.197: a worker-start without --from is fenced, and the first failure a
// real run sees is `selector_not_found` on the worktree selector, which blames the wrong flag. A
// stub that answers every command the same way would pass this file with the bug still in it, so
// the stub records the argv and this asserts the coordinator handle actually reached the binary.
const startCalls = calls.filter((call) => call[1] === 'worker-start')
check(
  'every dispatch names the coordinator terminal from the run receipt',
  startCalls.length > 0 &&
    startCalls.every((call) => {
      const at = call.indexOf('--from')
      return at !== -1 && call[at + 1] === 'term_stub'
    }),
  startCalls.map((call) => call[call.indexOf('--from') + 1]).join(',')
)
check(
  'no dispatch passes a literal $RUN_COORDINATOR',
  startCalls.every((call) => !call.includes('$RUN_COORDINATOR'))
)

// The point of the exercise: --deps must carry the ids task-create actually returned, not the
// symbolic plan names, and must still be valid JSON after shell expansion.
const depArgs = calls
  .filter((call) => call[1] === 'task-create')
  .map((call) => call[call.indexOf('--deps') + 1])
  .filter((value) => value !== '[]')
for (const value of depArgs) {
  let parsed = null
  try {
    parsed = JSON.parse(value)
  } catch {
    failures.push(`--deps is not valid JSON after expansion: ${value}`)
  }
  check(
    `--deps parses and holds real ids: ${value}`,
    parsed?.every((id) => id.startsWith('task_')),
    value
  )
}
check('ledger received an entry per dispatched task', ledgerExists)
if (ledgerExists) {
  const view = buildView(parseLedger(readFileSync(ledgerPath, 'utf8')))
  const tasks = new Set(view.folded.tasks.map((task) => task.id))
  check('ledger holds all five tasks', tasks.size === 5, [...tasks].join(','))
  check('run id recorded', view.folded.run === 'run_stub', String(view.folded.run))
  const dispatched = view.folded.tasks.filter((task) => task.dispatch)
  check('four tasks carry a dispatch id', dispatched.length === 4, String(dispatched.length))
  check(
    'dispatch ids came from the receipt, not the placeholder',
    dispatched.every((task) => task.dispatch?.startsWith('disp_')),
    dispatched.map((task) => task.dispatch).join(',')
  )
  const waves = Object.fromEntries(view.folded.tasks.map((task) => [task.id, task.wave]))
  check(
    'waves resolved to implement / audit / merge',
    JSON.stringify(waves) ===
      JSON.stringify({ impl_a: 0, impl_b: 0, audit_a: 1, audit_b: 1, merge: 2 }),
    JSON.stringify(waves)
  )
  check(
    'dependencies were captured, not left as plan names',
    view.folded.tasks.find((task) => task.id === 'audit_a')?.deps.size === 1
  )
}

process.stdout.write(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}\n`)
for (const failure of failures) {
  process.stdout.write(`  - ${failure}\n`)
}
process.exitCode = failures.length === 0 ? 0 : 1
