// SCALVS.ai agent runtime (Cloudflare Worker route, see worker.js).
// POST /api/run  { agent, task, context?, previous?, stream? }
//   stream=false -> { mode, model, output, usage }
//   stream=true  -> text/event-stream of {type:"text"|"done"|"error"} events
//
// Runs one agent step against the Claude Messages API when ANTHROPIC_API_KEY is
// set, otherwise against Workers AI through the Worker's AI binding. With
// neither it answers 503 { mode: "demo" } and the client falls back to its
// built-in simulated runner. Provider failures and empty responses are errors,
// never simulated successes.

import { hasWorkersAi, relayWorkersAiStream, resultText, workersAiModel } from './_workers-ai.js';

const apiUrl = () => `${(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const MAX_TASK_CHARS = 6000;
const TIMEOUT_MS = 45000;
const STREAM_TIMEOUT_MS = 120000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function clip(value, max) {
  return String(value ?? '').slice(0, max);
}

function combineSignals(...signals) {
  const list = signals.filter(Boolean);
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const controller = new AbortController();
  for (const s of list) {
    if (s.aborted) { controller.abort(s.reason); break; }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

export function buildSystemPrompt(agent = {}, context = []) {
  const tools = Array.isArray(agent.tools) && agent.tools.length
    ? agent.tools.map((t) => `- ${clip(t, 60)}`).join('\n')
    : '- none';
  const memory = Array.isArray(context) && context.length
    ? context.map((m) => `- ${clip(m, 400)}`).join('\n')
    : '- (no shared context)';

  return [
    `You are "${clip(agent.name || 'Agent', 80)}", an AI agent running on SCALVS.ai, Infinitum's AI workforce platform.`,
    `Role: ${clip(agent.role || 'General assistant', 200)}.`,
    agent.instructions ? `Operator instructions:\n${clip(agent.instructions, 2000)}` : '',
    `Connected tools (simulated in this prototype; describe what you would do with them, never claim an action already happened outside this answer):\n${tools}`,
    `Context from the Nexus Context Vault (shared with permission):\n${memory}`,
    'Work style: start with a one-line plan, then deliver the finished work product. Be concrete and concise. Use short markdown headings and lists where helpful. If a step would need human approval (sending messages, spending money, publishing), stop and say what you would send for approval.',
  ].filter(Boolean).join('\n\n');
}

export async function POST(request, env) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key && !hasWorkersAi(env)) return json({ mode: 'demo', error: 'No model is configured' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const task = clip(body?.task, MAX_TASK_CHARS).trim();
  if (!task) return json({ error: 'Missing task' }, 400);

  const userContent = body.previous
    ? `Task:\n${task}\n\nOutput from the previous agent in this team, to build on:\n${clip(body.previous, 8000)}`
    : task;

  const stream = body.stream === true;

  if (!key) return runWorkersAi(env, buildSystemPrompt(body.agent, body.context), userContent, stream);

  try {
    const upstream = await fetch(apiUrl(), {
      method: 'POST',
      signal: combineSignals(request.signal, AbortSignal.timeout(stream ? STREAM_TIMEOUT_MS : TIMEOUT_MS)),
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.SCALVS_MODEL || DEFAULT_MODEL,
        max_tokens: 1500,
        stream,
        system: buildSystemPrompt(body.agent, body.context),
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!upstream.ok) {
      return json({ error: `Model request failed (${upstream.status}). Please retry.` }, 502);
    }

    if (stream) return relayStream(upstream);

    const data = await upstream.json();
    const output = (Array.isArray(data.content) ? data.content : [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (!output) return json({ error: 'The model returned no text. Please retry.' }, 502);
    return json({ mode: 'live', model: data.model, output, usage: data.usage || null });
  } catch {
    return json({ error: 'The model request could not complete. Please retry.' }, 502);
  }
}

// Re-emit Anthropic's SSE stream as a minimal one for the client:
//   data: {"type":"text","text":"..."}             (repeated)
//   data: {"type":"done","model":..,"usage":{..}}   once, only after message_stop with text
//   data: {"type":"error","error":"..."}            terminal; no "done" follows
export function relayStream(upstream) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const send = (controller, obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

  const body = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      let buffer = '';
      let model = null;
      let sawText = false;
      let stopped = false;
      let failed = null;
      const usage = {};

      const handle = (data) => {
        if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta' && typeof data.delta.text === 'string') {
          if (data.delta.text.trim()) sawText = true;
          send(controller, { type: 'text', text: data.delta.text });
        } else if (data.type === 'message_start') {
          model = data.message?.model || null;
          Object.assign(usage, data.message?.usage || {});
        } else if (data.type === 'message_delta') {
          Object.assign(usage, data.usage || {});
        } else if (data.type === 'message_stop') {
          stopped = true;
        } else if (data.type === 'error') {
          failed = 'The model stream failed. Please retry.';
        }
      };

      try {
        while (!failed && !stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let cut;
          while (!failed && !stopped && (cut = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const line = event.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            let data;
            try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }
            handle(data);
          }
        }
        if (!failed && !stopped) failed = 'The model stream ended early. Please retry.';
        if (!failed && !sawText) failed = 'The model returned no text. Please retry.';
      } catch {
        failed = 'The model stream was interrupted. Please retry.';
      }

      reader.cancel().catch(() => {});
      try {
        send(controller, failed ? { type: 'error', error: failed } : { type: 'done', model, usage });
        controller.close();
      } catch { /* client already disconnected */ }
    },
    cancel() { upstream.body.cancel().catch(() => {}); },
  });

  return new Response(body, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
  });
}

async function runWorkersAi(env, system, user, stream) {
  const model = workersAiModel();
  try {
    const result = await env.AI.run(model, {
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 1500,
      stream,
    });
    if (stream) return relayWorkersAiStream(result, model);
    const output = resultText(result).trim();
    if (!output) return json({ error: 'The model returned no text. Please retry.' }, 502);
    return json({ mode: 'live', model, output, usage: result?.usage || null });
  } catch {
    return json({ error: 'The model request could not complete. Please retry.' }, 502);
  }
}

export function GET(_request, env) {
  return json({ ok: true, live: Boolean(process.env.ANTHROPIC_API_KEY) || hasWorkersAi(env) });
}
