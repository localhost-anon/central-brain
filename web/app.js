// Central Brain UI — framework-free. All server data is escaped with esc() before rendering.
const view = document.getElementById('view');
const needsEl = document.getElementById('needs');
const banner = document.getElementById('banner');
let current = { page: 'home', goalId: null };
let reloadTimer = null;

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const time = ts => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const when = ts => (ts ? new Date(ts).toLocaleString() : '');

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function flash(msg) { alert(msg); }

// ---------- home ----------
async function renderHome() {
  const [goals, needs] = await Promise.all([api(`/api/goals${homeQuery()}`), api('/api/needs-you')]);
  view.innerHTML = `
    ${needsPanel(needs)}
    <section class="panel">
      <h2>Goals</h2>
      <div class="filters">
        <input id="q" placeholder="Search goals" value="${esc(sessionStorage.q || '')}">
        <select id="status">
          ${['', 'DRAFT', 'LOCKED', 'EXECUTING', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED']
            .map(s => `<option value="${s}" ${s === (sessionStorage.status || '') ? 'selected' : ''}>${s || 'All statuses'}</option>`).join('')}
        </select>
      </div>
      <table>
        <thead><tr><th>Goal</th><th>Status</th><th>Worker</th><th>Criteria</th><th>Needs you</th><th>Updated</th></tr></thead>
        <tbody>${goals.map(g => `
          <tr class="row" data-id="${esc(g.id)}">
            <td><strong>${esc(g.id)}</strong><br>${esc(g.title)}</td>
            <td><span class="badge ${esc(g.status)}">${esc(g.status)}</span></td>
            <td>${g.run ? `<span class="badge ${esc(g.run.status)}">${esc(label(g.run.status))}</span>` : '<span class="muted">—</span>'}</td>
            <td>${g.criteria.total ? `${g.criteria.passed}/${g.criteria.total}` : '<span class="muted">—</span>'}</td>
            <td>${g.openQuestions + g.pendingApprovals || ''}</td>
            <td class="small muted">${esc(when(g.updatedAt))}</td>
          </tr>`).join('') || '<tr><td colspan="6" class="muted">No goals</td></tr>'}
        </tbody>
      </table>
    </section>`;
  view.querySelectorAll('tr.row').forEach(tr => tr.addEventListener('click', () => { location.hash = `#/goal/${tr.dataset.id}`; }));
  const q = document.getElementById('q');
  q.addEventListener('change', () => { sessionStorage.q = q.value; renderHome(); });
  document.getElementById('status').addEventListener('change', e => { sessionStorage.status = e.target.value; renderHome(); });
  bindNeeds();
}

function homeQuery() {
  const p = new URLSearchParams();
  if (sessionStorage.q) p.set('q', sessionStorage.q);
  if (sessionStorage.status) p.set('status', sessionStorage.status);
  const s = p.toString();
  return s ? `?${s}` : '';
}

const label = s => ({ waiting_answers: 'Waiting for you', waiting_approval: 'Waiting for approval' }[s] || s);

function needsPanel(needs) {
  if (!needs.count) return '';
  return `<section class="panel"><h2>Needs you (${needs.count})</h2>
    ${needs.approvals.map(approvalCard).join('')}
    ${needs.questions.length ? `<p class="small muted">Open questions — answer them on the goal page:</p>
      <ul>${needs.questions.map(q => `<li><a href="#/goal/${esc(q.goalId)}">${esc(q.goalId)} · ${esc(q.goalTitle)}</a>: ${esc(q.question)}</li>`).join('')}</ul>` : ''}
  </section>`;
}

function approvalCard(a) {
  let input = a.requestJson;
  try { input = JSON.stringify(JSON.parse(a.requestJson), null, 2); } catch { /* keep raw */ }
  return `<div class="card risk-${esc(a.riskLevel)}" data-approval="${esc(a.id)}">
    <div><span class="badge">${esc(a.riskLevel)}</span> <strong>${esc(a.toolName || 'Action')}</strong>
      <span class="small muted">· ${esc(a.goalId)} ${a.goalTitle ? `· ${esc(a.goalTitle)}` : ''}</span></div>
    <div>${esc(a.action)}</div>
    <pre>${esc(input)}</pre>
    <div class="row-actions">
      <button class="btn primary" data-decide="allow">Allow</button>
      <button class="btn danger" data-decide="deny">Deny</button>
      <input placeholder="Note to the worker (optional)" data-note>
    </div></div>`;
}

function bindNeeds() {
  view.querySelectorAll('[data-approval]').forEach(card => {
    card.querySelectorAll('[data-decide]').forEach(btn => btn.addEventListener('click', async () => {
      const note = card.querySelector('[data-note]').value.trim() || undefined;
      try { await api(`/api/approvals/${card.dataset.approval}`, { decision: btn.dataset.decide, note }); refresh(); }
      catch (e) { flash(e.message); }
    }));
  });
}

