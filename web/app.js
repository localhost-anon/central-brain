// Central Brain UI — framework-free. All server data is escaped with esc() before rendering.
// Layout: project sidebar (a drawer on phones) + one reading column. Goal detail reads as a
// thread: the worker on the left, you on the right, Brain events quietly in the middle.
const view = document.getElementById('view');
const needsEl = document.getElementById('needs');
const banner = document.getElementById('banner');
const sideNav = document.getElementById('side-nav');
const sidebar = document.getElementById('sidebar');
const scrim = document.getElementById('scrim');
const scopeTitle = document.getElementById('scope-title');
const sideSearch = document.getElementById('side-search');

let current = { page: 'home', goalId: null, project: 'all' };
let reloadTimer = null;
let allGoals = [];
let needsCount = 0;

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const ACTIVE_RUN = ['queued', 'starting', 'working', 'waiting_answers', 'waiting_approval'];
const RUN_LABEL = {
  queued: 'Worker queued', starting: 'Worker starting', working: 'Worker running',
  waiting_answers: 'Waiting for your answers', waiting_approval: 'Waiting for your approval',
  stopped: 'Worker stopped', completed: 'Worker finished', failed: 'Worker failed',
};
const STATUS_LABEL = {
  DRAFT: 'Draft', LOCKED: 'Ready', PLANNING: 'Planning', EXECUTING: 'Running', VERIFYING: 'Verifying',
  BLOCKED: 'Blocked', COMPLETED: 'Done', FAILED: 'Failed', CANCELLED: 'Cancelled',
};
const FILTERS = [['active', 'Active'], ['needs', 'Needs you'], ['done', 'Done'], ['all', 'All']];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const clock = ts => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const dayOf = ts => (ts ? new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : '');
function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return dayOf(ts);
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 3500);
}

// ---------- sidebar / drawer ----------
function openSide() { sidebar.classList.add('open'); scrim.hidden = false; sidebar.querySelector('.new-goal').focus(); }
function closeSide() { sidebar.classList.remove('open'); scrim.hidden = true; }
document.getElementById('open-side').addEventListener('click', openSide);
document.getElementById('close-side').addEventListener('click', closeSide);
scrim.addEventListener('click', closeSide);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSide(); });
sidebar.addEventListener('click', e => { if (e.target.closest('a')) closeSide(); });
sideSearch.addEventListener('change', () => {
  sessionStorage.q = sideSearch.value.trim();
  if (current.page !== 'home') location.hash = `#/p/${encodeURIComponent(current.project)}`; else refresh();
  closeSide();
});
document.getElementById('reload-now').addEventListener('click', () => refresh());

const waits = g => g.openQuestions + g.pendingApprovals;

function renderSidebar() {
  const by = new Map();
  const bump = (key, name, g) => {
    const e = by.get(key) ?? { key, name, count: 0, waits: 0 };
    e.count += 1; e.waits += waits(g) > 0 ? 1 : 0; by.set(key, e);
  };
  for (const g of allGoals) bump(g.project?.id ?? 'unassigned', g.project?.name ?? 'Unassigned', g);
  const projects = [...by.values()].filter(e => e.key !== 'unassigned')
    .sort((a, b) => b.waits - a.waits || b.count - a.count || a.name.localeCompare(b.name));
  const un = by.get('unassigned');
  const sel = current.page === 'home' ? current.project : current.page === 'goal' ? null : '';
  const item = (key, name, count, w) => `<a class="side-item" href="#/p/${encodeURIComponent(key)}"
      ${sel === key ? 'aria-current="page"' : ''}>${w ? '<span class="dot-you" title="Waits on you"></span>' : ''}
      <span class="name">${esc(name)}</span><span class="count">${count}</span></a>`;
  sideNav.innerHTML = [
    `<a class="side-item" href="#/needs" ${current.page === 'needs' ? 'aria-current="page"' : ''}>
      ${needsCount ? '<span class="dot-you"></span>' : ''}<span class="name">Needs you</span><span class="count">${needsCount}</span></a>`,
    item('all', 'All goals', allGoals.length, 0),
    '<div class="side-group">Projects</div>',
    ...projects.map(p => item(p.key, p.name, p.count, p.waits)),
    un ? item('unassigned', 'Unassigned', un.count, un.waits) : '',
  ].join('');
}

