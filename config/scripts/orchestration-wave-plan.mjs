#!/usr/bin/env node
// Five-wave plan compiler for parallel task orchestration.
//
// Why: the five-wave shape (implement in parallel, test, audit, then merge behind a gate) is easy to
// describe and easy to get subtly wrong — a dependency on a task that does not exist, a cycle, two
// parallel workers claiming the same port, an auditor holding a write set, or a model passed to an
// agent that rejects it. All of those fail late, inside a live dispatch. This compiles a declarative
// plan into the exact `orca orchestration` argv sequence, refusing to emit anything the runtime
// would only reject after a terminal was already created.
//
// Usage:
//   orchestration-wave-plan.mjs init --plan <path> [--objective <text>]
//   orchestration-wave-plan.mjs emit --plan <path> [--shell|--json] [--allow-warnings]

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { resolveLaunch, roleSpec } from './orchestration-role-matrix.mjs'
import { auditIndependenceProblem, auditedTaskIds } from './orchestration-verdict-contract.mjs'

const SELF_DIR = import.meta.dirname

const PLAN_TEMPLATE = {
  objective: 'Replace this with the one-sentence outcome the whole run must reach.',
  base: 'main',
  confirmModels: false,
  models: {
    'strongest-code': null,
    cheap: null,
    'strongest-reasoning': null
  },
  tasks: [
    {
      id: 'impl_alpha',
      role: 'implementer',
      title: 'implement alpha',
      spec: 'Target: <files>.\nChange: <concrete result>.\nConstraints: <invariants and do-not-touch>.\nWrite set: <files this task may edit>.\nAcceptance: <command> -> <expected output>.',
      writeSet: ['src/alpha.ts'],
      resources: { port: '4101' },
      deps: []
    },
    {
      id: 'test_alpha',
      role: 'test-author',
      title: 'test alpha',
      spec: 'Target: <test files for alpha>.\nChange: failing test first, then make it pass.\nWrite set: <test files only — never implementation>.\nAcceptance: <test command> -> red before green.',
      writeSet: ['src/alpha.test.ts'],
      deps: ['impl_alpha']
    },
    {
      id: 'audit_alpha',
      role: 'auditor',
      title: 'audit alpha',
      spec: 'Read-only review of <branch> against <task>.\nVerdict: pass | pass_with_findings | fail.\nEvery finding: file:line, severity, reproducible evidence.\nDo not modify any file.',
      base: 'feature/impl_alpha',
      deps: ['test_alpha']
    },
    {
      id: 'merge',
      role: 'merger',
      title: 'merge wave',
      spec: 'Merge audit-passing branches in the order the ledger suggests, rebasing onto the current base first.',
      deps: ['audit_alpha']
    }
  ]
}

/** Every task id becomes a shell variable so dependencies can reference a real Task id at run time. */
export function shellVarFor(taskId) {
  return `TASK_${taskId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`
}

/**
 * Depth in the dependency DAG. Derived, never read from the plan: a hand-written wave number is a
 * claim about the DAG that nothing checks, and this tool exists to stop unchecked claims.
 */
export function assignWaves(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const depth = new Map()
  let hasCycle = false
  const walk = (id, seen) => {
    if (depth.has(id)) {
      return depth.get(id)
    }
    if (seen.has(id)) {
      hasCycle = true
      return -1
    }
    seen.add(id)
    const task = byId.get(id)
    let value = 0
    for (const dep of task?.deps ?? []) {
      const parent = walk(dep, seen)
      if (parent === -1) {
        hasCycle = true
        return -1
      }
      value = Math.max(value, parent + 1)
    }
    seen.delete(id)
    depth.set(id, value)
    return value
  }
  for (const task of tasks) {
    walk(task.id, new Set())
  }
  // One cycle makes the whole DAG unorderable, so every task reports it rather than leaving some
  // tasks with a depth that still looks computable.
  if (hasCycle) {
    for (const task of tasks) {
      depth.set(task.id, -1)
    }
  }
  return depth
}

/**
 * Reject a plan the runtime would only refuse after creating terminals. Errors block emission;
 * warnings describe a run that will work but probably not the way the author intended.
 */