// ---------- new goal ----------
async function renderNew() {
  const projects = await api('/api/projects');
  view.innerHTML = `<section class="panel"><h2>New goal</h2>
    <p><label>Title<br><input id="title" style="width:100%"></label></p>
    <p><label>Objective — what must be true when this is done?<br><textarea id="objective"></textarea></label></p>
    <p><label>Project (optional)<br><select id="project"><option value="">Let the worker find it</option>
      ${projects.sort((a, b) => a.name.localeCompare(b.name)).map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}
    </select></label></p>
    <p><label><input type="checkbox" id="start" checked> Start a worker now</label></p>
    <button class="btn primary" id="create">Create goal</button></section>`;
  document.getElementById('create').addEventListener('click', async e => {
    e.target.disabled = true;
    try {
      const out = await api('/api/goals', {
        title: document.getElementById('title').value, objective: document.getElementById('objective').value,
        projectId: document.getElementById('project').value || undefined, startWorker: document.getElementById('start').checked,
      });
      location.hash = `#/goal/${out.goal.id}`;
    } catch (err) { flash(err.message); e.target.disabled = false; }
  });
}

// ---------- goal detail ----------
async function renderGoal(id) {
  const d = await api(`/api/goals/${encodeURIComponent(id)}`);
  const g = d.goal;
  const run = d.runs[0];
  const active = run && ['queued', 'starting', 'working', 'waiting_answers', 'waiting_approval'].includes(run.status);
  const reqs = t => d.requirements.filter(r => r.requirementType === t);
  const evidence = r => d.verifications.filter(v => v.requirementId === r.id).map(v => `<div class="small muted">${esc(v.actualResult)}</div>`).join('');
  const open = d.questions.filter(q => d.openQuestions.includes(q.id));
  const pending = d.approvals.filter(a => a.status === 'pending' && a.runId);
  view.innerHTML = `
    <section class="panel">
      <h2>${esc(g.id)} · ${esc(g.title)}</h2>
      <p>${esc(g.objective)}</p>
      <p><span class="badge ${esc(g.status)}">${esc(g.status)}</span>
        ${g.riskLevel ? `<span class="badge">risk ${esc(g.riskLevel)}</span>` : ''}
        ${run ? `<span class="badge ${esc(run.status)}">worker: ${esc(label(run.status))}</span> <span class="small muted">${esc(run.cwd)}</span>` : ''}
        ${run?.exitReason ? `<span class="small muted"> — ${esc(run.exitReason)}</span>` : ''}</p>
      <div class="row-actions">
        ${!active && g.status !== 'COMPLETED' ? `<button class="btn primary" data-worker="${run?.sessionId ? 'resume' : 'start'}">${run?.sessionId ? 'Resume worker' : 'Start worker'}</button>` : ''}
        ${active ? '<button class="btn danger" data-worker="stop">Stop worker</button>' : ''}
      </div>
    </section>
    ${pending.length ? `<section class="panel"><h2>Approvals</h2>${pending.map(approvalCard).join('')}</section>` : ''}
    ${open.length ? `<section class="panel"><h2>Questions (${open.length}) — answer together</h2>
      ${open.map(q => `<div class="card" data-q="${esc(q.id)}">
        <div><strong>${esc(q.question)}</strong> <span class="small muted">${esc(q.source)}${q.checkKey ? ` · ${esc(q.checkKey)}` : ''}</span></div>
        <textarea data-answer></textarea>
        <div class="row-actions">
          <select data-as><option value="">Record as answer only</option>
            ${['constraint', 'scope', 'success_criterion', 'exclusion', 'assumption', 'permission'].map(t => `<option value="${t}">Record as ${t}</option>`).join('')}
          </select>
          <input placeholder="Dismiss reason" data-reason><button class="btn" data-dismiss>Dismiss</button>
        </div></div>`).join('')}
      <button class="btn primary" id="send-answers">Send answers</button></section>` : ''}
    <div class="grid2">
      <section class="panel"><h2>Contract</h2>
        ${section('Scope', reqs('scope'), r => esc(r.description))}
        ${section('Success criteria', reqs('success_criterion'), r => `<span class="badge ${esc(r.status)}">${esc(r.status)}</span> ${esc(r.description)}${evidence(r)}`)}
        ${section('Constraints', reqs('constraint'), r => esc(r.description))}
        ${section('Exclusions', reqs('exclusion'), r => esc(r.description))}
        ${section('Answered questions', d.questions.filter(q => q.status === 'answered'), q => `${esc(q.question)}<div class="small muted">${esc(q.answer)}</div>`)}
      </section>
      <section class="panel"><h2>Live timeline</h2><div class="timeline" id="timeline">
        ${d.timeline.map(tlRow).join('') || '<p class="muted">Nothing yet</p>'}</div></section>
    </div>
    <div class="grid2">
      <section class="panel"><h2>Decisions</h2>${d.decisions.map(x => `<div class="card">${esc(x.decision)}<div class="small muted">${esc(x.reason)}</div></div>`).join('') || '<p class="muted">None</p>'}</section>
      <section class="panel"><h2>Failures</h2>${d.failures.map(x => `<div class="card">${x.resolved ? '✓ ' : ''}${esc(x.errorMessage)}</div>`).join('') || '<p class="muted">None</p>'}</section>
    </div>`;
  const tl = document.getElementById('timeline');
  tl.scrollTop = tl.scrollHeight;
  view.querySelectorAll('[data-worker]').forEach(b => b.addEventListener('click', async () => {
    try { await api(`/api/goals/${encodeURIComponent(g.id)}/worker`, { action: b.dataset.worker }); refresh(); } catch (e) { flash(e.message); }
  }));
  view.querySelectorAll('[data-dismiss]').forEach(b => b.addEventListener('click', async () => {
    const card = b.closest('[data-q]');
    try { await api(`/api/questions/${card.dataset.q}/dismiss`, { reason: card.querySelector('[data-reason]').value }); refresh(); }
    catch (e) { flash(e.message); }
  }));
  const send = document.getElementById('send-answers');
  send?.addEventListener('click', async () => {
    send.disabled = true;
    try {
      for (const card of view.querySelectorAll('[data-q]')) {
        const answer = card.querySelector('[data-answer]').value.trim();
        if (!answer) continue;
        await api(`/api/questions/${card.dataset.q}/answer`, { answer, as: card.querySelector('[data-as]').value || undefined });
      }
      refresh();
    } catch (e) { flash(e.message); send.disabled = false; }
  });
  bindNeeds();
}

