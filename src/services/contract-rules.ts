/**
 * Deterministic contract rules shared by every gate (lock / start / complete) and the
 * converge report. Pure functions over plain rows — no DB access, no LLM (decision #5).
 */
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export interface Finding { id: string; severity: Severity; kind: string; ref: string; message: string }

export const VERIFY_METHODS = ['test', 'command', 'api', 'inspection', 'manual'] as const;
export const VERDICTS = ['verified', 'partial', 'failed'] as const;
export const COVERAGE_CATEGORIES = [
  'behaviour', 'data', 'failure_modes', 'edge_cases', 'non_functional', 'integration', 'completion',
] as const;
export const MAX_SESSION_QUESTIONS = 5;

export interface ReqRow {
  id: number; requirementType: string; description: string; priority: string; status: string;
  verifyMethod: string | null; coverage: string | null;
}
export interface UnitRow { id: string; title: string; status: string; completedAt: string | null }
export interface RunRow { id: number; requirementId: number | null; verdict: string | null; createdAt: string }

const SEVERITY_ORDER: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const f = (severity: Severity, kind: string, ref: string, message: string): Finding =>
  ({ id: `${kind}:${ref}`, severity, kind, ref, message });
const isRequiredCriterion = (r: ReqRow) => r.requirementType === 'success_criterion' && r.priority === 'required';

// Enumeration markers at a word boundary: (1) 1. 1) a) (a). "1.5s" and "v2.1" don't match (digit must be followed by ")" or ". ").
const ENUM_MARKER = /(?:^|\s)\(?(?:\d{1,2}|[a-h])(?:\)|\.\s)/g;
const LIST_LINE = /\n\s*[-*]\s+/;

export function isAtomic(text: string): boolean {
  if ((text.match(ENUM_MARKER) ?? []).length >= 2) return false;
  if ((text.match(/;/g) ?? []).length >= 2) return false;
  if (LIST_LINE.test(text)) return false;
  return true;
}

export function lockFindings(reqs: ReqRow[]): Finding[] {
  const out: Finding[] = [];
  for (const r of reqs.filter(isRequiredCriterion)) {
    if (!isAtomic(r.description)) {
      out.push(f('CRITICAL', 'non_atomic', `req:${r.id}`,
        `Criterion #${r.id} states several claims; split it into one requirement per claim.`));
    }
    if (!r.verifyMethod) {
      out.push(f('CRITICAL', 'no_verify_method', `req:${r.id}`,
        `Criterion #${r.id} has no verify method (${VERIFY_METHODS.join(', ')}).`));
    }
  }
  return out;
}

export function uncoveredCategories(reqs: ReqRow[]): string[] {
  const covered = new Set(reqs.map(r => r.coverage).filter(Boolean));
  return COVERAGE_CATEGORIES.filter(c => !covered.has(c));
}

export function principleFindings(
  principles: { id: number; statement: string }[], acks: { knowledgeId: number; mode: string }[],
  phase: 'lock' | 'converge',
): Finding[] {
  const byId = new Map(acks.map(a => [a.knowledgeId, a.mode]));
  const out: Finding[] = [];
  for (const p of principles) {
    const mode = byId.get(p.id);
    if (!mode && phase === 'lock') {
      out.push(f('CRITICAL', 'unacknowledged_principle', `knowledge:${p.id}`,
        `Principle #${p.id} not acknowledged (honoured | exception): ${p.statement}`));
    }
    if (mode === 'exception' && phase === 'converge') {
      out.push(f('LOW', 'principle_exception', `knowledge:${p.id}`, `Justified exception to: ${p.statement}`));
    }
  }
  return out;
}

export function coverageFindings(
  reqs: ReqRow[], units: UnitRow[], links: { workUnitId: string; requirementId: number }[],
): Finding[] {
  const out: Finding[] = [];
  const served = new Set(links.map(l => l.requirementId));
  const linkedUnits = new Set(links.map(l => l.workUnitId));
  for (const r of reqs.filter(isRequiredCriterion)) {
    if (r.status !== 'NOT_APPLICABLE' && !served.has(r.id)) {
      out.push(f('CRITICAL', 'uncovered', `req:${r.id}`, `No work unit serves criterion #${r.id}: ${r.description}`));
    }
  }
  for (const u of units) {
    if (!linkedUnits.has(u.id)) {
      out.push(f('MEDIUM', 'unrequested', `wu:${u.id}`, `Work unit ${u.id} serves no criterion: ${u.title}`));
    }
  }
  return out;
}

export function evidenceFindings(
  reqs: ReqRow[], runs: RunRow[], units: UnitRow[], openFailures: { id: number; errorMessage: string | null }[],
): Finding[] {
  const out: Finding[] = [];
  const lastWorkDone = units.map(u => u.completedAt).filter((x): x is string => !!x).sort().at(-1);
  const latest = (reqId: number) => runs
    .filter(r => r.requirementId === reqId && r.verdict)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id).at(-1);
  for (const r of reqs) {
    if (r.status === 'NOT_APPLICABLE') continue;
    if (r.requirementType === 'constraint' || r.requirementType === 'exclusion') {
      out.push(f('LOW', 'review', `req:${r.id}`, `Confirm still honoured: ${r.description}`));
      continue;
    }
    if (r.requirementType !== 'success_criterion') continue;
    const run = latest(r.id);
    if (r.priority !== 'required') {
      if (run?.verdict !== 'verified') out.push(f('MEDIUM', 'missing_optional', `req:${r.id}`, `Optional criterion #${r.id} unverified`));
      continue;
    }
    if (!run) out.push(f('CRITICAL', 'missing', `req:${r.id}`, `No evidence for criterion #${r.id}: ${r.description}`));
    else if (run.verdict === 'failed') out.push(f('CRITICAL', 'contradicts', `req:${r.id}`, `Latest evidence for #${r.id} failed`));
    else if (run.verdict === 'partial') out.push(f('HIGH', 'partial', `req:${r.id}`, `Evidence for #${r.id} is partial`));
    else if (lastWorkDone && run.createdAt < lastWorkDone) {
      out.push(f('HIGH', 'stale_evidence', `req:${r.id}`, `#${r.id} verified before the last work unit completed; re-verify`));
    }
  }
  for (const u of units) {
    if (!['COMPLETED', 'SKIPPED'].includes(u.status)) {
      out.push(f('HIGH', 'unfinished_work', `wu:${u.id}`, `Work unit ${u.id} is ${u.status}: ${u.title}`));
    }
  }
  for (const x of openFailures) {
    out.push(f('CRITICAL', 'open_failure', `failure:${x.id}`, `Unresolved failure #${x.id}: ${x.errorMessage ?? ''} — resolve with ` +
      `\`failure solution ${x.id} "<fix>" --verdict verified --reproduction "…"\` or \`failure resolve ${x.id} <reason>\``));
  }
  return out;
}

export function sortFindings(list: Finding[]): Finding[] {
  return [...list].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id));
}

export function isConverged(list: Finding[]): boolean {
  return !list.some(x => x.severity === 'CRITICAL' || x.severity === 'HIGH');
}