async function loadGoals() {
  allGoals = await api('/api/goals');
  renderSidebar();
}

// ---------- home: one project's goals ----------
const projectName = key => (key === 'all' ? 'All goals' : key === 'unassigned' ? 'Unassigned'
  : allGoals.find(g => g.project?.id === key)?.project.name ?? key);

function goalRow(g) {
  const run = g.run && RUN_LABEL[g.run.status];
  const w = waits(g);
  return `<li class="goal-row"><a href="#/goal/${encodeURIComponent(g.id)}">
    <span class="goal-title">${esc(g.title)}</span>
    <span class="goal-right">${w ? `<span class="waits">${w} for you</span>` : esc(ago(g.updatedAt))}</span>
    <span class="goal-sub">
      <span class="status s-${esc(g.status)}">${esc(STATUS_LABEL[g.status] ?? g.status)}</span>
      ${current.project === 'all' ? (g.project ? `<span class="proj-tag">${esc(g.project.name)}</span>` : '<span class="proj-tag none">No project</span>') : ''}
      ${g.criteria.total ? `<span>${g.criteria.passed} of ${g.criteria.total} criteria</span>` : ''}
      ${run && g.run && ACTIVE_RUN.includes(g.run.status) ? `<span>${esc(run)}</span>` : ''}
      <span>${esc(g.id)}</span>
    </span></a></li>`;
}

async function renderHome() {
  const filter = sessionStorage.filter || 'active';
  const q = sessionStorage.q || '';
  sideSearch.value = q;
  const params = new URLSearchParams();
  if (current.project !== 'all') params.set('project', current.project);
  if (q) params.set('q', q);
  const [rowsAll] = await Promise.all([api(`/api/goals${params.size ? `?${params}` : ''}`), loadGoals()]);
  scopeTitle.textContent = projectName(current.project);
  const rows = rowsAll.filter(g => filter === 'all' ? true : filter === 'done' ? TERMINAL.includes(g.status)
    : filter === 'needs' ? waits(g) > 0 : !TERMINAL.includes(g.status));
  rows.sort((a, b) => waits(b) - waits(a) || b.updatedAt.localeCompare(a.updatedAt));
  const newHref = `#/new${current.project !== 'all' && current.project !== 'unassigned' ? `?project=${encodeURIComponent(current.project)}` : ''}`;
  view.innerHTML = `
    <div class="chips" role="group" aria-label="Filter goals">
      ${FILTERS.map(([k, label]) => `<button class="chip" data-filter="${k}" aria-pressed="${k === filter}">${label}</button>`).join('')}
    </div>
    ${q ? `<p class="hint" style="text-align:left">Matching “${esc(q)}”. <button class="link-btn" id="clear-q">Clear search</button></p>` : ''}
    ${rows.length ? `<ul class="goal-list">${rows.map(goalRow).join('')}</ul>`
      : `<p class="empty">No ${filter === 'all' ? '' : esc(FILTERS.find(f => f[0] === filter)[1].toLowerCase())} goals here. <a href="${newHref}">Start a new goal</a></p>`}`;
  view.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => { sessionStorage.filter = b.dataset.filter; renderHome(); }));
  document.getElementById('clear-q')?.addEventListener('click', () => { sessionStorage.q = ''; renderHome(); });
}

