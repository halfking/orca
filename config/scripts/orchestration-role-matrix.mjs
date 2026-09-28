/**
 * Role-to-model routing rules for parallel task orchestration.
 *
 * Why this exists: Orca's `worker-start` accepts `--agent`, `--model` and `--effort`, but the
 * upstream contract is narrow — `--model` is honoured only for claude, codex, cursor, antigravity
 * and muse; opencode and zcode reject it and run the model in their own config. `--effort` requires
 * `--model`, and neither combines with `--terminal`. Encoding that here means a plan is rejected
 * before dispatch instead of failing at the moment a worker is supposed to start.
 *
 * Why models are null: upstream says to pass `--model` only when the user named one. A matrix that
 * silently picked a model would make cost unreviewable and every run unreproducible, so tiers carry
 * a role's *requirement* and the model id stays empty until a plan confirms it.
 */

/** Agents whose `worker-start` accepts `--model` / `--effort` (upstream coordinator-loop.md). */
export const MODEL_ROUTABLE_AGENTS = new Set(['claude', 'codex', 'cursor', 'antigravity', 'muse'])

/** Every agent id `--agent` accepts for a worker launch. */
export const WORKER_AGENTS = new Set([...MODEL_ROUTABLE_AGENTS, 'opencode', 'opencode2', 'zcode'])

/** Model requirement tiers. No model id is baked in; a plan names one on purpose. */
export const MODEL_TIERS = {
  'strongest-code': {
    label: 'strongest coding model',
    why: 'Implementation carries the design cost; a weak model here shows up as rework, not as a bug.'
  },
  cheap: {
    label: 'low-cost model',
    why: 'Test authoring is mechanical once the behaviour is specified; spend the strong tier on design and audit.'
  },
  'strongest-reasoning': {
    label: 'strongest reasoning model',
    why: 'The audit decides whether the change is allowed to land; it is the cheapest place to spend the best model.'
  }
}

/**
 * What each role is allowed to do. `writeAccess` is a contract the plan validator checks, not a
 * hint: an auditor that edits implementation files cannot produce an independent verdict.
 */
export const ROLE_MATRIX = {
  coordinator: {
    label: 'coordinator',
    dispatches: true,
    lands: false,
    writeAccess: 'none',
    agent: null,
    tier: null,
    effort: null
  },
  implementer: {
    label: 'implementer',
    dispatches: true,
    lands: true,
    writeAccess: 'own-worktree',
    agent: 'codex',
    tier: 'strongest-code',
    effort: 'high'
  },
  'test-author': {
    label: 'test-author',
    dispatches: true,
    lands: true,
    writeAccess: 'tests-only',
    agent: 'claude',
    tier: 'cheap',
    effort: 'medium'
  },
  auditor: {
    label: 'auditor',
    dispatches: true,
    lands: false,
    writeAccess: 'read-only',
    agent: 'claude',
    tier: 'strongest-reasoning',
    effort: 'high'
  },
  merger: {
    label: 'merger',
    dispatches: false,
    lands: true,
    writeAccess: 'base-worktree',
    agent: null,
    tier: null,
    effort: null
  }
}

export function knownRoles() {
  return Object.keys(ROLE_MATRIX)
}

export function roleSpec(role) {
  return ROLE_MATRIX[role] ?? null
}

/**
 * Resolve the launch flags one task will actually use, merging the role default with a plan-level
 * or task-level override. Returns the flags plus the tier they were drawn from, so the ledger can
 * record which rule chose the model instead of leaving it to memory.
 */
export function resolveLaunch(task, overrides = {}) {
  const spec = roleSpec(task.role)
  if (!spec) {
    throw new Error(`unknown role: ${task.role}`)
  }
  const agent = task.agent ?? overrides.agent ?? spec.agent
  const tier = task.tier ?? spec.tier
  const model = task.model ?? overrides.model ?? null
  const explicitEffort = task.effort ?? overrides.effort ?? null

  if (agent && !WORKER_AGENTS.has(agent)) {
    throw new Error(`unknown agent: ${agent}`)
  }
  if (model && agent && !MODEL_ROUTABLE_AGENTS.has(agent)) {
    throw new Error(`agent ${agent} rejects --model; it runs the model in its own config`)
  }
  // An effort the plan wrote down is a claim about how hard to think, so it fails loudly. An effort
  // that only came from the role default is dropped instead: the binary rejects --effort without
  // --model, and refusing a whole plan over a default would make an unconfirmed plan unusable.
  if (explicitEffort && !model) {
    throw new Error('--effort requires --model; drop the effort or name the model on purpose')
  }
  const effort = model ? (explicitEffort ?? spec.effort ?? null) : null
  return { agent, tier, model, effort, writeAccess: spec.writeAccess, dispatches: spec.dispatches }
}

/** The exact argv for a worker launch, in a stable order so a diff of two plans is readable. */
export function launchArgv(taskId, launch, { worktree, name, base, setup }) {
  const argv = ['orca', 'orchestration', 'worker-start', '--task', taskId]
  if (worktree) {
    argv.push('--worktree', worktree)
  }
  if (name) {
    argv.push('--name', name)
  }
  if (base) {
    argv.push('--base-branch', base)
  }
  if (setup) {
    argv.push('--setup', setup)
  }
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
  return argv
}
