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
export function relayOpenWeightsStream(upstream, model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const send = (controller, obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
  return new ReadableStream({
    async start(controller) {
      let buffer = '';
      let sawText = false;
      const finish = (extra = {}) => send(controller, { type: 'done', model, ...extra });
      try {
        const reader = upstream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') {
              if (sawText) finish();
              controller.close();
              return;
            }
            let data;
            try { data = JSON.parse(payload); } catch { continue; }
            const delta = data?.choices?.[0]?.delta?.content ?? data?.choices?.[0]?.text ?? '';
            const text = stripThink(delta);
            if (text) {
              sawText = true;
              send(controller, { type: 'text', text });
            }
          }
        }
        if (sawText) finish();
        else send(controller, { type: 'error', message: 'The model returned no text.' });
        controller.close();
      } catch (err) {
        send(controller, { type: 'error', message: 'The model request could not complete. Please retry.' });
        controller.close();
      }
    },
  });
}