// ---------- needs you: every question and approval across goals ----------
function approvalCard(a) {
  let input = a.requestJson;
  try { input = JSON.stringify(JSON.parse(a.requestJson), null, 2); } catch { /* keep raw */ }
  return `<div class="ask" data-approval="${esc(a.id)}">
    <div class="ask-head"><span class="risk risk-${esc(a.riskLevel)}">${esc(a.riskLevel)} risk</span>
      <strong>${esc(a.toolName || 'Action')}</strong>
      ${a.goalId ? `<a href="#/goal/${encodeURIComponent(a.goalId)}">${esc(a.goalTitle || a.goalId)}</a>` : ''}</div>
    <div>${esc(a.action)}</div>
    ${input ? `<pre>${esc(input)}</pre>` : ''}
    <div class="actions">
      <button class="btn primary" data-decide="allow">Allow</button>
      <button class="btn danger" data-decide="deny">Deny</button>
      <input class="field grow" placeholder="Note to the worker (optional)" data-note>
    </div></div>`;
}

function bindApprovals() {
  view.querySelectorAll('[data-approval]').forEach(card => {
    card.querySelectorAll('[data-decide]').forEach(btn => btn.addEventListener('click', async () => {
      const note = card.querySelector('[data-note]').value.trim() || undefined;
      btn.disabled = true;
      try {
        await api(`/api/approvals/${card.dataset.approval}`, { decision: btn.dataset.decide, note });
        toast(btn.dataset.decide === 'allow' ? 'Allowed' : 'Denied');
        refresh();
      } catch (e) { toast(e.message, 'bad'); btn.disabled = false; }
    }));
  });
}

async function renderNeeds() {
  const [needs] = await Promise.all([api('/api/needs-you'), loadGoals()]);
  scopeTitle.textContent = 'Needs you';
  const byGoal = new Map();
  for (const q of needs.questions) { const e = byGoal.get(q.goalId) ?? { title: q.goalTitle, n: 0 }; e.n++; byGoal.set(q.goalId, e); }
  view.innerHTML = `
    ${needs.approvals.map(approvalCard).join('')}
    ${[...byGoal.entries()].map(([id, e]) => `<div class="ask">
      <div class="ask-head"><a href="#/goal/${encodeURIComponent(id)}">${esc(e.title)}</a></div>
      <div>${e.n} question${e.n === 1 ? '' : 's'} to answer.</div>
      <div class="actions"><a class="btn primary" href="#/goal/${encodeURIComponent(id)}">Answer</a></div></div>`).join('')}
    ${needs.count ? '' : '<p class="empty">Nothing waits on you. Workers carry on by themselves.</p>'}`;
  bindApprovals();
}

