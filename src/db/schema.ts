import { sqliteTable, text, integer, real, primaryKey, blob, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const goals = sqliteTable('goals', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  objective: text('objective').notNull(),
  status: text('status').notNull().default('DRAFT'),
  autonomyLevel: text('autonomy_level').notNull().default('full'),
  clarificationStatus: text('clarification_status').notNull().default('pending'),
  riskLevel: text('risk_level'),
  complexity: text('complexity'),
  contractSnapshot: text('contract_snapshot'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lockedAt: text('locked_at'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  rulesVersion: integer('rules_version').notNull().default(0),
  completionMode: text('completion_mode'),
  convergeSnapshot: text('converge_snapshot'),
});

export const goalRequirements = sqliteTable('goal_requirements', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  goalId: text('goal_id').notNull().references(() => goals.id),
  requirementType: text('requirement_type').notNull(),
  description: text('description').notNull(),
  priority: text('priority').notNull().default('required'),
  status: text('status').notNull().default('PENDING'),
  statusReason: text('status_reason'),
  verifyMethod: text('verify_method'),
  coverage: text('coverage'),
});

export const goalQuestions = sqliteTable('goal_questions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  goalId: text('goal_id').notNull().references(() => goals.id),
  question: text('question').notNull(),
  answer: text('answer'),
  status: text('status').notNull().default('pending'),
  createdAt: text('created_at').notNull(),
  answeredAt: text('answered_at'),
  materiality: text('materiality').notNull().default('material'),
  source: text('source').notNull().default('session'),
  checkKey: text('check_key'),
  requirementId: integer('requirement_id'),
  statusReason: text('status_reason'),
  recommended: text('recommended'),
}, (t) => [uniqueIndex('goal_questions_goal_check').on(t.goalId, t.checkKey)]);

export const decisions = sqliteTable('decisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  goalId: text('goal_id'),
  scopeType: text('scope_type'),
  scopeId: text('scope_id'),
  decision: text('decision').notNull(),
  reason: text('reason'),
  alternatives: text('alternatives'),
  riskLevel: text('risk_level'),
  reversible: integer('reversible').notNull().default(1),
  executor: text('executor'),
  createdAt: text('created_at').notNull(),
});

export const approvals = sqliteTable('approvals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  goalId: text('goal_id').references(() => goals.id),
  decisionId: integer('decision_id').references(() => decisions.id),
  action: text('action').notNull(),
  riskLevel: text('risk_level').notNull(),
  status: text('status').notNull().default('pending'),
  requestedAt: text('requested_at').notNull(),
  resolvedAt: text('resolved_at'),
});

export const workUnits = sqliteTable('work_units', {
  id: text('id').primaryKey(),
  goalId: text('goal_id').notNull().references(() => goals.id),
  parentId: text('parent_id'),
  title: text('title').notNull(),
  description: text('description'),
  workType: text('work_type'),
  complexity: text('complexity'),
  status: text('status').notNull().default('PENDING'),
  priority: integer('priority').notNull().default(100),
  attemptCount: integer('attempt_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
});

export const workUnitDependencies = sqliteTable('work_unit_dependencies', {
  workUnitId: text('work_unit_id').notNull(),
  dependsOn: text('depends_on').notNull(),
}, (t) => [primaryKey({ columns: [t.workUnitId, t.dependsOn] })]);

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').notNull().default('active'),
  rootPath: text('root_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const repositories = sqliteTable('repositories', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id),
  name: text('name').notNull(),
  path: text('path'),
  remoteUrl: text('remote_url'),
  defaultBranch: text('default_branch'),
  language: text('language'),
  framework: text('framework'),
  createdAt: text('created_at').notNull(),
});

