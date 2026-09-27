import { Command } from 'commander';
import { openDb, migrateDb, resolveDbPath, type BrainDb } from '../db/connection.js';
import { backupDb } from '../db/backup.js';
import * as goals from '../services/goals.js';
import * as work from '../services/work.js';
import * as projects from '../services/projects.js';
import * as knowledge from '../services/knowledge.js';
import * as decisions from '../services/decisions.js';
import * as context from '../services/context.js';
import { recommendModel, type Complexity } from '../services/model.js';
import { scanProjects } from '../services/scanner.js';
import * as fail from '../services/failures.js';
import { recordVerification, goalVerificationState } from '../services/verification.js';
import { resumeGoal } from '../services/resume.js';
import { createFastEmbedder } from '../services/embedder.js';
import { reindexEmbeddings } from '../services/embedding-store.js';
import { hybridSearch } from '../services/hybrid-search.js';
import { importClaudeMem } from '../services/import-claude-mem.js';

function db(): BrainDb {
  const handle = openDb();
  migrateDb(handle); // idempotent; keeps CLI usable right after upgrades
  return handle;
}

const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

function run(fn: () => void): void {
  try { fn(); } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}

// Lazy: the embedder (ONNX model) is only initialised by commands that need it,
// so hot paths like `context get` (SessionStart hook) pay no model-load cost.
let embedderSingleton: ReturnType<typeof createFastEmbedder> | undefined;
const embedder = () => (embedderSingleton ??= createFastEmbedder());

async function runAsync(fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}

const program = new Command('brain').description('Central Brain CLI');

program.command('init').description('Create the database and apply migrations')
  .action(() => run(() => { db(); out({ ok: true, database: resolveDbPath() }); }));

program.command('backup').description('Snapshot the database (VACUUM INTO)')
  .action(() => run(() => out({ backup: backupDb(db()) })));

// ---- goal ----
const goal = program.command('goal');
goal.command('create <title>').option('-o, --objective <text>')
  .option('--risk <level>').option('--autonomy <level>')
  .option('--complexity <level>', 'trivial|low|medium|high|critical')
  .action((title, o) => run(() => out(goals.createGoal(db(), {
    title, objective: o.objective ?? title, riskLevel: o.risk,
    autonomyLevel: o.autonomy, complexity: o.complexity,
  }))));
goal.command('list').option('--status <status>')
  .action((o) => run(() => out(goals.listGoals(db(), { status: o.status }))));
goal.command('show <id>').action((id) => run(() => {
  const d = db();
  out({ ...goals.getGoal(d, id), requirements: goals.listRequirements(d, id) });
}));
goal.command('current').action(() => run(() => out(goals.currentGoal(db()) ?? null)));
goal.command('lock <id>').action((id) => run(() => out(goals.lockGoal(db(), id))));
goal.command('start <id>').action((id) => run(() => out(goals.startGoal(db(), id))));
goal.command('block <id> <reason>').action((id, reason) => run(() => out(goals.blockGoal(db(), id, reason))));
goal.command('complete <id>').option('--force')
  .action((id, o) => run(() => out(goals.completeGoal(db(), id, { force: o.force }))));
goal.command('resume <id>').description('Full resume state + next recommended action (§72)')
  .action((id) => run(() => out(resumeGoal(db(), id))));

const req = goal.command('requirement');
req.command('add <goalId> <description>')
  .option('-t, --type <type>', 'objective|constraint|success_criterion|exclusion|assumption', 'success_criterion')
  .option('-p, --priority <p>', 'required|optional', 'required')
  .action((goalId, description, o) => run(() =>
    out(goals.addRequirement(db(), goalId, { type: o.type, description, priority: o.priority }))));
req.command('status <id> <status>').option('-r, --reason <text>')
  .action((id, status, o) => run(() => {
    goals.setRequirementStatus(db(), Number(id), status, o.reason);
    out({ ok: true });
  }));

// ---- work ----
const workCmd = program.command('work');
workCmd.command('create <goalId> <title>')
  .option('-d, --description <text>').option('--type <workType>')
  .option('--complexity <level>', 'trivial|low|medium|high|critical')
  .option('--priority <n>').option('--depends-on <ids>', 'comma-separated work unit ids')
  .action((goalId, title, o) => run(() => out(work.createWorkUnit(db(), {
    goalId, title, description: o.description, workType: o.type,
    complexity: o.complexity,
    priority: o.priority ? Number(o.priority) : undefined,
    dependsOn: o.dependsOn ? String(o.dependsOn).split(',') : undefined,
  }))));
