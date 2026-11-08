# SCALVS.ai — prototype

Infinitum's AI workforce platform: build agents that research, write, code, sell and operate for you, in any browser.

This is the first working prototype of the four-step flow from the [product page](https://infinitum-corporation.vercel.app/products/scalus):

| Step | Screen | What works |
|---|---|---|
| 01 Create | **Agent Studio** | Six templates (Researcher, Writer, Coder, Sales rep, Operator, Support); name, role, instructions, tools, Context Vault, approval and schedule per agent; plan-based agent limits; multi-agent **teams** run in sequence (/CNDCTR/-style), each agent building on the previous output. |
| 02 Connect | **Connect** | Toggle connections to your apps and Infinitum products (simulated); **Nexus Context Vault** entries with per-product permissions that agents read when memory is on. |
| 03 Run | **Command Center** | Chat-style composer to give an agent or team a task; agent output **streams in live**; **Stop** a running task; **human approval** gates; copy any agent's output; AI-credit meter per plan; schedules list. |
| Predict | **Forecasts** | Swarm forecasts from **CONJURE™**, the Infinitum prediction model: paste seed material, ask a question, and persona agents simulate reactions on Twitter- and Reddit-style platforms before a ReportAgent writes the forecast. A starter question for every Infinitum product (pick it from the Product menu); **Forecast this** on any agent result; live stage progress; Stop; resumes after reload; chat with the ReportAgent. |
| 04 Earn | **Earnings & Data Wallet** | Activity credits and capped **$SCLV** rewards on verified runs, **Data exchange** (sell usage data to ad platforms, data brokers and researchers with per-category, per-buyer consent; 85% paid back in $SCLV), ad revenue share in $SCLV (Free plan), data licensing with an 85% share, ledger, plan switcher. |

> **Simulated economy.** $SCLV, balances, sales and the ledger are mock values stored in the browser. No tokens, wallets, blockchain transactions or payments are involved. Completing a demo or live AI draft does not verify a contribution and does not award activity credits or tokens. Contribution verification and settlement remain unimplemented.

## Live vs demo mode

Agent steps run through `api/run.js`, served by the Cloudflare Worker (`worker.js`), which calls the Claude Messages API.

- **Live:** set `ANTHROPIC_API_KEY` as a Worker secret (optionally `SCALVS_MODEL`, default `claude-sonnet-5-5`, and `ANTHROPIC_BASE_URL` for a gateway). Agents then produce real work, streamed token by token.
- **Demo:** with no key the function answers `503` and the app falls back to simulated agent output, so everything still works end to end.

The composer shows which mode is active.

Provider failures and empty model responses fail the run with a retryable error; they are not replaced with a simulated successful result. A streamed answer counts only when the stream ends with an explicit completion event; provider stream errors, early disconnects and text-less streams fail the step. Approval applies only to the currently pending draft and cannot advance a team twice. **Stop** aborts the in-flight request, marks the run stopped and releases queued steps' credit reservations (the started step keeps its charge); a stopped run cannot be approved or completed afterwards. Runs left `running` by a page reload are stopped on the next load. The browser UI and its approvals are prototype controls, not a server-enforced authorization boundary for external tools.

## Validation

Prototype credits reset by UTC calendar month. Queued steps in active teams reserve credits; rejecting or failing a run releases its unused reservation. Plan changes are rechecked before each step. Started steps consume prototype credits even if the provider fails; these credits are not provider-token billing. Limits are browser-local and are not a production billing or authorization boundary. Active and approval-pending runs are retained independently of the 40-item finished-history limit.

Run `npm test` for agent lifecycle, streaming relay, Stop and API regression tests, and `npm run check` for a syntax check. Provider responses are fixtures; the tests do not establish live provider connectivity. Browser verification covers demo completion, visible demo labeling and unchanged reward balances.

## Predictive forecasts (CONJURE™)

`api/forecast.js` drives CONJURE™, the Infinitum prediction model, through its HTTP API. The CONJURE engine is a self-hosted, unmodified [MiroFish](https://github.com/666ghj/MiroFish) backend. Pipeline: read seed material → build knowledge graph → generate persona agents → simulate → ReportAgent report. The job object lives in the browser; each `POST /api/forecast {action:"advance"}` performs exactly one upstream step, so every serverless call is short and live forecasts resume after a reload. The server re-validates every job it receives (step names, id format, size and round limits). Forecasts cost 60 prototype credits.

- **Live:** set `CONJURE_URL` (and `CONJURE_TOKEN` if the engine sits behind an auth gateway; the old `MIROFISH_*` names still work). The engine itself needs its own `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL_NAME` and `ZEP_API_KEY`; run it with its Docker image or `npm run dev` from its repo.
- **Demo:** without `CONJURE_URL` the app runs a labeled placeholder. No agents are simulated and the report says it is not a prediction.
- **Licensing:** CONJURE™ is the Infinitum product name; its engine, MiroFish, is open source under AGPL-3.0 and keeps its own copyright. It runs unmodified as a separate service and is called only over HTTP; none of its code is copied here. If you modify MiroFish and offer it to users over a network, the AGPL requires publishing those modifications.
- **Security:** the engine ships with no authentication and open CORS. Never expose it publicly; keep it on a private network or behind a gateway that checks `CONJURE_TOKEN`. `/api/forecast` is a prototype endpoint without user auth, so put the deployment behind access control before connecting a paid LLM key.
- **Cost:** a run makes many LLM calls. Rounds are capped at 40, following the MiroFish project's own advice to start below 40.

Other Infinitum products reuse `api/_conjure.js` unchanged: `createJob()` + `advanceJob()` + `conjureClient()`, passing their product name in `product`.

## Data exchange

People create data by using Infinitum products. `src/exchange.js` (product-agnostic, no DOM) lets them sell it and get paid in tokens:

- **Consent first.** Every category × buyer-type pair (ad platforms, data brokers, research) starts off. Nothing is sold without consent for that exact pair, and "Withdraw all consent" stops future sales.
- **What can be sold:** product usage counts, broad interest labels, purchase intent and coarse region (country/state). Never sold: message, document and prompt content, precise location, biometrics, health/financial/ID data, anything from ODIN° or a military edition, and data from minors.
- **Which products contribute:** consumer products only (`EXCHANGE_PRODUCTS`). Defense, identity and network products are excluded. Only SCALVS.ai is connected in this prototype.
- **Payout:** the person keeps 85% of each sale, paid in $SCLV. Ad revenue share is also paid in $SCLV. Points are credited once and never sold twice.
- **Global Privacy Control** is treated as an opt-out of all sales.
- **Simulated:** no data leaves the browser and no tokens or money move.

Before this goes live, it needs:

- privacy counsel to sign off;
- registration as a data broker where the law requires it (California, Vermont, Texas, Oregon);
- a "Do Not Sell or Share" link and notice at collection (CCPA/CPRA), and GDPR-grade consent records;
- signed agreements with each buyer.

Google and Meta generally do not buy broker data outright. Their routes are their own partner programs (for example Customer Match and the Conversions API), each with its own consent rules.

## Run locally

No dependencies, no build step. Node 20+.

```bash
cd scalvs
npm run dev                                  # demo mode, http://localhost:3000
ANTHROPIC_API_KEY=sk-ant-... npm run dev     # live mode
CONJURE_URL=http://localhost:5001 npm run dev  # live forecasts (CONJURE engine)
```

## Deploy (Cloudflare Workers)

`wrangler.jsonc` deploys a Worker named `scalvs-ai`. `npm run build` copies only the browser files (`index.html`, `src/`, `public/`) into `dist/`, which Workers Static Assets serves. `/api/run` and `/api/forecast` go to `worker.js`, which calls the same Web-standard handlers in `api/`. The API source, tests and config never become public URLs.

```bash
npm install
npm run dev:worker       # build + wrangler dev
npm run deploy:preview   # build + upload a preview version (does not go live)
npm run deploy           # production deploy, which needs sign-off first
```

`npm run dev` (zero-dependency Node server) still works for local hacking.

### Environment variables

Set secrets with `npx wrangler secret put <NAME>`, or put them in a git-ignored `.dev.vars` for `wrangler dev`. Never commit them. With none set, the app runs in demo mode.

| Name | Kind | What it is |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret | Turns on live agents. |
| `SCALVS_MODEL` | var | Optional model override (default `claude-sonnet-5-5`). |
| `ANTHROPIC_BASE_URL` | var | Optional gateway URL. |
| `CONJURE_URL` | var | CONJURE™ engine base URL. Must be private or behind a token-checking proxy. |
| `CONJURE_TOKEN` | secret | Token for that proxy. |

There's no database: all state stays in the browser (`localStorage`), so this app has no Supabase schema.

## Structure

```
index.html            app shell + sidebar
src/app.js            hash router, re-rendering
src/store.js          localStorage state (agents, teams, runs, vault, wallet)
src/runner.js         run lifecycle: sequencing, approvals, credits, rewards
src/data.js           templates, plans, connectors, reward rules
src/views/*.js        command, studio, connect, earnings
src/styles.css        clean white UI
worker.js             Cloudflare Worker: /api/* routes, assets for the rest
api/run.js            Claude-backed agent step
api/forecast.js       CONJURE™ forecast proxy
api/_conjure.js       CONJURE™ client + one-step-per-call job state machine
src/forecaster.js     browser forecast driver, demo mode, resume, ReportAgent chat
src/exchange.js       data exchange: consent, points, sales and $SCLV payouts
src/views/forecast.js Forecasts screen
dev-server.mjs        zero-dependency local server
```

## Next steps

- Accounts (Cumulus://ID) and a database so agents, runs and the vault sync across devices
- Real connectors (email, Slack, GitHub) behind OAuth, with approvals enforced server-side
- Server-side scheduler for scheduled agents
- Tool use in the agent runtime (web search, files) with per-tool approval

© 2026 Infinitum Corporation