// ---------- new goal: composer ----------
async function renderNew(preProject) {
  const [projects] = await Promise.all([api('/api/projects'), loadGoals()]);
  scopeTitle.textContent = 'New goal';
  const pre = preProject && projects.some(p => p.id === preProject) ? preProject : '';
  view.innerHTML = `<div class="composer-wrap">
    <h2>What should be true when this is done?</h2>
    <div class="composer">
      <input id="title" placeholder="Short title" autocomplete="off" aria-label="Title">
      <textarea id="objective" placeholder="Describe the outcome. The worker asks before it changes anything you would notice." aria-label="Outcome"></textarea>
      <div class="composer-bar">
        <select id="project" aria-label="Project"><option value="">No project</option>
          ${projects.sort((a, b) => a.name.localeCompare(b.name)).map(p => `<option value="${esc(p.id)}" ${p.id === pre ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
        <label><input type="checkbox" id="start" checked> Start a worker</label>
        <button class="btn primary" id="create">Create goal</button>
      </div>
    </div>
    <p class="hint">The worker runs in the project's folder on the Mac.</p></div>`;
  document.getElementById('title').focus();
  document.getElementById('create').addEventListener('click', async e => {
    e.target.disabled = true;
    try {
      const out = await api('/api/goals', {
        title: document.getElementById('title').value, objective: document.getElementById('objective').value,
        projectId: document.getElementById('project').value || undefined, startWorker: document.getElementById('start').checked,
      });
      if (out.workerError) toast(`Goal created. The worker did not start: ${out.workerError}`, 'bad');
      else toast('Goal created');
      location.hash = `#/goal/${encodeURIComponent(out.goal.id)}`;
    } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
  });
}

// ---------- goal detail: header, what waits on you, contract, thread ----------
function threadItem(t) {
  const text = esc(t.text);
  if (t.kind === 'answer') return `<div class="msg me"><span class="who">You</span>${esc(t.text.replace(/^Answered: /, ''))}</div>`;
  if (t.kind === 'question') return `<div class="msg worker"><span class="who">Question</span>${esc(t.text.replace(/^Asked: /, ''))}</div>`;
  if (t.kind.startsWith('worker-')) {
    if (/assistant|text|message/.test(t.kind)) return `<div class="msg worker"><span class="who">Worker</span>${text}</div>`;
    return `<div class="event"><time>${esc(clock(t.ts))}</time>${text}</div>`;
  }
  const cls = t.kind === 'failure' || t.kind === 'verify-failed' ? 'bad' : t.kind === 'verified' ? 'ok' : '';
  const pre = t.kind === 'decision' ? 'Decided: ' : t.kind === 'verified' ? 'Verified: ' : t.kind === 'failure' ? 'Failed: ' : '';
  return `<div class="event ${cls}"><time>${esc(clock(t.ts))}</time>${esc(pre)}${text}</div>`;
}

function thread(items) {
  let lastDay = '';
  return items.map(t => {
    const d = dayOf(t.ts);
    const sep = d !== lastDay ? `<div class="day">${esc(d)}</div>` : '';
    lastDay = d;
    return sep + threadItem(t);
  }).join('');
}

async function renderGoal(id) {
  const [d, projects] = await Promise.all([api(`/api/goals/${encodeURIComponent(id)}`), api('/api/projects'), loadGoals()]);
  const g = d.goal;
  scopeTitle.textContent = d.project?.name ?? 'Unassigned';
  const run = d.runs[0];
  const active = run && ACTIVE_RUN.includes(run.status);
  const reqs = t => d.requirements.filter(r => r.requirementType === t);
  const evidence = r => d.verifications.filter(v => v.requirementId === r.id).slice(-1)
    .map(v => `<span class="evidence">${esc(v.actualResult)}</span>`).join('');
  const open = d.questions.filter(q => d.openQuestions.includes(q.id));
  const pending = d.approvals.filter(a => a.status === 'pending' && a.runId);
  const crit = reqs('success_criterion');
  const critCls = s => (s === 'PASSED' || s === 'NOT_APPLICABLE' ? 'crit-ok' : s === 'FAILED' ? 'crit-bad' : 'crit-wait');
  const critMark = s => (s === 'PASSED' ? '✓' : s === 'FAILED' ? '✕' : s === 'NOT_APPLICABLE' ? '–' : '○');
  const list = (title, rows, fmt) => (rows.length ? `<h3>${esc(title)}</h3><ul>${rows.map(r => `<li>${fmt(r)}</li>`).join('')}</ul>` : '');
  view.innerHTML = `
    <div class="goal-head">
      <h2>${esc(g.title)}</h2>
      <div class="facts">
        <span class="status s-${esc(g.status)}">${esc(STATUS_LABEL[g.status] ?? g.status)}</span>
        <select id="goal-project" aria-label="Project">
          <option value="">No project</option>
          ${projects.sort((a, b) => a.name.localeCompare(b.name)).map(p => `<option value="${esc(p.id)}" ${d.project?.id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
        ${run ? `<span>${esc(RUN_LABEL[run.status] ?? run.status)}${run.exitReason ? `: ${esc(run.exitReason)}` : ''}</span>` : ''}
        <span>${esc(g.id)}</span>
      </div>
      <div class="actions">
        ${!active && !TERMINAL.includes(g.status) ? `<button class="btn primary" data-worker="${run?.sessionId ? 'resume' : 'start'}">${run?.sessionId ? 'Resume worker' : 'Start worker'}</button>` : ''}
        ${active ? '<button class="btn danger" data-worker="stop">Stop worker</button>' : ''}
      </div>
    </div>
    ${pending.map(approvalCard).join('')}
    ${open.length ? `<div class="ask"><div class="ask-head"><strong>${open.length} question${open.length === 1 ? '' : 's'} for you</strong><span>Answer them together.</span></div>
      ${open.map(q => `<div data-q="${esc(q.id)}" style="margin:12px 0">
        <div style="margin-bottom:6px">${esc(q.question)}</div>
        <textarea class="field" data-answer placeholder="${q.recommended ? `Recommended: ${esc(q.recommended)}` : 'Your answer'}"></textarea>
        <div class="actions">
          <select class="field" style="width:auto" data-as aria-label="Record the answer as"><option value="">Record as an answer</option>
            ${['constraint', 'scope', 'success_criterion', 'exclusion', 'assumption', 'permission'].map(t => `<option value="${t}">Record as ${t.replace('_', ' ')}</option>`).join('')}
          </select>
          <input class="field grow" placeholder="Reason to dismiss" data-reason><button class="btn" data-dismiss>Dismiss</button>
        </div></div>`).join('')}
      <button class="btn primary" id="send-answers">Send answers</button></div>` : ''}
    <details class="contract">
      <summary>Contract${crit.length ? ` <span style="font-weight:400;color:var(--muted)">${crit.filter(r => r.status === 'PASSED').length} of ${crit.length} criteria met</span>` : ''}</summary>
      <div class="contract-body">
        <h3>Objective</h3><p style="margin:0">${esc(g.objective)}</p>
        ${list('Success criteria', crit, r => `<span class="${critCls(r.status)}">${critMark(r.status)}</span> ${esc(r.description)}${evidence(r)}`)}
        ${list('Scope', reqs('scope'), r => esc(r.description))}
        ${list('Constraints', reqs('constraint'), r => esc(r.description))}
        ${list('Exclusions', reqs('exclusion'), r => esc(r.description))}
        ${list('Unresolved failures', d.failures.filter(f => !f.resolved), f => esc(f.errorMessage))}
      </div>
    </details>
    <div class="thread" id="timeline">${thread(d.timeline) || '<p class="empty">Nothing has happened yet.</p>'}</div>`;

  document.getElementById('goal-project').addEventListener('change', async e => {
    try {
      const out = await api(`/api/goals/${encodeURIComponent(g.id)}/project`, { projectId: e.target.value || null });
      toast(out.project ? `Moved to ${out.project.name}` : 'Project removed');
      refresh();
    } catch (err) { toast(err.message, 'bad'); }
  });
  view.querySelectorAll('[data-worker]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await api(`/api/goals/${encodeURIComponent(g.id)}/worker`, { action: b.dataset.worker }); refresh(); }
    catch (e) { toast(e.message, 'bad'); b.disabled = false; }
  }));
  view.querySelectorAll('[data-dismiss]').forEach(b => b.addEventListener('click', async () => {
    const card = b.closest('[data-q]');
    try { await api(`/api/questions/${card.dataset.q}/dismiss`, { reason: card.querySelector('[data-reason]').value }); toast('Dismissed'); refresh(); }
    catch (e) { toast(e.message, 'bad'); }
  }));
  const send = document.getElementById('send-answers');
  send?.addEventListener('click', async () => {
    // Only cards not yet sent: a retry after a mid-batch failure never re-posts accepted answers.
    const cards = [...view.querySelectorAll('[data-q]:not([data-sent])')]
      .filter(card => card.querySelector('[data-answer]').value.trim());
    if (!cards.length) { toast('Type an answer first, or dismiss the question.', 'bad'); return; }
    send.disabled = true;
    try {
      for (const card of cards) {
        const box = card.querySelector('[data-answer]');
        await api(`/api/questions/${card.dataset.q}/answer`, { answer: box.value.trim(), as: card.querySelector('[data-as]').value || undefined });
        box.value = '';
        box.disabled = true;
        card.dataset.sent = '1';
      }
      toast('Answers sent');
      refresh();
    } catch (e) {
      toast(e.message, 'bad');
      const btn = document.getElementById('send-answers');
      if (btn) btn.disabled = false;
    }
  });
  bindApprovals();
  window.scrollTo({ top: document.body.scrollHeight });
}

// ---------- routing + live updates ----------
function route() {
  const h = location.hash || '#/';
  const goal = h.match(/^#\/goal\/(.+)$/);
  const proj = h.match(/^#\/p\/([^?]+)/);
  const nw = h.match(/^#\/new(?:\?project=(.+))?$/);
  if (goal) current = { ...current, page: 'goal', goalId: decodeURIComponent(goal[1]) };
  else if (nw) current = { ...current, page: 'new', goalId: null, newProject: nw[1] ? decodeURIComponent(nw[1]) : '' };
  else if (h === '#/needs') current = { ...current, page: 'needs', goalId: null };
  else current = { ...current, page: 'home', goalId: null, project: proj ? decodeURIComponent(proj[1]) : (sessionStorage.project || 'all') };
  if (current.page === 'home') sessionStorage.project = current.project;
  document.getElementById('stale').hidden = true;
  refresh();
}

function refresh() {
  document.getElementById('stale').hidden = true;
  const p = current.page === 'goal' ? renderGoal(current.goalId)
    : current.page === 'new' ? renderNew(current.newProject)
    : current.page === 'needs' ? renderNeeds() : renderHome();
  p.then(renderSidebar).catch(e => {
    view.innerHTML = `<p class="empty">${esc(e.message)}. <a href="#/">Back to goals</a></p>`;
  });
}

// True while the user has unsent input on the page — a reload would wipe it.
function hasDraft() {
  if (view.querySelector('input:focus, textarea:focus, select:focus')) return true;
  return [...view.querySelectorAll('[data-answer], [data-note], [data-reason], #title, #objective')].some(el => el.value.trim() !== '');
}

function markStale() { document.getElementById('stale').hidden = false; }

function scheduleReload() {
  if (current.page === 'new') return;              // never wipe a half-typed form
  if (hasDraft()) { markStale(); return; }
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    if (current.page === 'new') return;
    if (hasDraft()) { markStale(); return; }
    refresh();
  }, 300);
}

function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => { banner.hidden = true; };
  es.onerror = () => { banner.hidden = false; };
  es.addEventListener('needs-you', e => {
    const { count } = JSON.parse(e.data);
    needsCount = count;
    needsEl.hidden = !count;
    needsEl.textContent = `${count} need${count === 1 ? 's' : ''} you`;
    document.title = count ? `(${count}) Central Brain` : 'Central Brain';
    renderSidebar();
  });
  es.addEventListener('goal-changed', e => {
    const { goalId } = JSON.parse(e.data);
    if (current.page !== 'goal' || current.goalId === goalId) scheduleReload();
  });
  es.addEventListener('worker-event', e => {
    const { goalId, event } = JSON.parse(e.data);
    if (current.goalId !== goalId) return;
    const tl = document.getElementById('timeline');
    if (!tl) return;
    const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
    tl.insertAdjacentHTML('beforeend', threadItem({ ts: event.ts, kind: `worker-${event.kind}`, text: event.summary }));
    if (atBottom) window.scrollTo({ top: document.body.scrollHeight });
  });
  es.addEventListener('run-changed', e => {
    const { goalId } = JSON.parse(e.data);
    if (current.page !== 'goal' || current.goalId === goalId) scheduleReload();
  });
}

window.addEventListener('hashchange', route);
connect();
route();
