// Keyless open-weight models for SCALVS.ai: any OpenAI-compatible server the
// operator runs — Ollama (default), llama.cpp, vLLM, LM Studio, or an internal
// gateway. Used when no ANTHROPIC_API_KEY and no Workers AI binding exist, so
// the app still runs live with zero provider keys. No UI changes: this is a
// drop-in third tier behind Claude and Workers AI, same shapes as _workers-ai.js.

export const DEFAULT_OPEN_WEIGHTS_MODEL = 'qwen3:8b';

export const openWeightsBaseUrl = () => (process.env.OPEN_WEIGHTS_URL || 'http://localhost:11434/v1').replace(/\/+$/, '');
export const openWeightsModel = () => process.env.OPEN_WEIGHTS_MODEL || DEFAULT_OPEN_WEIGHTS_MODEL;

// A key is never required (Ollama ignores it); set OPEN_WEIGHTS_KEY only for gateways that insist.
export const hasOpenWeights = () => Boolean(process.env.OPEN_WEIGHTS_URL || process.env.OPEN_WEIGHTS_MODEL);
export const openWeightsHeaders = () => {
  const key = process.env.OPEN_WEIGHTS_KEY;
  return { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
};

// Some servers inline the model's thinking; SCALVS only wants the answer.
export const stripThink = (text) => String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();

// Text out of a non-streaming OpenAI-style result.
export function openWeightsResultText(result) {
  const choice = result?.choices?.[0];
  return stripThink(choice?.message?.content ?? choice?.text ?? '');
}

// One OpenAI-style request body for /chat/completions.
export function openWeightsBody(model, messages, opts = {}) {
  return {
    model: model || openWeightsModel(),
    max_tokens: opts.maxTokens ?? 2000,
    messages,
    ...(opts.images?.length ? { /* vision pass-through handled by callers today via Workers AI */ } : {}),
  };
}

// A non-streamed answer: POST /chat/completions -> { model, output }.
export async function openWeightsComplete(env, model = openWeightsModel(), opts = {}) {
  const res = await fetch(`${openWeightsBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: openWeightsHeaders(),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120000),
    body: JSON.stringify(openWeightsBody(model, opts.messages ?? [], opts)),
  });
  if (!res.ok) throw new Error(`Open-weight model server error ${res.status}`);
  const data = await res.json();
  const output = openWeightsResultText(data);
  if (!output) throw new Error('The model returned no text.');
  return { model, output };
}

// Re-emit an OpenAI SSE stream in the client's minimal format (same contract as
// relayStream in run.js and relayWorkersAiStream in _workers-ai.js):
//   data: {"type":"text","text":"..."} ... then {"type":"done",...} or {"type":"error",...}
// Keep partial reasoning delimiters between deltas, preserving answer whitespace.
function reasoningFilter() {
  let pending = '';
  let thinking = false;
  return (chunk, final = false) => {
    pending += chunk;
    let answer = '';
    for (;;) {
      const tag = thinking ? '</think>' : '<think>';
      const at = pending.indexOf(tag);
      if (at >= 0) {
        if (!thinking) answer += pending.slice(0, at);
        pending = pending.slice(at + tag.length);
        thinking = !thinking;
        continue;
      }
      let hold = 0;
      if (!final) {
        for (let size = 1; size < tag.length; size++) {
          if (pending.endsWith(tag.slice(0, size))) hold = size;
        }
      }
      if (!thinking) answer += pending.slice(0, pending.length - hold);
      pending = hold ? pending.slice(-hold) : '';
      return answer;
    }
  };
}

export function relayOpenWeightsStream(upstream, model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = upstream.getReader();
  let cancelled = false;
  const send = (controller, obj) => {
    if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
  };
  return new ReadableStream({
    async start(controller) {
      let buffer = '';
      let sawText = false;
      let terminal = false;
      let usage = null;
      const filter = reasoningFilter();
      const emit = text => {
        if (!text) return;
        if (text.trim()) sawText = true;
        send(controller, { type: 'text', text });
      };
      const event = block => {
        const payload = block.split('\n').filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n').trim();
        if (!payload) return;
        if (payload === '[DONE]') { terminal = true; return; }
        const data = JSON.parse(payload);
        if (data.error) throw new Error('Upstream model error');
        if (data.usage) usage = data.usage;
        const choice = data.choices?.[0];
        const delta = choice?.delta?.content ?? choice?.text ?? '';
        if (typeof delta === 'string') emit(filter(delta));
      };
      try {
        while (!terminal && !cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // Normalize after concatenation so CRLF may straddle network chunks.
          buffer = buffer.replace(/\r\n/g, '\n');
          if (buffer.length > 1024 * 1024) throw new Error('Oversized stream event');
          let cut;
          while (!terminal && (cut = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            event(block);
          }
        }
        if (cancelled) return;
        if (!terminal) throw new Error('Interrupted stream');
        emit(filter('', true));
        send(controller, sawText
          ? { type: 'done', model, usage }
          : { type: 'error', error: 'The model returned no text. Please retry.' });
      } catch {
        send(controller, { type: 'error', error: 'The model stream was interrupted. Please retry.' });
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        if (!cancelled) controller.close();
      }
    },
    async cancel(reason) {
      cancelled = true;
      await reader.cancel(reason).catch(() => {});
    },
  });
}