export const entities = sqliteTable('entities', {
  id: text('id').primaryKey(),
  entityType: text('entity_type').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  metadata: text('metadata'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const relationships = sqliteTable('relationships', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('source_id').notNull(),
  relationshipType: text('relationship_type').notNull(),
  targetId: text('target_id').notNull(),
  metadata: text('metadata'),
  createdAt: text('created_at').notNull(),
});

export const knowledge = sqliteTable('knowledge', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  scopeType: text('scope_type').notNull(),
  scopeId: text('scope_id'),
  category: text('category'),
  statement: text('statement').notNull(),
  confidence: real('confidence').notNull().default(1.0),
  sourceType: text('source_type'),
  sourceReference: text('source_reference'),
  status: text('status').notNull().default('active'),
  supersededBy: integer('superseded_by'),
  createdAt: text('created_at').notNull(),
  lastVerifiedAt: text('last_verified_at'),
});

export const learnings = sqliteTable('learnings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  scopeType: text('scope_type'),
  scopeId: text('scope_id'),
  trigger: text('trigger'),
  learning: text('learning').notNull(),
  usefulnessScore: real('usefulness_score').notNull().default(1),
  timesUsed: integer('times_used').notNull().default(0),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
});

export const observations = sqliteTable('observations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  goalId: text('goal_id'),
  workUnitId: text('work_unit_id'),
  scopeType: text('scope_type'),
  scopeId: text('scope_id'),
  observation: text('observation').notNull(),
  confidence: real('confidence').notNull().default(1),
  sourceRef: text('source_ref'),
  createdAt: text('created_at').notNull(),
});

export const failures = sqliteTable('failures', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  goalId: text('goal_id'),
  workUnitId: text('work_unit_id'),
  failureType: text('failure_type'),
  errorMessage: text('error_message'),
  context: text('context'),
  resolved: integer('resolved').notNull().default(0),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
  resolutionNote: text('resolution_note'),
});

export const failureSolutions = sqliteTable('failure_solutions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  failureId: integer('failure_id').notNull().references(() => failures.id),
  solution: text('solution').notNull(),
  successful: integer('successful'),
  verdict: text('verdict'),
  reproduction: text('reproduction'),
  createdAt: text('created_at').notNull(),
});

export const executions = sqliteTable('executions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  goalId: text('goal_id'),
  workUnitId: text('work_unit_id'),
  executor: text('executor'),
  actionType: text('action_type'),
  command: text('command'),
  result: text('result'),
  exitCode: integer('exit_code'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
});

export const artifacts = sqliteTable('artifacts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  goalId: text('goal_id'),
  workUnitId: text('work_unit_id'),
  artifactType: text('artifact_type'),
  path: text('path'),
  entityId: text('entity_id'),
  changeType: text('change_type'),
  createdAt: text('created_at').notNull(),
});

export const verificationRuns = sqliteTable('verification_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  goalId: text('goal_id'),
  workUnitId: text('work_unit_id'),
  requirementId: integer('requirement_id').references(() => goalRequirements.id),
  verificationType: text('verification_type'),
  command: text('command'),
  expectedResult: text('expected_result'),
  actualResult: text('actual_result'),
  passed: integer('passed'),
  verdict: text('verdict'),
  createdAt: text('created_at').notNull(),
});

export const embeddings = sqliteTable('embeddings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceType: text('source_type').notNull(),
  sourceId: text('source_id').notNull(),
  model: text('model').notNull(),
  contentHash: text('content_hash').notNull(),
  vector: blob('vector', { mode: 'buffer' }).notNull(),
  createdAt: text('created_at').notNull(),
}, (t) => [uniqueIndex('embeddings_source_model').on(t.sourceType, t.sourceId, t.model)]);

export const goalProjects = sqliteTable('goal_projects', {
  goalId: text('goal_id').notNull().references(() => goals.id),
  projectId: text('project_id').notNull().references(() => projects.id),
}, (t) => [primaryKey({ columns: [t.goalId, t.projectId] })]);

export const workUnitRequirements = sqliteTable('work_unit_requirements', {
  workUnitId: text('work_unit_id').notNull().references(() => workUnits.id),
  requirementId: integer('requirement_id').notNull().references(() => goalRequirements.id),
}, (t) => [primaryKey({ columns: [t.workUnitId, t.requirementId] })]);

export const goalPrincipleAcks = sqliteTable('goal_principle_acks', {
  goalId: text('goal_id').notNull().references(() => goals.id),
  knowledgeId: integer('knowledge_id').notNull().references(() => knowledge.id),
  mode: text('mode').notNull(),
  note: text('note').notNull(),
  decisionId: integer('decision_id'),
  createdAt: text('created_at').notNull(),
}, (t) => [primaryKey({ columns: [t.goalId, t.knowledgeId] })]);