export function validatePlan(plan) {
  const errors = []
  const warnings = []
  const tasks = plan.tasks ?? []
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const waves = assignWaves(tasks)

  if (tasks.length === 0) {
    errors.push('plan has no tasks')
  }
  if (byId.size !== tasks.length) {
    errors.push('plan has duplicate task ids')
  }

  let unknownDep = false
  for (const task of tasks) {
    if (!roleSpec(task.role)) {
      errors.push(`${task.id}: unknown role "${task.role}"`)
      continue
    }
    for (const dep of task.deps ?? []) {
      if (!byId.has(dep)) {
        unknownDep = true
        errors.push(`${task.id}: depends on unknown task "${dep}"`)
      }
      if (dep === task.id) {
        errors.push(`${task.id}: depends on itself`)
      }
    }
    if (!task.spec) {
      errors.push(`${task.id}: has no spec`)
    }
    const spec = roleSpec(task.role)
    if (spec.writeAccess === 'read-only' && (task.writeSet ?? []).length > 0) {
      errors.push(`${task.id}: ${task.role} is read-only but declares a write set`)
    }
    if (task.writeSet == null && spec.lands) {
      warnings.push(`${task.id}: no write set declared, so merge conflicts cannot be predicted`)
    }
    if (task.role === 'auditor' && (task.deps ?? []).length === 0) {
      warnings.push(`${task.id}: audit has nothing to wait for`)
    }
  }

  for (const [id, wave] of waves) {
    if (wave === -1) {
      errors.push(`${id}: dependency cycle`)
    }
  }

  // Two workers sharing an external resource in the same wave is the failure a worktree cannot
  // prevent, because the collision lives outside the repository entirely.
  const graphUnorderable = unknownDep || [...waves.values()].some((wave) => wave === -1)
  const owners = new Map()
  for (const task of tasks) {
    for (const [key, value] of Object.entries(task.resources ?? {})) {
      const claim = `${key}:${value}`
      const holder = owners.get(claim)
      const taskWave = waves.get(task.id)
      // Waves are only trustworthy when every dependency resolved, so an unorderable graph makes
      // every claim potentially overlapping rather than accidentally exempt.
      const mayOverlap = holder && (graphUnorderable || taskWave === waves.get(holder.task.id))
      if (mayOverlap) {
        errors.push(`${task.id} and ${holder.task.id} both claim ${claim} in wave ${taskWave}`)
      } else {
        owners.set(claim, { task })
      }
    }
  }

  // Predicted merge conflicts, surfaced before any work starts rather than at merge time.
  const landable = tasks.filter((task) => roleSpec(task.role)?.lands)
  for (let i = 0; i < landable.length; i++) {
    for (let j = i + 1; j < landable.length; j++) {
      const shared = (landable[i].writeSet ?? []).filter((file) =>
        (landable[j].writeSet ?? []).includes(file)
      )
      if (shared.length > 0) {
        warnings.push(
          `${landable[i].id} and ${landable[j].id} both write ${shared.join(', ')} — merge order matters`
        )
      }
    }
  }

  const mergers = tasks.filter((task) => task.role === 'merger')
  if (mergers.length === 0) {
    warnings.push('plan has no merger task, so nothing lands the work into the base branch')
  }
  for (const merger of mergers) {
    for (const task of tasks.filter((candidate) => candidate.role === 'auditor')) {
      if (!(merger.deps ?? []).includes(task.id)) {
        warnings.push(`${merger.id} does not depend on ${task.id}, so an unaudited change can land`)
      }
    }
  }

  const planOverrides = {
    agent: plan.defaultAgent ?? null,
    model: null
  }
  const launches = new Map()
  for (const task of tasks) {
    try {
      const overrides = {
        agent: planOverrides.agent,
        model: plan.confirmModels ? (plan.models?.[roleSpec(task.role)?.tier] ?? null) : null
      }
      const launch = resolveLaunch(task, overrides)
      launches.set(task.id, launch)
      if (launch.tier && !launch.model) {
        warnings.push(
          `${task.id}: role needs the ${launch.tier} tier but no model is named, so the agent default applies`
        )
      }
    } catch (error) {
      errors.push(`${task.id}: ${error.message}`)
    }
  }

  // An audit is only a second opinion if it is a second opinion. Separate worktrees and separate
  // Dispatches are not enough when the agent and the model behind them are the same ones that wrote
  // the change, so the plan is refused here rather than at the merge gate three waves later.
  for (const auditor of tasks.filter((task) => task.role === 'auditor')) {
    // The whole dependency closure, not the immediate dependencies: the code being judged was
    // written at the far end of it.
    for (const dep of auditedTaskIds(auditor, tasks)) {
      const problem = auditIndependenceProblem(
        { id: auditor.id, ...launches.get(auditor.id) },
        { id: dep, ...launches.get(dep) }
      )
      if (problem) {
        errors.push(problem)
      }
    }
  }

  return { errors, warnings, waves }
}

