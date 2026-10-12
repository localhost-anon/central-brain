// Small markdown renderer for thread messages. Safe by construction: every piece of input text is
// HTML-escaped before it reaches the output, and only the tags built here are emitted.
// Supports **bold**, *italic*/_italic_, `code`, ``` fences, - / 1. lists, # headings (bold lines),
// [links](url) and bare URLs. Links are live only for http, https and mailto. Pipe tables stay monospace.

export function escHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;
// Placeholders hold finished HTML while the rest of a line is escaped; \u0000 is stripped from input first.
const PH = /\u0000(\d+)\u0000/g;

function link(label, url) {
  return `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

// Bold and italic on already-escaped text. Markers must hug non-space text, so a lone * or ** stays literal.
function emphasis(s) {
  return s
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
}

export function renderInline(text) {
  const held = [];
  const hold = html => `\u0000${held.push(html) - 1}\u0000`;
  let s = String(text ?? '').replace(/\u0000/g, '');
  s = s.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${escHtml(code)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) =>
    (SAFE_URL.test(url) ? hold(link(emphasis(escHtml(label)), url)) : m));
  s = s.replace(/\bhttps?:\/\/[^\s<>()]*[^\s<>().,;:!?'"]/g, url => hold(link(escHtml(url), url)));
  s = emphasis(escHtml(s));
  return s.replace(PH, (_, i) => held[Number(i)]);
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/;
const TABLE = /^\s*\|.*\|\s*$/;

export function renderMarkdown(text) {
  const lines = String(text ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(renderInline).join('<br>')}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(FENCE);
    if (fence) {
      flush();
      const body = [];
      // An unclosed fence runs to the end of the message, so no text is lost.
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      out.push(`<pre><code>${escHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (TABLE.test(line)) {
      flush();
      const rows = [];
      for (; i < lines.length && TABLE.test(lines[i]); i++) rows.push(lines[i]);
      i--;
      out.push(`<pre class="md-table">${escHtml(rows.join('\n'))}</pre>`);
      continue;
    }
    const list = BULLET.test(line) ? BULLET : NUMBERED.test(line) ? NUMBERED : null;
    if (list) {
      flush();
      const items = [];
      let start = null;
      for (; i < lines.length && list.test(lines[i]); i++) {
        const m = lines[i].match(list);
        if (list === NUMBERED) { start ??= Number(m[1]); items.push(m[2]); } else items.push(m[1]);
      }
      i--;
      const lis = items.map(t => `<li>${renderInline(t)}</li>`).join('');
      out.push(list === BULLET ? `<ul>${lis}</ul>` : `<ol${start && start !== 1 ? ` start="${start}"` : ''}>${lis}</ol>`);
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      flush();
      out.push(`<p class="md-h"><strong>${renderInline(heading[1])}</strong></p>`);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    para.push(line);
  }
  flush();
  return out.join('');
}
