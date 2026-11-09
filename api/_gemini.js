// Google AI Studio Gemini (API key, free tier). This is not Vertex AI:
// requests go to generativelanguage.googleapis.com unless GEMINI_BASE_URL
// points at another HTTPS host. Vertex hosts are refused.

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export const hasGemini = () => Boolean(process.env.GEMINI_API_KEY);

export function geminiModel() {
  const raw = String(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim().replace(/^models\//, '');
  return /^[A-Za-z0-9._-]{1,80}$/.test(raw) ? raw : DEFAULT_GEMINI_MODEL;
}

function allowedBase(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  const host = url.hostname.toLowerCase();
  // Regional Vertex hosts look like us-central1-aiplatform.googleapis.com.
  if (/(^|[-.])aiplatform\.googleapis\.com$/.test(host) || host.includes('vertex')) return null;
  return url.origin;
}

// Absolute URL for generateContent or streamGenerateContent. Null when the
// base URL is not an allowed Google AI Studio (or non-Vertex gateway) host.
export function geminiEndpoint(stream) {
  const base = allowedBase(process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com');
  if (!base) return null;
  const action = stream ? 'streamGenerateContent' : 'generateContent';
  const query = stream ? '?alt=sse' : '';
  return `${base}/v1beta/models/${encodeURIComponent(geminiModel())}:${action}${query}`;
}

export function geminiRequestBody(system, user) {
  const model = geminiModel();
  const generationConfig = { maxOutputTokens: 1500 };
  // 2.5 Flash spends the output budget on thoughts unless thinking is off.
  if (/2\.5|gemini-3/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig,
  };
}

export function geminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part) => part && typeof part.text === 'string' && part.thought !== true)
    .map((part) => part.text)
    .join('');
}

export function geminiUsage(data) {
  const usage = data?.usageMetadata;
  if (!usage || typeof usage !== 'object') return null;
  return {
    input_tokens: Number.isFinite(usage.promptTokenCount) ? usage.promptTokenCount : null,
    output_tokens: Number.isFinite(usage.candidatesTokenCount) ? usage.candidatesTokenCount : null,
  };
}

function deltaText(data) {
  return geminiText(data);
}

// Re-emit a Gemini SSE stream in the client's minimal format.
export function relayGeminiStream(upstream, model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const send = (controller, obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
  const body = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      let buffer = '';
      let sawText = false;
      let failed = null;
      let usage = null;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let cut;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const line = buffer.slice(0, cut).split('\n').find((l) => l.startsWith('data:'));
            buffer = buffer.slice(cut + 2);
            if (!line) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let data;
            try { data = JSON.parse(payload); } catch { continue; }
            if (data.error) { failed = 'The model stream failed. Please retry.'; break; }
            if (data.usageMetadata) usage = geminiUsage(data);
            const text = deltaText(data);
            if (text) {
              if (text.trim()) sawText = true;
              send(controller, { type: 'text', text });
            }
          }
          if (failed) break;
        }
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
    cancel() { upstream.body?.cancel?.().catch?.(() => {}); },
  });
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
  });
}
