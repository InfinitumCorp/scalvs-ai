# Running SCALVS.ai agents on OpenClaw

[OpenClaw](https://github.com/openclaw/openclaw) is a free, open-source (MIT) agent
gateway. When `OPENCLAW_URL` is set, SCALVS.ai sends every agent step to OpenClaw
instead of Claude, Workers AI or a plain open-weight server. OpenClaw runs the agent
with its own tools, memory and model routing; SCALVS.ai sends the agent brief and
streams the answer back to the app. Nothing in the app UI changes.

Pair it with free local models (for example Ollama) and the whole stack is open
source with no per-token bill.

## 1. Install OpenClaw on the machine that will run the agents

Needs Node 24.16+ (or 26.1+).

```bash
npm install -g openclaw@latest --allow-scripts=openclaw
openclaw onboard --install-daemon
openclaw gateway status
```

During onboarding, pick a model provider. For a fully free setup choose Ollama and a
local model such as `qwen3:8b`.

## 2. Turn on the OpenAI-compatible endpoint

It is off by default. In the OpenClaw config set:

```json
{ "gateway": { "http": { "endpoints": { "chatCompletions": { "enabled": true } } } } }
```

Restart the gateway. It now answers `POST /v1/chat/completions` (default port 18789).

## 3. Point SCALVS.ai at it

| Name | Kind | What it is |
|---|---|---|
| `OPENCLAW_URL` | var | Gateway base URL ending in `/v1`, e.g. `http://127.0.0.1:18789/v1`. Comma-separate several gateways for failover. Setting it makes OpenClaw the engine. |
| `OPENCLAW_TOKEN` | secret | The gateway token or password. Sent as `Authorization: Bearer`. |
| `OPENCLAW_AGENT` | var | Agent target, default `openclaw/default`. |
| `OPENCLAW_MODEL` | var | Optional provider model override, sent as `x-openclaw-model` (e.g. `ollama/qwen3:8b`). |

Locally put them in `.dev.vars` (git-ignored). For the Worker:

```bash
npx wrangler secret put OPENCLAW_TOKEN
```

and set `OPENCLAW_URL` (plus the optional vars) in the Cloudflare dashboard or
`wrangler.jsonc` vars. `GET /api/run` reports `"engine": "openclaw"` when it is on.

The Worker runs in Cloudflare, so the gateway must be reachable from the internet.
Use a Cloudflare Tunnel (free) in front of the gateway rather than opening a port.

## Security

- The gateway token is **full operator access** to that OpenClaw gateway. Keep it a
  Worker secret. Never commit it, never put it in client code.
- Give SCALVS.ai its own OpenClaw agent (`OPENCLAW_AGENT`) with only the tools it
  needs. Agent prompts come from app users, so treat them as untrusted input.
- Credentials found in prompts are stripped before they are sent
  (`OPEN_WEIGHTS_REDACT=off` disables this).

## What runs where

| SCALVS.ai feature | With OpenClaw |
|---|---|
| Plain agent steps (streamed or not) | OpenClaw |
| Think and Deep search modes | OpenClaw (search results are fetched by SCALVS.ai first) |
| Connected apps and plug-ins (tool calls) | OpenClaw, with the tools sent as OpenAI function tools |
| Browse mode | OpenClaw drives the tool loop |
| Image attachments | Still Claude or Workers AI vision (OpenClaw's chat endpoint gets text only) |

OpenClaw adds its own agent prompt (about 13.5k tokens) to every step. On a CPU-only
server with a small model that takes 1-2 minutes per step, so raise
`OPEN_WEIGHTS_TIMEOUT_MS` (default 120000) there, or give the model a GPU.

## Tested

- **GitHub-hosted runner** (4 vCPU, 16 GB, no GPU), Ollama + `qwen3:0.6b`: plain and
  streamed agent steps pass (`.github/workflows/openclaw-e2e.yml`). A plain step takes
  1-4 minutes, almost all of it the model reading OpenClaw's prompt.
- **Yandex Cloud, Russia** (2 vCPU, 4 GB), 2026-11-12: npm, nodejs.org, GitHub and
  Ollama's registry all download without a VPN, and the gateway starts. The model
  did not fit: OpenClaw asks for a 32k-token context, and with the gateway running the
  4 GB server ran out of memory. Run the model on a host with 8 GB or more (or a
  GPU), or point OpenClaw at a model server elsewhere; the gateway itself fits.

Retries, failover between gateways and the circuit breaker are the same as for the
open-weight tier (`OPEN_WEIGHTS_RETRIES`, `OPEN_WEIGHTS_RETRY_BASE_MS`, see
`api/_resilience.js`).