/** Ledger entry recorded with every dispatch, so the path view is populated from the first wave. */
function ledgerEntryFor(task, launch, { base, argv, event = 'worker-start' }) {
  return {
    dispatch: null,
    event,
    role: task.role,
    agent: launch.agent,
    model: launch.model,
    effort: launch.effort,
    // Plan-level dependencies, not runtime ids: the view resolves blocking by name, and a task
    // re-created under a new id must not silently detach from what waits on it.
    deps: task.deps ?? [],
    placement: { worktree: task.worktree ?? 'new-child', base, isolation: 'worktree' },
    state: 'ready',
    nextAction: argv
  }
}

/** Compile one validated plan into the command sequence, wave by wave. */
export function compilePlan(plan) {
  const { errors, warnings, waves } = validatePlan(plan)
  if (errors.length > 0) {
    return { errors, warnings, waves, steps: [] }
  }

  const base = plan.base ?? 'main'
  const steps = []
  const runCreate = ['orca', 'orchestration', 'run-create', '--objective', plan.objective, '--json']
  steps.push({ wave: -1, task: null, kind: 'run-create', argv: runCreate })

  const maxWave = Math.max(...waves.values())
  // Wave 0 holds the first real work, not just the Run: implementation tasks sit at depth 0 too.
  for (let wave = 0; wave <= maxWave; wave++) {
    for (const task of plan.tasks.filter((candidate) => waves.get(candidate.id) === wave)) {
      const taskVar = shellVarFor(task.id)
      const depVars = (task.deps ?? []).map(shellVarFor)
      const taskBase = task.base ?? base
      const launch = resolveLaunch(task, {
        agent: plan.defaultAgent ?? null,
        model: plan.confirmModels ? (plan.models?.[roleSpec(task.role)?.tier] ?? null) : null
      })

      steps.push({
        wave,
        task: task.id,
        kind: 'task-create',
        taskVar,
        depVars,
        specVar: `${taskVar}_SPEC`,
        assignTo: taskVar,
        argv: [
          'orca',
          'orchestration',
          'task-create',
          '--spec',
          task.spec,
          '--task-title',
          task.title ?? task.id,
          '--deps',
          '[]',
          '--json'
        ]
      })

      if (task.role === 'merger') {
        const gateArgv = [
          'orca',
          'orchestration',
          'gate-create',
          '--task',
          task.id,
          '--question',
          'Did every audit in this run return pass or pass_with_findings?',
          '--options',
          '["pass","fail"]',
          '--json'
        ]
        steps.push({
          wave,
          task: task.id,
          kind: 'gate-create',
          taskVar,
          gateVar: `GATE_${task.id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`,
          argv: gateArgv,
          ledger: ledgerEntryFor(task, launch, {
            base: taskBase,
            argv: gateArgv,
            event: 'gate-create'
          })
        })
        continue
      }

      const worktree = task.worktree ?? 'new-child'
      const argv = [
        'orca',
        'orchestration',
        'worker-start',
        '--task',
        task.id,
        '--worktree',
        worktree
      ]
      if (worktree !== 'current') {
        argv.push('--name', task.id, '--base-branch', taskBase, '--setup', task.setup ?? 'run')
      }
      // Why --from is not optional: worker-start is fenced to the terminal bound to the Run, and
      // `--worktree new-child` resolves the coordinator's worktree through that binding. Without it
      // the first dispatch of a real run dies with `selector_not_found` naming the worktree
      // selector, which points at the wrong thing entirely — the Run was simply never addressed.
      // Verified live against orca 1.4.197: identical argv with --from starts; without it, it fails.
      argv.push('--from', '$RUN_COORDINATOR')
      if (launch.agent) {
        argv.push('--agent', launch.agent)
      }
      if (launch.model) {
        argv.push('--model', launch.model)
      }
      if (launch.effort) {
        argv.push('--effort', launch.effort)
      }
      argv.push('--json')

      steps.push({
        wave,
        task: task.id,
        kind: 'worker-start',
        taskVar,
        dispatchVar: `DISPATCH_${task.id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`,
        argv,
        ledger: ledgerEntryFor(task, launch, { base: taskBase, argv })
      })
    }
  }

  return { errors, warnings, waves, steps }
}