workCmd.command('update <id>').option('--status <status>').option('--title <t>')
  .action((id, o) => run(() => out(work.updateWorkUnit(db(), id, { status: o.status, title: o.title }))));
workCmd.command('list <goalId>').action((goalId) => run(() => out(work.listWorkUnits(db(), goalId))));
workCmd.command('ready <goalId>').action((goalId) => run(() => out(work.readyWorkUnits(db(), goalId))));

// ---- project / repo ----
const proj = program.command('project');
proj.command('add <name>').option('--path <rootPath>').option('-d, --description <text>')
  .action((name, o) => run(() => out(projects.addProject(db(), { name, rootPath: o.path, description: o.description }))));
proj.command('list').action(() => run(() => out(projects.listProjects(db()))));
proj.command('show <idOrName>').action((idOrName) => run(() => out(projects.getProject(db(), idOrName))));
proj.command('scan <dir>').description('Discover and register projects under a directory (§54)')
  .action((dir) => run(() => out(scanProjects(db(), dir))));

const repo = program.command('repo');
repo.command('add <name>').option('--project <projectId>').option('--path <path>')
  .option('--remote <url>').option('--branch <branch>').option('--language <lang>').option('--framework <fw>')
  .action((name, o) => run(() => out(projects.addRepo(db(), {
    name, projectId: o.project, path: o.path, remoteUrl: o.remote,
    defaultBranch: o.branch, language: o.language, framework: o.framework,
  }))));
repo.command('list').option('--project <projectId>')
  .action((o) => run(() => out(projects.listRepos(db(), o.project))));

// ---- knowledge / learning ----
const know = program.command('knowledge');
know.command('add <statement>')
  .option('-s, --scope <scopeType>', 'GLOBAL|PROJECT|REPOSITORY|SERVICE|ENVIRONMENT|MACHINE|FILE|MODULE|GOAL', 'GLOBAL')
  .option('--scope-id <prefixedId>').option('-c, --category <cat>')
  .option('--confidence <n>').option('--source <sourceType>').option('--source-ref <ref>')
  .action((statement, o) => run(() => out(knowledge.addKnowledge(db(), {
    scopeType: o.scope, scopeId: o.scopeId, category: o.category, statement,
    confidence: o.confidence ? Number(o.confidence) : undefined,
    sourceType: o.source, sourceReference: o.sourceRef,
  }))));
know.command('search <query>').option('-n, --limit <n>')
  .action((query, o) => runAsync(async () => out(await hybridSearch(db(), embedder(), query, {
    types: ['knowledge'], limit: o.limit ? Number(o.limit) : undefined,
  }))));
know.command('verify <id>').action((id) => run(() => out(knowledge.verifyKnowledge(db(), Number(id)))));
know.command('invalidate <id>').action((id) => run(() => out(knowledge.invalidateKnowledge(db(), Number(id)))));
know.command('supersede <id> <statement>')
  .action((id, statement) => run(() => out(knowledge.supersedeKnowledge(db(), Number(id), { statement }))));

const learn = program.command('learning');
learn.command('add <learning>').option('-s, --scope <scopeType>').option('--scope-id <prefixedId>').option('--trigger <text>')
  .action((text, o) => run(() => out(knowledge.addLearning(db(), {
    learning: text, scopeType: o.scope, scopeId: o.scopeId, trigger: o.trigger,
  }))));
learn.command('search <query>')
  .action((query) => runAsync(async () => out(await hybridSearch(db(), embedder(), query, { types: ['learning'] }))));
learn.command('useful <id>').action((id) => run(() => out(knowledge.markLearningUseful(db(), Number(id)))));

// ---- decision / observation / approval ----
const dec = program.command('decision');
dec.command('add <decision>').option('-g, --goal <goalId>').option('-r, --reason <text>')
  .option('--alternatives <text>').option('--risk <level>').option('--irreversible')
  .action((text, o) => run(() => out(decisions.addDecision(db(), {
    decision: text, goalId: o.goal, reason: o.reason, alternatives: o.alternatives,
    riskLevel: o.risk, reversible: !o.irreversible,
  }))));
