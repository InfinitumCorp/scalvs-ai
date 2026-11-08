// Workers AI backend for SCALVS.ai. Used when no ANTHROPIC_API_KEY is set but the
// Worker has an AI binding (wrangler.jsonc "ai"), so the app runs live on the
// Cloudflare account without anyone handling a provider key.

export const DEFAULT_WORKERS_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export const workersAiModel = () => process.env.WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL;

export const hasWorkersAi = (env) => Boolean(env?.AI && typeof env.AI.run === 'function');

// Text out of a non-streaming Workers AI result (legacy {response} or OpenAI-style choices).
export function resultText(result) {
  if (typeof result === 'string') return result;
  if (typeof result?.response === 'string') return result.response;
  if (result?.response && typeof result.response === 'object') return JSON.stringify(result.response);
  const choice = result?.choices?.[0];
  return choice?.message?.content ?? choice?.text ?? '';
}

// A CONJURE `Complete` backed by Workers AI.
export function workersAiComplete(env, model = workersAiModel()) {
  return async (system, user, opts = {}) => {
    const result = await env.AI.run(model, {
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: opts.maxTokens ?? 2000,
    });
    const text = resultText(result).trim();
    if (!text) throw new Error('The model returned no text.');
    return text;
  };
}

// Token text from one Workers AI stream event (legacy {response} or OpenAI-style delta).
function deltaText(data) {
  if (typeof data?.response === 'string') return data.response;
  const choice = data?.choices?.[0];
  return choice?.delta?.content ?? choice?.text ?? '';
}

// Re-emit a Workers AI SSE stream in the client's minimal format (same as relayStream in run.js):
//   data: {"type":"text","text":"..."} ... then {"type":"done",...} or a terminal {"type":"error",...}
export function relayWorkersAiStream(stream, model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const send = (controller, obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
  const body = new ReadableStream({
    async start(controller) {
      const reader = stream.getReader();
      let buffer = '';
      let sawText = false;
      let finished = false;
      let failed = null;
      let usage = null;
      try {
        while (!finished) {
          const { value, done } = await reader.read();
          if (done) { finished = true; break; }
          buffer += (typeof value === 'string' ? value : decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
          let cut;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const line = buffer.slice(0, cut).split('\n').find((l) => l.startsWith('data:'));
            buffer = buffer.slice(cut + 2);
            if (!line) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') { finished = true; break; }
            let data;
            try { data = JSON.parse(payload); } catch { continue; }
            if (data.usage) usage = data.usage;
            const text = deltaText(data);
            if (text) {
              if (text.trim()) sawText = true;
              send(controller, { type: 'text', text });
            }
          }
        }
        if (!sawText) failed = 'The model returned no text. Please retry.';
      } catch {
        failed = 'The model stream was interrupted. Please retry.';
      }
      reader.cancel().catch(() => {});
      try {
        send(controller, failed ? { type: 'error', error: failed } : { type: 'done', model, usage });
        controller.close();
      } catch { /* client already disconnected */ }
    },
    cancel() { stream.cancel?.().catch?.(() => {}); },
  });
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
  });
}