function shellQuote(part) {
  const text = String(part)
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`
}

/**
 * `--deps` must carry real Task ids, which only exist once `task-create` has answered, so the
 * literal is rebuilt with shell expansion instead of being baked in at compile time. Each element
 * is quoted on both sides: `["$A","$B"]` and not `["$A,"$B"]`, which is what one join separator
 * short of correct produces, and which still looks plausible in a terminal.
 */
function depsFragment(depVars) {
  if (depVars.length === 0) {
    return shellQuote('[]')
  }
  const refs = depVars.map((name) => `\\"\${${name}}\\"`).join(',')
  return `"[${refs}]"`
}

function renderCommand(step, { program }) {
  const parts = []
  // argv[0] is the logical binary name; the emitted script calls it through $ORCA instead.
  for (let i = 1; i < step.argv.length; i++) {
    const flag = step.argv[i - 1]
    if (flag === '--deps') {
      parts.push(depsFragment(step.depVars ?? []))
      continue
    }
    if (flag === '--spec' && step.specVar) {
      parts.push(`"$${step.specVar}"`)
      continue
    }
    if (flag === '--task' && step.taskVar) {
      parts.push(`"$${step.taskVar}"`)
      continue
    }
    // A compiled value that is itself a shell reference ($RUN_COORDINATOR) must stay a reference:
    // quoting it as a literal would address a terminal called "$RUN_COORDINATOR".
    const value = step.argv[i]
    if (value.startsWith('$')) {
      parts.push(`"${value}"`)
      continue
    }
    parts.push(shellQuote(value))
  }
  return `${program} ${parts.join(' ')}`
}

const PREAMBLE = (ledgerPath) =>
  [
    '#!/usr/bin/env bash',
    '# Generated by orchestration-wave-plan.mjs — review the plan before running this.',
    'set -euo pipefail',
    '',
    `ORCA="\${ORCA:-orca}"`,
    `LEDGER="\${LEDGER:-${ledgerPath}}"`,
    '',
    '# Receipt shapes come from the binary that will actually run these commands. If an id prints',
    '# empty, capture one receipt and widen this lookup before trusting the script.',
    '__orca_task_id() {',
    "  node -e 'const j=JSON.parse(process.argv[1]);const t=j?.result?.task??j?.result??j;" +
      'process.stdout.write(String(t?.id??t?.taskId??""))\' "$1"',
    '}',
    '',
    '# Every worker-start is fenced to the terminal bound to this Run, and `--worktree new-child`',
    '# resolves the coordinator worktree through that same binding. The handle only exists in the',
    '# run-create receipt, so it is read once here and carried by every dispatch below.',
    '__orca_coordinator() {',
    "  node -e 'const j=JSON.parse(process.argv[1]);const r=j?.result??j;" +
      'process.stdout.write(String(r?.run?.coordinator_handle??r?.coordinator_handle??""))\' "$1"',
    '}',
    '',
    '# Merge the live dispatch id and the runtime task id from the receipt into the entry the',
    '# compiler prepared. The plan id stays the key: the DAG, the merge order and every report are',
    '# keyed on it, and a view keyed on runtime ids stops matching the plan that produced them.',
    '__orca_ledger() {',
    "  node -e 'const [run,task,runtimeTaskId,receipt,raw]=process.argv.slice(1);" +
      'const j=JSON.parse(receipt);const r=j?.result??j;' +
      'const e=JSON.parse(raw);' +
      'e.dispatch=r?.dispatchId??r?.dispatch_id??null;' +
      'if(r?.gate?.id){e.gate={id:r.gate.id,resolved:false}}' +
      'process.stdout.write(JSON.stringify({...e,run,task,runtimeTaskId}))\' "$1" "$2" "$3" "$4" "$5" \\',
    '    | node "$LEDGER" record --stdin',
    '}'
  ].join('\n')

export function renderShell(steps) {
  const ledgerPath = resolve(SELF_DIR, 'orchestration-schedule-ledger.mjs')
  const lines = [PREAMBLE(ledgerPath)]
  const runCreate = steps.find((step) => step.kind === 'run-create')

  lines.push('', '# setup — open the Run')
  lines.push(`RUN_RECEIPT="$(${renderCommand(runCreate, { program: '"$ORCA"' })})"`)
  lines.push('RUN_ID="$(__orca_task_id "$RUN_RECEIPT")"')
  lines.push('RUN_COORDINATOR="$(__orca_coordinator "$RUN_RECEIPT")"')
  lines.push(
    '# An empty handle means the Run never recorded a coordinator, and every dispatch below would',
    '# be fenced. Stop here rather than dispatch four waves that cannot start.',
    'if [ -z "$RUN_COORDINATOR" ]; then',
    '  echo "run-create receipt carries no coordinator_handle; worker-start would be fenced" >&2',
    '  exit 1',
    'fi'
  )

  for (const wave of [...new Set(steps.filter((s) => s.wave >= 0).map((s) => s.wave))].sort(
    (a, b) => a - b
  )) {
    lines.push('', `# wave ${wave}`)
    for (const step of steps.filter((candidate) => candidate.wave === wave)) {
      const command = renderCommand(step, { program: '"$ORCA"' })
      if (step.kind === 'task-create') {
        lines.push(`${step.specVar}="$(cat <<'ORCA_SPEC_${step.task}'`)
        lines.push(step.argv[step.argv.indexOf('--spec') + 1])
        lines.push(`ORCA_SPEC_${step.task}`)
        lines.push(')"')
        lines.push(`${step.assignTo}_RECEIPT="$(${command})"`)
        lines.push(`${step.assignTo}="$(__orca_task_id "$${step.assignTo}_RECEIPT")"`)
        continue
      }
      const receiptVar = step.dispatchVar ?? step.gateVar
      lines.push(`${receiptVar}="$(${command})"`)
      lines.push(
        `__orca_ledger "$RUN_ID" '${step.task}' "$${step.taskVar}" "$${receiptVar}" ${shellQuote(
          JSON.stringify(step.ledger)
        )}`
      )
      lines.push(`echo "wave ${wave}: ${step.task} ${step.kind}"`)
    }
  }

  lines.push('', '# Review the whole run at any time:')
  lines.push('#   node "$LEDGER" view --ledger ".orca/orchestration-ledger/$RUN_ID.jsonl"', '')
  return lines.join('\n')
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) {
      continue
    }
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      i++
    }
  }
  return args
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)

  if (command === 'init') {
    const path = resolve(args.plan ?? 'orchestration-plan.json')
    const plan = structuredClone(PLAN_TEMPLATE)
    if (args.objective) {
      plan.objective = args.objective
    }
    writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`)
    process.stdout.write(`wrote ${path}\n`)
    return
  }

  if (command !== 'emit') {
    process.stderr.write('usage: orchestration-wave-plan.mjs <init|emit> --plan <path>\n')
    process.exitCode = 1
    return
  }

  const path = resolve(args.plan)
  let plan
  try {
    plan = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    process.stderr.write(`cannot read plan ${path}: ${error.message}\n`)
    process.exitCode = 1
    return
  }

  const result = compilePlan(plan)
  for (const warning of result.warnings) {
    process.stderr.write(`warning: ${warning}\n`)
  }
  if (result.errors.length > 0) {
    for (const error of result.errors) {
      process.stderr.write(`error: ${error}\n`)
    }
    process.stderr.write(`refusing to emit: ${result.errors.length} blocking problem(s)\n`)
    process.exitCode = 1
    return
  }
  if (result.warnings.length > 0 && !args['allow-warnings']) {
    process.stderr.write(
      'refusing to emit with warnings; pass --allow-warnings once you accept them\n'
    )
    process.exitCode = 1
    return
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  process.stdout.write(`${renderShell(result.steps)}\n`)
}

if (process.argv[1] && process.argv[1].endsWith('orchestration-wave-plan.mjs')) {
  main()
}