dec.command('list').option('-g, --goal <goalId>')
  .action((o) => run(() => out(decisions.listDecisions(db(), { goalId: o.goal }))));

program.command('observe <observation>').option('-g, --goal <goalId>')
  .option('-s, --scope <scopeType>').option('--scope-id <prefixedId>')
  .action((text, o) => run(() => out(decisions.addObservation(db(), {
    observation: text, goalId: o.goal, scopeType: o.scope, scopeId: o.scopeId,
  }))));

const appr = program.command('approval');
appr.command('add <action>').option('--risk <level>', 'risk level', 'IRREVERSIBLE').option('-g, --goal <goalId>')
  .action((action, o) => run(() => out(decisions.addApproval(db(), { action, riskLevel: o.risk, goalId: o.goal }))));
appr.command('resolve <id> <status>')
  .action((id, status) => run(() => out(decisions.resolveApproval(db(), Number(id), status))));

// ---- context ----
const ctx = program.command('context');
ctx.command('get').option('-g, --goal <goalId>').option('--current')
  .option('-b, --budget <n>', 'max items', '30')
  .action((o) => run(() => out(context.getContext(db(), {
    goalId: o.goal, budget: Number(o.budget),
  }))));
ctx.command('search <query>').option('-n, --limit <n>')
  .action((query, o) => runAsync(async () => out(await hybridSearch(db(), embedder(), query, {
    limit: o.limit ? Number(o.limit) : undefined,
  }))));

// ---- failures ----
const failCmd = program.command('failure');
failCmd.command('add <errorMessage>').option('-g, --goal <goalId>')
  .option('--type <failureType>').option('--context <text>').option('--work-unit <id>')
  .action((errorMessage, o) => run(() => out(fail.addFailure(db(), {
    errorMessage, goalId: o.goal, failureType: o.type, context: o.context, workUnitId: o.workUnit,
  }))));
failCmd.command('search <query>').option('-n, --limit <n>')
  .action((query, o) => runAsync(async () => out(await hybridSearch(db(), embedder(), query, {
    types: ['failure'], limit: o.limit ? Number(o.limit) : undefined,
  }))));
failCmd.command('show <id>').action((id) => run(() => out(fail.getFailure(db(), Number(id)))));
failCmd.command('resolve <id>').action((id) => run(() => out(fail.resolveFailure(db(), Number(id)))));
failCmd.command('solution <failureId> <solution>').option('--successful')
  .action((failureId, solution, o) => run(() => out(fail.addSolution(db(), Number(failureId), {
    solution, successful: o.successful,
  }))));

// ---- verification ----
const verifyCmd = program.command('verify');
verifyCmd.command('add').requiredOption('-g, --goal <goalId>')
  .option('-r, --requirement <id>').option('--type <verificationType>')
  .option('--command <cmd>').option('--expected <text>').option('--actual <text>')
  .option('--passed').option('--failed')
  .action((o) => run(() => {
    if (o.passed === o.failed) throw new Error('Specify exactly one of --passed or --failed');
    out(recordVerification(db(), {
      passed: Boolean(o.passed), goalId: o.goal,
      requirementId: o.requirement ? Number(o.requirement) : undefined,
      verificationType: o.type, command: o.command,
      expectedResult: o.expected, actualResult: o.actual,
    }));
  }));
verifyCmd.command('goal <goalId>').action((goalId) => run(() => out(goalVerificationState(db(), goalId))));

// ---- embeddings & import ----
const embedCmd = program.command('embed');
embedCmd.command('reindex').description('Embed all missing/stale rows locally (ONNX)')
  .action(() => runAsync(async () => out(await reindexEmbeddings(db(), embedder()))));

const importCmd = program.command('import');
importCmd.command('claude-mem [path]').description('One-time idempotent claude-mem import (§79)')
  .action((p) => runAsync(async () => { out(importClaudeMem(db(), p)); }));

// ---- model routing ----
const modelCmd = program.command('model');
modelCmd.command('recommend').description('Recommend a Claude model (§12.1)')
  .option('-g, --goal <goalId>').option('-c, --complexity <level>')
  .action((o) => run(() => out(recommendModel(db(), {
    goalId: o.goal, complexity: o.complexity as Complexity | undefined,
  }))));

await program.parseAsync();
