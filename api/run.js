// SCALVS.ai agent runtime — Vercel serverless function.
// POST /api/run  { agent, task, context?, previous? }  ->  { mode, output, usage }
//
// Runs one agent step against the Claude Messages API using ANTHROPIC_API_KEY.
// When no key is configured it answers 503 { mode: "demo" } and the client
// falls back to its built-in simulated runner, so the prototype still works.

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const MAX_TASK_CHARS = 6000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function clip(value, max) {
  return String(value ?? '').slice(0, max);
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

export async function POST(request) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ mode: 'demo', error: 'ANTHROPIC_API_KEY is not configured' }, 503);

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

  const upstream = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.SCALVS_MODEL || DEFAULT_MODEL,
      max_tokens: 1500,
      system: buildSystemPrompt(body.agent, body.context),
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    return json({ error: `Model request failed (${upstream.status})`, detail: clip(detail, 500) }, 502);
  }

  const data = await upstream.json();
  const output = (data.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  return json({ mode: 'live', model: data.model, output, usage: data.usage || null });
}

export function GET() {
  return json({ ok: true, live: Boolean(process.env.ANTHROPIC_API_KEY) });
}
