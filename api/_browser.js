// Browser control for SCALVS agents: a real headless Chrome through Cloudflare
// Browser Rendering (wrangler.jsonc "browser" binding BROWSER). One browser per
// agent run; every call returns what the page shows now plus a screenshot.
// Public https sites only (checkUrl). Never types passwords or payment details:
// the agent is told so, and fields of type password are refused here.

import puppeteer from '@cloudflare/puppeteer';
import { checkUrl } from './_vault.js';

export const hasBrowser = (env) => Boolean(env?.BROWSER);

// Every browser call is bounded, so a stuck session fails fast instead of hanging the run.
const within = (ms, what, p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

const DESCRIPTION = 'Control a real web browser. Opens a page (url), optionally performs steps on it in order '
  + '(click a CSS selector or visible text, type text into a field, press a key, scroll, wait), then returns the page title, URL, '
  + 'visible text, links and form fields, and takes a screenshot the user sees. Call it again without url to keep working on the same page. '
  + 'Never enter passwords, payment or identity details; never submit purchases, posts or messages: stop and ask the user instead.';

const SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'https URL to open. Omit to continue on the current page.' },
    steps: {
      type: 'array',
      description: 'Actions to perform in order.',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['click', 'type', 'press', 'scroll', 'wait'] },
          selector: { type: 'string', description: 'CSS selector, or text=Visible label for click' },
          text: { type: 'string', description: 'Text to type, or key name for press (e.g. Enter)' },
        },
        required: ['action'],
      },
    },
  },
};

async function snapshot(page) {
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 5000);
    const links = [...document.querySelectorAll('a[href]')].filter(vis).slice(0, 25)
      .map((a) => `${(a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 60)} -> ${a.href}`);
    const fields = [...document.querySelectorAll('input,textarea,select,button')].filter(vis).slice(0, 25).map((el) => {
      const id = el.id ? `#${el.id}` : el.name ? `${el.tagName.toLowerCase()}[name="${el.name}"]` : el.tagName.toLowerCase();
      const label = el.getAttribute('aria-label') || el.placeholder || el.innerText || el.value || '';
      return `${id} (${el.type || el.tagName.toLowerCase()}) ${String(label).trim().slice(0, 50)}`;
    });
    return { title: document.title, url: location.href, text, links, fields };
  });
}

async function step(page, s) {
  const sel = String(s.selector || '');
  if (s.action === 'click') {
    if (sel.startsWith('text=')) {
      const label = sel.slice(5).trim();
      const ok = await page.evaluate((t) => {
        const el = [...document.querySelectorAll('a,button,[role=button],input[type=submit],label,summary')]
          .find((e) => (e.innerText || e.value || '').trim().toLowerCase().includes(t.toLowerCase()));
        if (el) { el.click(); return true; }
        return false;
      }, label);
      if (!ok) throw new Error(`No clickable element with text "${label}"`);
    } else {
      await page.click(sel);
    }
    await page.waitForNetworkIdle({ idleTime: 400, timeout: 5000 }).catch(() => {});
  } else if (s.action === 'type') {
    const type = await page.$eval(sel, (el) => el.type || '').catch(() => { throw new Error(`No field ${sel}`); });
    if (/password/i.test(type)) throw new Error('Refused: the agent never types into password fields. Ask the user to do it.');
    await page.type(sel, String(s.text || ''), { delay: 10 });
  } else if (s.action === 'press') {
    await page.keyboard.press(String(s.text || 'Enter'));
    await page.waitForNetworkIdle({ idleTime: 400, timeout: 5000 }).catch(() => {});
  } else if (s.action === 'scroll') {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
  } else if (s.action === 'wait') {
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// Returns { tool, close, shots } for the tool loop. shots collects screenshots (data URLs).
export function browserTool(env) {
  let browser = null;
  let page = null;
  const shots = [];
  const tool = {
    name: 'browser',
    label: 'Browser · browse',
    description: DESCRIPTION,
    inputSchema: SCHEMA,
    run: (args = {}) => within(60000, 'The browser step', go(args)),
  };
  let dead = null; // once the browser fails to start, later calls fail at once
  async function go(args) {
      if (dead) throw new Error(`The browser is unavailable (${dead}). Use web_search instead.`);
      if (!browser) {
        try {
          browser = await within(20000, 'Starting the browser', puppeteer.launch(env.BROWSER, { keep_alive: 60000 }));
        } catch (e) { dead = e.message; throw e; }
        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
      }
      if (args.url) {
        checkUrl(args.url, env);
        await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } else if (page.url() === 'about:blank') {
        throw new Error('Open a page first: pass url.');
      }
      const log = [];
      for (const s of (Array.isArray(args.steps) ? args.steps : []).slice(0, 10)) {
        try { await step(page, s); log.push(`ok: ${s.action} ${s.selector || s.text || ''}`); } catch (e) { log.push(`failed: ${s.action} ${s.selector || ''}: ${e.message}`); break; }
      }
      checkUrl(page.url(), env); // a redirect to a private address ends the session
      const snap = await snapshot(page);
      const img = await page.screenshot({ type: 'jpeg', quality: 55 });
      shots.push({ url: snap.url, title: snap.title, image: `data:image/jpeg;base64,${Buffer.from(img).toString('base64')}` });
      return [
        `Page: ${snap.title} (${snap.url})`,
        log.length ? `Steps:\n${log.join('\n')}` : '',
        `Visible text:\n${snap.text}`,
        `Links:\n${snap.links.join('\n')}`,
        `Fields and buttons:\n${snap.fields.join('\n')}`,
      ].filter(Boolean).join('\n\n');
  }
  return { tool, shots, close: async () => { try { await within(5000, 'Closing', browser?.close()); } catch { /* already closed */ } } };
}
