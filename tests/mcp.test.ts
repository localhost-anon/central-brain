import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestDb } from './helpers.js';
import { buildServer } from '../src/mcp/server.js';

async function connect() {
  const db = createTestDb();
  const server = buildServer(db);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

const text = (res: any) => JSON.parse(res.content[0].text);

describe('brain MCP server', () => {
  it('exposes the brain_* tool surface', async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools.map(t => t.name);
    for (const t of ['brain_goal_create', 'brain_context_get', 'brain_knowledge_search', 'brain_decision_add', 'brain_model_recommend', 'brain_knowledge_supersede', 'brain_approval_resolve', 'brain_project_scan', 'brain_failure_search', 'brain_goal_resume', 'brain_embed_reindex', 'brain_import_claude_mem']) {
      expect(tools).toContain(t);
    }
  });

  it('creates, locks, and retrieves context for a goal via tools', async () => {
    const client = await connect();
    const g = text(await client.callTool({
      name: 'brain_goal_create',
      arguments: { title: 'Add SSO', objective: 'MS auth works' },
    }));
    expect(g.id).toMatch(/^GOAL-/);
    await client.callTool({
      name: 'brain_requirement_add',
      arguments: { goalId: g.id, description: 'login works', type: 'success_criterion' },
    });
    await client.callTool({ name: 'brain_requirement_add', arguments: { goalId: g.id, description: 'auth only', type: 'scope' } });
    await client.callTool({ name: 'brain_goal_set', arguments: { id: g.id, risk: 'LOW' } });
    await client.callTool({ name: 'brain_goal_lock', arguments: { id: g.id } });
    const ctx = text(await client.callTool({ name: 'brain_context_get', arguments: {} }));
    expect(ctx.goal.id).toBe(g.id);
    expect(ctx.requirements).toHaveLength(2);
  });

  it('surfaces service errors as tool errors', async () => {
    const client = await connect();
    const res: any = await client.callTool({ name: 'brain_goal_get', arguments: { id: 'GOAL-9999-9999' } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
  });

  it('records failures and resumes goals via tools', async () => {
    const client = await connect();
    const g = text(await client.callTool({
      name: 'brain_goal_create', arguments: { title: 'T', objective: 'O' },
    }));
    await client.callTool({
      name: 'brain_failure_record',
      arguments: { errorMessage: 'EADDRINUSE port 8020', goalId: g.id },
    });
    const hits = text(await client.callTool({
      name: 'brain_failure_search', arguments: { query: 'eaddrinuse' },
    }));
    expect(hits).toHaveLength(1);
    const state = text(await client.callTool({ name: 'brain_goal_resume', arguments: { id: g.id } }));
    expect(state.unresolvedFailures).toHaveLength(1);
    expect(state.nextRecommendedAction).toMatch(/lock the goal contract/i);
  });
});
