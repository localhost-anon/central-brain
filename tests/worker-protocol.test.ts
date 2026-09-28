import { describe, it, expect } from 'vitest';
import {
  workerArgs, initializeRequest, userMessage, permissionResponse, parseWorkerLine, eventsFor,
  workerSystemPrompt, firstMessage,
} from '../src/workers/protocol.js';

const INIT = '{"type":"system","subtype":"init","session_id":"0ed7ff10","cwd":"/x","tools":["Bash"]}';
const HOOK = '{"type":"system","subtype":"hook_started","hook_name":"SessionStart"}';
const PERM = '{"type":"control_request","request_id":"50b1","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"touch probe-file.txt","description":"Create empty probe file"},"description":"Create empty probe file","tool_use_id":"toolu_01"}}';
const ASSIST = '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""},{"type":"text","text":"Running it now."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}},{"type":"tool_use","id":"t2","name":"mcp__central-brain__brain_goal_intake","input":{"id":"GOAL-1"}},{"type":"tool_use","id":"t3","name":"Edit","input":{"file_path":"/p/js/app.js"}}]}}';
const TOOLRES = '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"User denied this in the Brain UI."}]}}';
const RESULT = '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"session_id":"0ed7ff10","result":"Done."}';

describe('worker protocol', () => {
  it('builds the confirmed launch args, with --resume only when resuming', () => {
    const a = workerArgs({ systemPrompt: 'RULES' });
    expect(a).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'auto', '--permission-prompt-tool', 'stdio', '--append-system-prompt', 'RULES']);
    expect(workerArgs({ systemPrompt: 'R', resumeSessionId: 's1' }).slice(-2)).toEqual(['--resume', 's1']);
  });

  it('builds stdin messages', () => {
    expect(initializeRequest()).toEqual({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } });
    expect(userMessage('hi')).toEqual({ type: 'user', message: { role: 'user', content: 'hi' } });
    expect(permissionResponse('r1', 'allow', { command: 'x' })).toEqual({ type: 'control_response',
      response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { command: 'x' } } } });
    expect(permissionResponse('r1', 'deny', {}, 'no')).toEqual({ type: 'control_response',
      response: { subtype: 'success', request_id: 'r1', response: { behavior: 'deny', message: 'no' } } });
  });

  it('parses the message kinds and ignores noise and non-JSON (Review Focus 5)', () => {
    expect(parseWorkerLine(INIT)).toEqual({ kind: 'init', sessionId: '0ed7ff10' });
    expect(parseWorkerLine(HOOK)).toEqual({ kind: 'ignored' });
    expect(parseWorkerLine('warning: something odd')).toEqual({ kind: 'ignored' });
    expect(parseWorkerLine('')).toEqual({ kind: 'ignored' });
    expect(parseWorkerLine(PERM)).toEqual({ kind: 'permission', requestId: '50b1', toolName: 'Bash',
      input: { command: 'touch probe-file.txt', description: 'Create empty probe file' }, description: 'Create empty probe file' });
    const a = parseWorkerLine(ASSIST);
    expect(a).toEqual({ kind: 'assistant', texts: ['Running it now.'], tools: [
      { name: 'Bash', input: { command: 'npm test' } },
      { name: 'mcp__central-brain__brain_goal_intake', input: { id: 'GOAL-1' } },
      { name: 'Edit', input: { file_path: '/p/js/app.js' } }] });
    expect(parseWorkerLine(TOOLRES)).toEqual({ kind: 'tool_result', isError: true, text: 'User denied this in the Brain UI.' });
    expect(parseWorkerLine(RESULT)).toEqual({ kind: 'result', sessionId: '0ed7ff10', isError: false, text: 'Done.' });
  });

  it('turns messages into readable timeline events', () => {
    expect(eventsFor(parseWorkerLine(ASSIST)).map(e => e.summary)).toEqual([
      'Running it now.', 'Bash: npm test', 'brain_goal_intake', 'Edit: /p/js/app.js']);
    expect(eventsFor(parseWorkerLine(TOOLRES))[0]).toMatchObject({ kind: 'error' });
    expect(eventsFor(parseWorkerLine(RESULT))[0]).toMatchObject({ kind: 'result', summary: 'Turn finished' });
    expect(eventsFor(parseWorkerLine(PERM))[0].summary).toBe('Waiting for approval — Bash: touch probe-file.txt');
    expect(eventsFor({ kind: 'ignored' })).toEqual([]);
  });

  it('worker rules forbid answering material questions itself', () => {
    const p = workerSystemPrompt('GOAL-2026-0099');
    expect(p).toContain('GOAL-2026-0099');
    expect(p).toContain('brain_question_add');
    expect(p).toMatch(/never answer/i);
    expect(p).toContain('force');
    expect(p).toContain('brain_goal_block');
    expect(p).toContain('approval card');
    expect(p).not.toMatch(/through a Brain question/i);
    expect(firstMessage({ id: 'GOAL-1', title: 'T', objective: 'O' })).toContain('brain_goal_intake');
  });
});
