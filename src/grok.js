// Grok-style composer extras: modes (Think, DeepSearch, Browse, Imagine),
// personalities, attachments (images + text files), voice input, private chats,
// read aloud, share links and "Automate" (run this task on a schedule).

import { getState } from './store.js';
import { esc, toast } from './ui.js';

export const MODES = [
  { id: 'auto', label: 'Auto', hint: 'Fast answer' },
  { id: 'think', label: 'Think', hint: 'Reasons step by step before answering' },
  { id: 'deepsearch', label: 'DeepSearch', hint: 'Searches the web and cites sources' },
  { id: 'browse', label: 'Browse', hint: 'Controls a real browser to get things done' },
  { id: 'imagine', label: 'Imagine', hint: 'Generates an image' },
];
export const PERSONALITIES = [
  { id: '', label: 'Default' }, { id: 'concise', label: 'Concise' }, { id: 'fun', label: 'Fun' },
  { id: 'mentor', label: 'Mentor' }, { id: 'expert', label: 'Expert' }, { id: 'coach', label: 'Coach' },
];

const state = { mode: 'auto', personality: '', private: false, images: [], files: [], listening: false };
export const attachState = state;

const ICON = {
  clip: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5 5 0 01-7.1-7.1l8.6-8.6a3.3 3.3 0 014.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.4-2.4l7.9-7.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  mic: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 11a7 7 0 0014 0M12 18v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 11V8a4 4 0 018 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
};

const Speech = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
// Hide the mic when the site's Permissions-Policy blocks the microphone.
const micAllowed = () => {
  try { return document.featurePolicy ? document.featurePolicy.allowsFeature('microphone') : true; } catch { return true; }
};

export function composerExtras(where) {
  if (where === 'top') {
    const chips = [
      ...state.images.map((img, i) => `<span class="attach-chip"><img src="${img}" alt="">Image ${i + 1}<button type="button" data-x="img" data-i="${i}" aria-label="Remove image ${i + 1}">×</button></span>`),
      ...state.files.map((f, i) => `<span class="attach-chip">${esc(f.name)}<button type="button" data-x="file" data-i="${i}" aria-label="Remove ${esc(f.name)}">×</button></span>`),
    ];
    return chips.length ? `<div class="attach-row">${chips.join('')}</div>` : '';
  }
  return `
    <select name="mode" class="pill-select" aria-label="Mode" title="${esc(MODES.find((m) => m.id === state.mode)?.hint || '')}">
      ${MODES.map((m) => `<option value="${m.id}" ${m.id === state.mode ? 'selected' : ''}>${m.label}</option>`).join('')}
    </select>
    <select name="personality" class="pill-select" aria-label="Personality">
      ${PERSONALITIES.map((p) => `<option value="${p.id}" ${p.id === state.personality ? 'selected' : ''}>${p.label}</option>`).join('')}
    </select>
    <label class="icon-btn" title="Attach images or text files" aria-label="Attach files">${ICON.clip}
      <input type="file" name="attach" multiple accept="image/*,.txt,.md,.csv,.json,.html,.js,.ts,.py,.xml,.yaml,.yml,.log" hidden>
    </label>
    ${Speech && micAllowed() ? `<button type="button" class="icon-btn${state.listening ? ' on' : ''}" data-x="mic" aria-pressed="${state.listening}" aria-label="${state.listening ? 'Stop voice input' : 'Speak your task'}" title="Voice input">${ICON.mic}</button>` : ''}
    <button type="button" class="icon-btn${state.private ? ' on' : ''}" data-x="private" aria-pressed="${state.private}" aria-label="Private chat" title="Private chat: not saved, can't be shared">${ICON.lock}</button>`;
}

// Images are downscaled to at most 1280px JPEG before upload. Read as a data: URL
// (the site's CSP allows img-src data: but not blob:).
function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Unreadable image'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => reject(new Error('Unreadable image'));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

let recognizer = null;