function section(title, rows, fmt) {
  if (!rows.length) return '';
  return `<h3 class="small muted">${esc(title)}</h3><ul>${rows.map(r => `<li>${fmt(r)}</li>`).join('')}</ul>`;
}

function tlRow(t) {
  return `<div class="tl"><span class="muted">${esc(time(t.ts))}</span><span class="k badge">${esc(t.kind)}</span><span>${esc(t.text)}</span></div>`;
}

// ---------- routing + live updates ----------
function route() {
  const h = location.hash || '#/';
  const m = h.match(/^#\/goal\/(.+)$/);
  current = m ? { page: 'goal', goalId: decodeURIComponent(m[1]) } : { page: h === '#/new' ? 'new' : 'home', goalId: null };
  refresh();
}

function refresh() {
  const p = current.page === 'goal' ? renderGoal(current.goalId) : current.page === 'new' ? renderNew() : renderHome();
  p.catch(e => { view.innerHTML = `<section class="panel"><h2>Error</h2><p>${esc(e.message)}</p><a href="#/">Back to goals</a></section>`; });
}

function scheduleReload() {
  if (current.page === 'new') return;              // never wipe a half-typed form
  if (view.querySelector('textarea:focus, input:focus')) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(refresh, 300);
}

function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => { banner.hidden = true; };
  es.onerror = () => { banner.hidden = false; };
  es.addEventListener('needs-you', e => {
    const { count } = JSON.parse(e.data);
    needsEl.hidden = !count;
    needsEl.textContent = `${count} need${count === 1 ? 's' : ''} you`;
    document.title = count ? `(${count}) Central Brain` : 'Central Brain';
  });
  es.addEventListener('goal-changed', e => {
    const { goalId } = JSON.parse(e.data);
    if (current.page === 'home' || current.goalId === goalId) scheduleReload();
  });
  es.addEventListener('worker-event', e => {
    const { goalId, event } = JSON.parse(e.data);
    if (current.goalId !== goalId) return;
    const tl = document.getElementById('timeline');
    if (!tl) return;
    const atBottom = tl.scrollTop + tl.clientHeight >= tl.scrollHeight - 20;
    tl.insertAdjacentHTML('beforeend', tlRow({ ts: event.ts, kind: `worker-${event.kind}`, text: event.summary }));
    if (atBottom) tl.scrollTop = tl.scrollHeight;
  });
  es.addEventListener('run-changed', e => {
    const { goalId } = JSON.parse(e.data);
    if (current.page === 'home' || current.goalId === goalId) scheduleReload();
  });
}

window.addEventListener('hashchange', route);
connect();
route();
