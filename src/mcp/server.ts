import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z, type ZodRawShape } from 'zod';
import {
  openDb, migrateDb, appliedMigrations, pendingMigrations, SCHEMA_NOTICE, type BrainDb,
} from '../db/connection.js';
import * as goals from '../services/goals.js';
import * as work from '../services/work.js';
import * as projects from '../services/projects.js';
import * as knowledge from '../services/knowledge.js';
import * as decisions from '../services/decisions.js';
import * as context from '../services/context.js';
import { recommendModel } from '../services/model.js';
import type { SearchType } from '../services/search.js';
import { scanProjects } from '../services/scanner.js';
import * as fail from '../services/failures.js';
import { goalVerificationState, recordVerification } from '../services/verification.js';
import { resumeGoal } from '../services/resume.js';
import { createFastEmbedder } from '../services/embedder.js';
import { reindexEmbeddings } from '../services/embedding-store.js';
import { hybridSearch } from '../services/hybrid-search.js';
import { importClaudeMem } from '../services/import-claude-mem.js';
import { buildIntakeReport } from '../services/intake.js';
import * as questions from '../services/questions.js';
import { convergeGoal } from '../services/converge.js';
import * as principles from '../services/principles.js';

export function buildServer(db: BrainDb): McpServer {
  const server = new McpServer({ name: 'central-brain', version: '0.1.0' });

  const tool = (name: string, description: string, shape: ZodRawShape, fn: (args: any) => unknown) => {
    server.registerTool(name, { description, inputSchema: shape }, async (args: any) => {
      try {
        return { content: [{ type: 'text' as const, text: JSON.stringify((await fn(args)) ?? null, null, 2) }] };
      } catch (e) {
        const msg = (e as Error).message;
        const text = pendingMigrations(db) > 0 ? `${msg}\n${SCHEMA_NOTICE}` : msg;
        return { isError: true, content: [{ type: 'text' as const, text }] };
      }
    });
  };

  // Lazy: the ONNX model is only loaded when a search/reindex tool is first called.
  let emb: ReturnType<typeof createFastEmbedder> | undefined;
  const embedder = () => (emb ??= createFastEmbedder());

  // goals
  tool('brain_goal_create', 'Create a new goal (DRAFT)', {
    title: z.string(), objective: z.string(),
    riskLevel: z.string().optional(), autonomyLevel: z.string().optional(),
    complexity: z.enum(['trivial', 'low', 'medium', 'high', 'critical']).optional(),
  }, (a) => goals.createGoal(db, a));
  tool('brain_goal_get', 'Get a goal with its requirements', { id: z.string() },
    (a) => ({ ...goals.getGoal(db, a.id), requirements: goals.listRequirements(db, a.id) }));
  tool('brain_goal_list', 'List goals, optionally by status', { status: z.string().optional() },
    (a) => goals.listGoals(db, a));
  tool('brain_goal_current', 'Get the currently active goal', {}, () => goals.currentGoal(db) ?? null);
  tool('brain_goal_lock', 'Lock the goal contract; refuses §9 gaps, open material questions, non-atomic success criteria, criteria without a verify method, and unacknowledged principles unless force+reason', {
    id: z.string(), force: z.boolean().optional(), reason: z.string().optional(),
  }, (a) => goals.lockGoal(db, a.id, { force: a.force, reason: a.reason }));
  tool('brain_goal_set', 'Set contract fields (risk, autonomy) on an unlocked goal', {
    id: z.string(), risk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'IRREVERSIBLE']).optional(), autonomy: z.string().optional(),
  }, (a) => goals.setGoalFields(db, a.id, { riskLevel: a.risk, autonomyLevel: a.autonomy }));
  tool('brain_goal_start', 'Start executing a locked goal (v1: every required criterion needs a serving work unit)', { id: z.string() },
    (a) => goals.startGoal(db, a.id));
  tool('brain_goal_converge', 'Converge report: typed findings (missing/partial/contradicts/stale/unfinished/open failure) for a goal; read-only', {
    id: z.string(),
  }, (a) => convergeGoal(db, a.id));
  tool('brain_goal_cancel', 'Cancel an open goal (reason required)', { id: z.string(), reason: z.string() },
    (a) => goals.cancelGoal(db, a.id, a.reason));
  tool('brain_goal_link_project', 'Link a goal to a project (its principles then apply)', {
    goalId: z.string(), project: z.string(),
  }, (a) => principles.linkGoalProject(db, a.goalId, a.project));
  tool('brain_principle_ack', 'Acknowledge an applicable principle before lock: honoured (how) or exception (why; records a decision)', {
    goalId: z.string(), knowledgeId: z.number(), mode: z.enum(['honoured', 'exception']), note: z.string(),
  }, (a) => principles.ackPrinciple(db, a));
  tool('brain_goal_block', 'Mark a goal blocked with a reason', { id: z.string(), reason: z.string() },
    (a) => goals.blockGoal(db, a.id, a.reason));
  tool('brain_goal_complete', 'Complete a goal; v1 goals must converge (no CRITICAL/HIGH findings). force needs reason', {
    id: z.string(), force: z.boolean().optional(), reason: z.string().optional(),
  }, (a) => goals.completeGoal(db, a.id, { force: a.force, reason: a.reason }));
  tool('brain_requirement_add', 'Add a requirement to an unlocked goal. Success criteria must be ONE claim each and carry verifyMethod; tag contract lines with coverage', {
    goalId: z.string(), description: z.string(),
    type: z.enum(['objective', 'constraint', 'success_criterion', 'exclusion', 'assumption', 'scope', 'permission'])
      .default('success_criterion'),
    priority: z.enum(['required', 'optional']).optional(),
    verifyMethod: z.enum(['test', 'command', 'api', 'inspection', 'manual']).optional(),
    coverage: z.enum(['behaviour', 'data', 'failure_modes', 'edge_cases', 'non_functional', 'integration', 'completion']).optional(),
  }, (a) => goals.addRequirement(db, a.goalId, a));
  tool('brain_requirement_set_status', 'Set requirement status (PENDING|PASSED|FAILED|NOT_APPLICABLE)', {
    id: z.number(), status: z.enum(['PENDING', 'PASSED', 'FAILED', 'NOT_APPLICABLE']),
    reason: z.string().optional(),
  }, (a) => { goals.setRequirementStatus(db, a.id, a.status, a.reason); return { ok: true }; });

  // work
  tool('brain_work_create', 'Create a work unit; serves = requirement ids it delivers (every required criterion must be served before goal start)', {
    goalId: z.string(), title: z.string(), description: z.string().optional(),
    workType: z.string().optional(), priority: z.number().optional(),
    complexity: z.enum(['trivial', 'low', 'medium', 'high', 'critical']).optional(),
    dependsOn: z.array(z.string()).optional(), serves: z.array(z.number()).optional(),
  }, (a) => work.createWorkUnit(db, a));
  tool('brain_work_update', 'Update a work unit (status/title)', {
    id: z.string(), status: z.string().optional(), title: z.string().optional(),
  }, (a) => work.updateWorkUnit(db, a.id, a));
  tool('brain_work_list', 'List work units for a goal', { goalId: z.string() },
    (a) => work.listWorkUnits(db, a.goalId));

  // projects / repos
  tool('brain_project_add', 'Register a project', {
    name: z.string(), rootPath: z.string().optional(), description: z.string().optional(),
  }, (a) => projects.addProject(db, a));
  tool('brain_project_list', 'List projects', {}, () => projects.listProjects(db));
  tool('brain_repo_add', 'Register a repository', {
    name: z.string(), projectId: z.string().optional(), path: z.string().optional(),
    remoteUrl: z.string().optional(), defaultBranch: z.string().optional(),
    language: z.string().optional(), framework: z.string().optional(),
  }, (a) => projects.addRepo(db, a));

  // knowledge / learnings
  tool('brain_knowledge_add', 'Store an atomic fact (scoped, confidence-rated)', {
    statement: z.string(), scopeType: z.string().default('GLOBAL'),
    scopeId: z.string().optional(), category: z.string().optional(),
    confidence: z.number().optional(), sourceType: z.string().optional(),
    sourceReference: z.string().optional(),
  }, (a) => knowledge.addKnowledge(db, a));
  tool('brain_knowledge_search', 'Hybrid (FTS + semantic) search over active knowledge', {
    query: z.string(), limit: z.number().optional(),
  }, (a) => hybridSearch(db, embedder(), a.query, { types: ['knowledge' as SearchType], limit: a.limit }));
  tool('brain_knowledge_verify', 'Mark a fact as re-verified now', { id: z.number() },
    (a) => knowledge.verifyKnowledge(db, a.id));
  tool('brain_knowledge_invalidate', 'Mark a fact invalid', { id: z.number() },
    (a) => knowledge.invalidateKnowledge(db, a.id));
  tool('brain_learning_add', 'Store reusable experience-derived guidance', {
    learning: z.string(), scopeType: z.string().optional(),
    scopeId: z.string().optional(), trigger: z.string().optional(),
  }, (a) => knowledge.addLearning(db, a));
  tool('brain_learning_search', 'Hybrid (FTS + semantic) search over learnings', {
    query: z.string(), limit: z.number().optional(),
  }, (a) => hybridSearch(db, embedder(), a.query, { types: ['learning' as SearchType], limit: a.limit }));
  tool('brain_learning_useful', 'Record that a learning was useful', { id: z.number() },
    (a) => knowledge.markLearningUseful(db, a.id));

  // decisions / observations
  tool('brain_decision_add', 'Record a decision with reasoning', {
    decision: z.string(), goalId: z.string().optional(), reason: z.string().optional(),
    alternatives: z.string().optional(), riskLevel: z.string().optional(),
    reversible: z.boolean().optional(), scopeType: z.string().optional(),
    scopeId: z.string().optional(),
  }, (a) => decisions.addDecision(db, a));
  tool('brain_observation_add', 'Record an observed fact during execution', {
    observation: z.string(), goalId: z.string().optional(), workUnitId: z.string().optional(),
    scopeType: z.string().optional(), scopeId: z.string().optional(),
  }, (a) => decisions.addObservation(db, a));

  // context
  tool('brain_context_get', 'Budgeted context for a goal (or the current goal)', {
    goalId: z.string().optional(), budget: z.number().optional(),
  }, (a) => context.getContext(db, a));
  tool('brain_context_search', 'Hybrid (FTS + semantic) search across knowledge, learnings, decisions, failures, goals, observations', {
    query: z.string(), limit: z.number().optional(),
  }, (a) => hybridSearch(db, embedder(), a.query, { limit: a.limit }));

  // model routing
  tool('brain_model_recommend', 'Recommend a Claude model for a goal or explicit complexity (§12.1)', {
    goalId: z.string().optional(),
    complexity: z.enum(['trivial', 'low', 'medium', 'high', 'critical']).optional(),
  }, (a) => recommendModel(db, a));

  tool('brain_knowledge_supersede', 'Supersede a fact with a corrected/updated statement', {
    id: z.number(), statement: z.string(), confidence: z.number().optional(),
  }, (a) => knowledge.supersedeKnowledge(db, a.id, a));
  tool('brain_approval_add', 'Record a pending approval for a risky/irreversible action', {
    action: z.string(), riskLevel: z.string().default('IRREVERSIBLE'),
    goalId: z.string().optional(), decisionId: z.number().optional(),
  }, (a) => decisions.addApproval(db, a));
  tool('brain_approval_resolve', 'Resolve a pending approval', {
    id: z.number(), status: z.enum(['approved', 'denied']),
  }, (a) => decisions.resolveApproval(db, a.id, a.status));
  tool('brain_work_ready', 'List work units whose dependencies are satisfied and ready to run', {
    goalId: z.string(),
  }, (a) => work.readyWorkUnits(db, a.goalId));

  // phase 2: scanner, failures, verification, resume
  tool('brain_project_scan', 'Discover and register projects under a directory (§54)', {
    dir: z.string(),
  }, (a) => scanProjects(db, a.dir));
  tool('brain_failure_record', 'Record a failure (§31)', {
    errorMessage: z.string(), goalId: z.string().optional(), workUnitId: z.string().optional(),
    failureType: z.string().optional(), context: z.string().optional(),
  }, (a) => fail.addFailure(db, a));
  tool('brain_failure_search', 'Have I seen this error before? Hybrid (FTS + semantic) search over failures (§66)', {
    query: z.string(), limit: z.number().optional(),
  }, (a) => hybridSearch(db, embedder(), a.query, { types: ['failure' as SearchType], limit: a.limit }));
  tool('brain_failure_resolve', 'Mark a failure resolved directly; requires a reason (stored + observation). Prefer brain_failure_solution_add with verdict verified + reproduction.', { id: z.number(), reason: z.string() },
    (a) => fail.resolveFailure(db, a.id, a.reason));
  tool('brain_failure_solution_add', 'Attach a solution to a failure. Resolves it only with verdict verified plus a non-empty reproduction (how the original symptom was re-checked); passing tests alone are partial. Legacy successful:true without reproduction is stored partial and does not resolve.', {
    failureId: z.number(), solution: z.string(), successful: z.boolean().optional(),
    verdict: z.enum(['verified', 'partial', 'failed']).optional(), reproduction: z.string().optional(),
  }, (a) => fail.addSolution(db, a.failureId, a));
  tool('brain_verification_record', 'Record evidence for a criterion. verdict verified needs actualResult and verificationType = the criterion verifyMethod; partial never counts as pass', {
    passed: z.boolean().optional(), verdict: z.enum(['verified', 'partial', 'failed']).optional(),
    goalId: z.string().optional(), workUnitId: z.string().optional(),
    requirementId: z.number().optional(), verificationType: z.string().optional(),
    command: z.string().optional(), expectedResult: z.string().optional(),
    actualResult: z.string().optional(),
  }, (a) => recordVerification(db, a));
  tool('brain_verification_state', 'Requirements with their verification runs for a goal', {
    goalId: z.string(),
  }, (a) => goalVerificationState(db, a.goalId));
  tool('brain_goal_resume', 'Full resume state + next recommended action (§72)', {
    id: z.string(),
  }, (a) => resumeGoal(db, a.id));

  // embeddings & import
  tool('brain_embed_reindex', 'Embed all missing/stale rows locally (ONNX). Large backlogs can take many minutes; prefer the CLI (`brain embed reindex`, shows progress) for those', {},
    () => reindexEmbeddings(db, embedder()));
  tool('brain_import_claude_mem', 'One-time idempotent claude-mem observation import', {
    path: z.string().optional(),
  }, (a) => importClaudeMem(db, a.path));

  tool('brain_goal_intake', 'Intake report: related context, §9 gaps (auto-questions), review items, duplicate requirements', {
    id: z.string(),
  }, (a) => buildIntakeReport(db, embedder(), a.id));
  tool('brain_question_add', 'Add a clarification question (max 5 material session questions per goal; give a recommended answer)', {
    goalId: z.string(), question: z.string(), detail: z.boolean().optional(), recommended: z.string().optional(),
  }, (a) => questions.addQuestion(db, a.goalId, { question: a.question, materiality: a.detail ? 'detail' : 'material', recommended: a.recommended }));
  tool('brain_question_answer', 'Answer a question; `as` also adds it as a contract line', {
    id: z.number(), answer: z.string(),
    as: z.enum(['constraint', 'exclusion', 'assumption', 'scope', 'permission', 'success_criterion']).optional(),
    verifyMethod: z.enum(['test', 'command', 'api', 'inspection', 'manual']).optional(),
    coverage: z.enum(['behaviour', 'data', 'failure_modes', 'edge_cases', 'non_functional', 'integration', 'completion']).optional(),
  }, (a) => questions.answerQuestion(db, a.id, a.answer, { as: a.as, verifyMethod: a.verifyMethod, coverage: a.coverage }));
  tool('brain_question_dismiss', 'Dismiss a question as not material (reason required)', {
    id: z.number(), reason: z.string(),
  }, (a) => questions.dismissQuestion(db, a.id, a.reason));
  tool('brain_question_list', 'List a goal\'s questions (open = pending only)', {
    goalId: z.string(), open: z.boolean().optional(),
  }, (a) => questions.listQuestions(db, a.goalId, { open: a.open }));
  return server;
}

async function main(): Promise<void> {
  const db = openDb();
  if (appliedMigrations(db) === 0) migrateDb(db);
  else if (pendingMigrations(db) > 0) console.error(SCHEMA_NOTICE);
  await buildServer(db).connect(new StdioServerTransport());
}

// Only start stdio transport when run directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
