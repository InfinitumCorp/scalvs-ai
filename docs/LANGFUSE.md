# Langfuse tracing

`api/_ai-langfuse.mjs` (zero dependencies) wraps the Workers AI binding in `worker.js`, after the free-allowance
budget wrapper, so every `env.AI.run()` (agents, search, forecasts, automations) sends one OpenTelemetry
generation span to Langfuse: model, latency, token usage, success or error, `product: scalvs`.

- Endpoint: `POST {LANGFUSE_BASE_URL}/api/public/otel/v1/traces` (OTLP/HTTP JSON, `x-langfuse-ingestion-version: 4`).
  It does not use the legacy `/api/public/ingestion` trace events, which Langfuse Cloud shuts off on 2026-11-16.
- On whenever `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are Worker secrets. `LANGFUSE=off` disables it.
- Privacy: no prompts, replies, user ids or IPs by default. `LANGFUSE_CAPTURE_CONTENT=on` adds prompts and replies (capped at 8 KB).
- Spans are sent with `ctx.waitUntil`, time out after 3 s, and never fail or slow a model call.
- Not traced yet: the optional Anthropic and open-weights HTTP paths in `api/run.js` (Workers AI is the production default).
- Plan: Langfuse Cloud Hobby (free). Coupon STARTUP-LF-50 is only for a future upgrade, which needs William's OK.