export function bindExtras(root, rerender, setText) {
  root.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.name === 'mode') { state.mode = t.value; rerender(); }
    else if (t.name === 'personality') state.personality = t.value;
    else if (t.name === 'attach') {
      for (const file of [...t.files].slice(0, 6)) {
        try {
          if (file.type.startsWith('image/')) {
            if (state.images.length >= 4) { toast('Up to 4 images'); continue; }
            state.images.push(await readImage(file));
          } else {
            if (file.size > 400_000) { toast(`${file.name} is too large (400 KB max)`); continue; }
            if (state.files.length >= 5) { toast('Up to 5 files'); continue; }
            state.files.push({ name: file.name.slice(0, 120), text: await file.text() });
          }
        } catch { toast(`Could not read ${file.name}`); }
      }
      rerender();
    }
  });
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-x]');
    if (!el) return;
    const x = el.dataset.x;
    if (x === 'img') { state.images.splice(Number(el.dataset.i), 1); rerender(); }
    else if (x === 'file') { state.files.splice(Number(el.dataset.i), 1); rerender(); }
    else if (x === 'private') { state.private = !state.private; toast(state.private ? 'Private chat on' : 'Private chat off'); rerender(); }
    else if (x === 'mic') toggleMic(rerender, setText);
  });
}

function toggleMic(rerender, setText) {
  if (state.listening) { recognizer?.stop(); return; }
  recognizer = new Speech();
  recognizer.lang = navigator.language || 'en-US';
  recognizer.interimResults = true;
  recognizer.continuous = false;
  const base = (document.querySelector('textarea[name=task]')?.value || '').trim();
  recognizer.onresult = (ev) => {
    const said = [...ev.results].map((r) => r[0].transcript).join('');
    setText(base ? `${base} ${said}` : said);
  };
  recognizer.onerror = (ev) => toast(ev.error === 'not-allowed' ? 'Microphone permission denied' : 'Voice input stopped');
  recognizer.onend = () => { state.listening = false; rerender(); };
  state.listening = true;
  recognizer.start();
  rerender();
}

// Consumes the composer's attachments and settings for a new run.
export function takeAttachments() {
  const opts = { mode: state.mode, personality: state.personality, private: state.private, images: state.images, files: state.files };
  state.images = [];
  state.files = [];
  return opts;
}

export function speak(text) {
  if (!('speechSynthesis' in window)) { toast('Read aloud is not supported in this browser'); return; }
  if (speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
  const plain = text.replace(/```[\s\S]*?```/g, ' code block ').replace(/[*_#>`|[\]]/g, '').replace(/\(https?:[^)]+\)/g, '');
  speechSynthesis.speak(new SpeechSynthesisUtterance(plain.slice(0, 8000)));
}

export async function shareRun(run) {
  if (run.private) { toast('Private chats cannot be shared'); return; }
  try {
    const res = await fetch('api/share', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: run.title, task: run.task, steps: run.steps.filter((s) => s.output).map((s) => ({ name: s.name, output: s.output })) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Share failed');
    const link = `${location.origin}${location.pathname}#/shared?id=${data.id}`;
    await navigator.clipboard?.writeText(link).catch(() => {});
    toast('Share link copied');
    window.prompt('Anyone with this link can read this chat:', link);
  } catch (e) { toast(e.message || 'Share failed'); }
}

export async function createAutomation(run) {
  const every = window.prompt('Run this task automatically: type hour, day or week', 'day');
  if (!every) return;
  const when = every.trim().toLowerCase();
  if (!['hour', 'day', 'week'].includes(when)) { toast('Type hour, day or week'); return; }
  const agent = getState().agents.find((a) => a.id === run.steps[0]?.agentId) || {};
  try {
    const res = await fetch('api/automations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: run.task.slice(0, 80), task: run.task, every: when, hour: new Date().getUTCHours(), mode: run.kind === 'imagine' ? 'auto' : run.kind || 'auto', agent: { name: agent.name, role: agent.role, instructions: agent.instructions } }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not create the automation');
    toast('Automation created');
    location.hash = '#/automations';
  } catch (e) { toast(e.message); }
}
