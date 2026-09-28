import fs from 'node:fs';
import readline from 'node:readline';

const log = (o) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const scenario = process.env.FAKE_SCENARIO ?? 'stall';
log({ argv: process.argv.slice(2) });
let turn = 0;
let pending = null;

const result = () => out({ type: 'result', subtype: 'success', is_error: false, session_id: 'fake-session-1', result: `turn ${turn}` });

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  log(m);
  if (m.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } }); return; }
  if (m.type === 'control_response' && pending) {
    const denied = m.response.response.behavior === 'deny';
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: denied, content: denied ? m.response.response.message : 'ok' }] } });
    pending = null; result(); return;
  }
  if (m.type !== 'user') return;
  turn += 1;
  if (turn === 1) out({ type: 'system', subtype: 'init', session_id: 'fake-session-1' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `working turn ${turn}` }] } });
  out('not json at all');
  if (scenario === 'crash') { process.exit(3); }
  if (scenario === 'permission' && turn === 1) {
    pending = 'r-1';
    out({ type: 'control_request', request_id: 'r-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git push' }, description: 'Push' } });
    return;
  }
  result();
});
process.stdin.on('end', () => process.exit(0));
