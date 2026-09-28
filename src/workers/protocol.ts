// The only module that knows Claude Code's stream-json shapes (confirmed by probe, Claude Code 2.1.283).

export type WorkerMessage =
  | { kind: 'init'; sessionId: string }
  | { kind: 'permission'; requestId: string; toolName: string; input: Record<string, unknown>; description?: string }
  | { kind: 'assistant'; texts: string[]; tools: { name: string; input: Record<string, unknown> }[] }
  | { kind: 'tool_result'; isError: boolean; text: string }
  | { kind: 'result'; sessionId: string; isError: boolean; text: string }
  | { kind: 'ignored' };

export function workerArgs(opts: { systemPrompt: string; resumeSessionId?: string }): string[] {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'auto', '--permission-prompt-tool', 'stdio',
    '--append-system-prompt', opts.systemPrompt,
    ...(opts.resumeSessionId ? ['--resume', opts.resumeSessionId] : []),
  ];
}

export const initializeRequest = () => ({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } });
export const userMessage = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });

export function permissionResponse(
  requestId: string, decision: 'allow' | 'deny', input: Record<string, unknown>, message?: string,
) {
  const response = decision === 'allow'
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: message ?? 'The user denied this in the Brain UI.' };
  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } };
}

const asText = (c: unknown): string =>
  typeof c === 'string' ? c
    : Array.isArray(c) ? c.map(x => (x && typeof x === 'object' && 'text' in x ? String((x as { text: unknown }).text) : '')).join('')
    : '';

export function parseWorkerLine(line: string): WorkerMessage {
  let m: any;
  try { m = JSON.parse(line); } catch { return { kind: 'ignored' }; }
  if (!m || typeof m !== 'object') return { kind: 'ignored' };
  if (m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') {
    return { kind: 'init', sessionId: m.session_id };
  }
  if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
    return {
      kind: 'permission', requestId: String(m.request_id), toolName: String(m.request.tool_name),
      input: (m.request.input ?? {}) as Record<string, unknown>,
      ...(m.request.description ? { description: String(m.request.description) } : {}),
    };
  }
  if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
    const texts: string[] = [];
    const tools: { name: string; input: Record<string, unknown> }[] = [];
    for (const c of m.message.content) {
      if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) texts.push(c.text.trim());
      if (c?.type === 'tool_use') tools.push({ name: String(c.name), input: (c.input ?? {}) as Record<string, unknown> });
    }
    return { kind: 'assistant', texts, tools };
  }
  if (m.type === 'user' && Array.isArray(m.message?.content)) {
    const r = m.message.content.find((c: any) => c?.type === 'tool_result');
    if (r) return { kind: 'tool_result', isError: Boolean(r.is_error), text: asText(r.content) };
    return { kind: 'ignored' };
  }
  if (m.type === 'result') {
    return { kind: 'result', sessionId: String(m.session_id ?? ''), isError: Boolean(m.is_error), text: String(m.result ?? '') };
  }
  return { kind: 'ignored' };
}

function describeTool(name: string, input: Record<string, unknown>): string {
  if (name.startsWith('mcp__central-brain__')) return name.replace('mcp__central-brain__', '');
  const target = typeof input.command === 'string' ? input.command
    : typeof input.file_path === 'string' ? input.file_path
    : typeof input.pattern === 'string' ? input.pattern
    : typeof input.url === 'string' ? input.url : '';
  return target ? `${name}: ${target}` : name;
}

export function eventsFor(msg: WorkerMessage): { kind: string; summary: string; detail?: string }[] {
  switch (msg.kind) {
    case 'init': return [{ kind: 'system', summary: 'Worker session started' }];
    case 'permission':
      return [{ kind: 'system', summary: `Waiting for approval — ${describeTool(msg.toolName, msg.input)}`, detail: JSON.stringify(msg.input) }];
    case 'assistant':
      return [
        ...msg.texts.map(t => ({ kind: 'text', summary: t, detail: t })),
        ...msg.tools.map(t => ({ kind: 'tool', summary: describeTool(t.name, t.input), detail: JSON.stringify(t.input) })),
      ];
    case 'tool_result':
      return msg.isError ? [{ kind: 'error', summary: msg.text || 'Tool failed', detail: msg.text }] : [];
    case 'result':
      return [{ kind: 'result', summary: msg.isError ? 'Turn ended with an error' : 'Turn finished', detail: msg.text }];
    default: return [];
  }
}

export function workerSystemPrompt(goalId: string): string {
  return [
    `You are a Central Brain worker launched from the Brain web UI to carry out goal ${goalId}. Work only on this goal.`,
    'Follow the Central Brain rules in the global CLAUDE.md: run brain_goal_intake, fill contract gaps you can discover, and record decisions, failures and verifications as you go.',
    'Never answer material questions or the review:behaviour question yourself. For every behaviour choice a user would notice and every other material question, call brain_question_add (or leave the intake question open), then END YOUR TURN. The user answers in the Brain UI; you will be told when to continue.',
    'Stay inside the locked scope. Pushes, deploys, data deletion and production changes need the user\'s explicit OK — ask through a Brain question.',
    'Finish only through brain_verification_record for each success criterion followed by brain_goal_complete.',
  ].join('\n');
}

export const firstMessage = (g: { id: string; title: string; objective: string }) =>
  `Carry out Brain goal ${g.id}: "${g.title}". Objective: ${g.objective}\nStart with brain_goal_resume and brain_goal_intake for ${g.id}, then proceed.`;
export const answersMessage = (goalId: string) =>
  `Your questions for ${goalId} have been answered in Brain. Read them with brain_question_list (goalId ${goalId}) and continue.`;
export const nudgeMessage = (goalId: string) =>
  `Continue ${goalId} until it is verified complete, or ask the user through Brain questions and end your turn.`;
export const resumeMessage = (goalId: string) =>
  `Resume work on ${goalId}: run brain_goal_resume, check for answered questions, and continue.`;
