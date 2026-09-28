/**
 * The audit verdict contract, independent of git.
 *
 * Why it is its own module: an audit is judged on evidence, not on which branch it landed on, and
 * the rules that decide whether a verdict is trustworthy have nothing to do with repositories. It
 * also keeps the merge gate from becoming the file nobody is willing to touch, at a repository whose
 * own lint forbids growing past 600 lines and forbids waiving that limit.
 *
 * The contract lives in one place so the gate that reads a verdict and the writer that records one
 * cannot drift apart. A verdict is only as good as the evidence behind it, and a contradiction
 * between the two is the failure this exists to catch.
 */

export const PASSING_VERDICTS = new Set(['pass', 'pass_with_findings'])
export const ALL_VERDICTS = new Set(['pass', 'pass_with_findings', 'fail'])

export function verdictContractProblems(verdict, findings, reportCount, regression) {
  const problems = []
  if (!verdict) {
    problems.push('no verdict recorded')
  } else if (!ALL_VERDICTS.has(verdict)) {
    problems.push(`unknown verdict "${verdict}"; expected pass | pass_with_findings | fail`)
  }
  if (verdict === 'pass' && findings.length > 0) {
    problems.push('verdict is pass but findings are present')
  }
  if (verdict === 'pass_with_findings' && findings.length === 0) {
    problems.push('verdict is pass_with_findings but no finding is recorded')
  }
  if (verdict === 'fail' && !findings.some((finding) => finding.severity === 'blocker')) {
    problems.push('verdict is fail but no finding is marked as a blocker')
  }
  for (const finding of findings) {
    if (!finding.file || finding.line == null) {
      problems.push(`a finding is missing its location: ${JSON.stringify(finding)}`)
    } else if (!finding.evidence) {
      problems.push(`${finding.file}:${finding.line} has no reproducible evidence`)
    }
  }
  if (verdict && reportCount === 0) {
    problems.push('no report path recorded, so the audit cannot be re-read')
  }
  // A verdict with no command and no output behind it is a claim about testing, not evidence of it.
  // The result may be a failure — that is exactly what a fail verdict is for — but it must exist.
  if (verdict && (!regression || !regression.command)) {
    problems.push('no regression recorded, so nothing proves the change was tested')
  }
  return problems
}

export function normalizeFindings(findings) {
  if (!Array.isArray(findings)) {
    return []
  }
  return findings.map((finding) =>
    typeof finding === 'string'
      ? { file: finding, line: null, severity: 'blocker', evidence: '' }
      : finding
  )
}

/**
 * Validate every audit verdict against the contract. The point of an audit is that someone can
 * check it later, so a verdict with no retrievable report is not a pass — it is an unrecorded
 * claim, and it blocks the merge exactly like a missing audit does.
 */
export function validateVerdicts(folded) {
  const rows = []
  for (const task of folded.tasks) {
    const audited = task.role === 'auditor' || task.verdict != null
    if (!audited) {
      continue
    }
    const findings = normalizeFindings(task.findings)
    rows.push({
      id: task.id,
      role: task.role,
      verdict: task.verdict,
      findings: findings.length,
      regression: task.regression ?? null,
      reports: task.reportPaths,
      problems: verdictContractProblems(
        task.verdict,
        findings,
        task.reportPaths.length,
        task.regression
      )
    })
  }
  return rows
}

/**
 * Audits that did not pass, plus landable work nobody audited. Anything here blocks a merge.
 *
 * An audit covers the tasks it depends on, so coverage is read off the DAG rather than off naming:
 * `audit_a` exists in the ledger whether or not anyone remembers that it audited `impl_a`.
 */
export function computeMergeReadiness(folded) {
  const rows = validateVerdicts(folded)
  const problemsByTask = new Map(rows.map((row) => [row.id, row]))
  const auditors = folded.tasks.filter((task) => task.role === 'auditor')
  const blockers = []

  for (const row of rows) {
    if (row.problems.length > 0) {
      blockers.push(`${row.id}: ${row.problems.join('; ')}`)
    } else if (!PASSING_VERDICTS.has(row.verdict)) {
      blockers.push(`${row.id}: verdict is ${row.verdict}`)
    }
  }

  for (const task of folded.tasks) {
    if (task.role === 'merger' || task.role === 'coordinator' || task.role === 'auditor') {
      continue
    }
    if (task.state !== 'completed') {
      blockers.push(`${task.id}: state is ${task.state}, not completed`)
    }
    const covering = auditors.filter((auditor) => auditor.deps.has(task.id))
    if (covering.length === 0) {
      blockers.push(`${task.id}: landed without an audit verdict`)
      continue
    }
    const passing = covering.filter((auditor) => {
      const row = problemsByTask.get(auditor.id)
      return row && row.problems.length === 0 && PASSING_VERDICTS.has(row.verdict)
    })
    if (passing.length === 0) {
      blockers.push(
        `${task.id}: no covering audit passed (${covering.map((a) => a.id).join(', ')})`
      )
    }
  }

  for (const task of folded.tasks) {
    for (const gate of task.gates.values()) {
      if (!gate.resolved) {
        blockers.push(`${task.id}: gate ${gate.id} is unresolved`)
      }
      if (gate.resolved && gate.choice && !PASSING_VERDICTS.has(gate.choice)) {
        blockers.push(`${task.id}: gate ${gate.id} was resolved "${gate.choice}"`)
      }
    }
  }

  return { rows, blockers, ready: blockers.length === 0 }
}

/**
 * Build the ledger entry for a worker's own completion.
 *
 * This closes the loop the merge gate depends on: the gate reads verdicts, findings, reports and
 * touched files out of the ledger, and without a writer for `worker_done` those fields are never
 * there, so every real run would report "landed without an audit verdict" forever. The contract is
 * checked here, where the data enters, so a contradictory verdict is refused at the moment it is
 * written rather than surfacing as a closed gate three steps later.
 */
export function buildDoneEntry(input) {
  const findings = input.finding.map((raw) => {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return {
      file: parsed.file ?? null,
      line: parsed.line ?? null,
      severity: parsed.severity ?? null,
      evidence: parsed.evidence ?? null
    }
  })
  const regression =
    input.regression == null
      ? null
      : { command: input.regression.command ?? null, result: input.regression.result ?? null }
  const entry = {
    run: input.run,
    event: 'worker-done',
    task: input.task,
    role: input.role ?? null,
    dispatch: input.dispatch ?? null,
    state: input.state ?? 'completed',
    outcome: input.outcome ?? null,
    verdict: input.verdict ?? null,
    findings,
    regression,
    reportPath: input.report ?? null,
    filesModified: input.file,
    deps: input.dep
  }
  if (entry.verdict || input.role === 'auditor') {
    const problems = verdictContractProblems(
      entry.verdict,
      findings,
      input.report ? 1 : 0,
      regression
    )
    if (problems.length > 0) {
      throw new Error(`verdict contract violated: ${problems.join('; ')}`)
    }
  }
  return entry
}
