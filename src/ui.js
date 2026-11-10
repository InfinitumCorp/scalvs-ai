// Rendering helpers.

export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const fmt = (n, d = 0) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Minimal, safe markdown: escapes first, then formats.
export function md(src) {
  const lines = esc(src).split('\n');
  const out = [];
  let list = null;
  let code = false;
  let codeBuf = [];
  // Links: [text](https://…) and bare https URLs. Pulled out first so * and _ inside
  // URLs are not formatted, then restored. Only http(s); they open outside the app
  // (new tab, or the system browser from an installed app) so phone apps never get
  // stuck on another site with no way back.
  const inline = (t) => {
    const links = [];
    const a = (href, text) => {
      links.push(`<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`);
      return `\u0000${links.length - 1}\u0000`;
    };
    return t
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, href) => a(href, text))
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_, pre, href) => pre + a(href, href))
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|\s)_([^_]+)_(?=\s|$|[.,])/g, '$1<em>$2</em>')
      .replace(/\u0000(\d+)\u0000/g, (_, i) => links[Number(i)]);
  };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (code) { out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`); codeBuf = []; code = false; }
      else { closeList(); code = true; }
      continue;
    }
    if (code) { codeBuf.push(line); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${Math.min(h[1].length + 2, 6)}>${inline(h[2])}</h${Math.min(h[1].length + 2, 6)}>`); }
    else if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(ul[1])}</li>`); }
    else if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(ol[1])}</li>`); }
    else if (!line.trim()) { closeList(); }
    else { closeList(); out.push(`<p>${inline(line)}</p>`); }
  }
  if (code) out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`);
  closeList();
  return out.join('');
}

export const statusLabel = {
  queued: 'Queued', running: 'Running', awaiting_approval: 'Needs approval',
  done: 'Done', completed: 'Completed', failed: 'Failed', rejected: 'Rejected', stopped: 'Stopped',
};

export function toast(message) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2600);
}
