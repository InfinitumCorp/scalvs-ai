# SCALVS.ai — prototype

Infinitum's AI workforce platform: build agents that research, write, code, sell and operate for you, in any browser.

This is the first working prototype of the four-step flow from the [product page](https://infinitum-corporation.vercel.app/products/scalus):

| Step | Screen | What works |
|---|---|---|
| 01 Create | **Agent Studio** | Six templates (Researcher, Writer, Coder, Sales rep, Operator, Support); name, role, instructions, tools, Context Vault, approval and schedule per agent; plan-based agent limits; multi-agent **teams** run in sequence (/CNDCTR/-style), each agent building on the previous output. |
| 02 Connect | **Connect** | Toggle connections to your apps and Infinitum products (simulated); **Nexus Context Vault** entries with per-product permissions that agents read when memory is on. |
| 03 Run | **Command Center** | Chat-style composer to give an agent or team a task; agent output **streams in live**; **Stop** a running task; **human approval** gates; copy any agent's output; AI-credit meter per plan; schedules list. |
| Predict | **Forecasts** | Swarm forecasts powered by the open-source **MiroFish** engine: paste seed material, ask a question, and persona agents simulate reactions on Twitter- and Reddit-style platforms before a ReportAgent writes the forecast. Presets for SCALVS.ai, +SPCTR, METATRON¹⁰⁰ and /CNDCTR/; **Forecast this** on any agent result; live stage progress; Stop; resumes after reload; chat with the ReportAgent. |
| 04 Earn | **Earnings & Data Wallet** | Activity credits and capped **$SCLV** rewards on verified runs, ad revenue share opt-in (Free plan), data licensing with an 85% share, ledger, plan switcher. |

> **Simulated economy.** $SCLV, balances, sales and the ledger are mock values stored in the browser. No tokens, wallets, blockchain transactions or payments are involved. Completing a demo or live AI draft does not verify a contribution and does not award activity credits or tokens. Contribution verification and settlement remain unimplemented.

## Live vs demo mode

Agent steps run through `api/run.js`, a Vercel serverless function that calls the Claude Messages API.

- **Live:** set `ANTHROPIC_API_KEY` in the Vercel project (optionally `SCALVS_MODEL`, default `claude-sonnet-5-5`, and `ANTHROPIC_BASE_URL` for a gateway). Agents then produce real work, streamed token by token.
- **Demo:** with no key the function answers `503` and the app falls back to simulated agent output, so everything still works end to end.

The composer shows which mode is active.

Provider failures and empty model responses fail the run with a retryable error; they are not replaced with a simulated successful result. A streamed answer counts only when the stream ends with an explicit completion event; provider stream errors, early disconnects and text-less streams fail the step. Approval applies only to the currently pending draft and cannot advance a team twice. **Stop** aborts the in-flight request, marks the run stopped and releases queued steps' credit reservations (the started step keeps its charge); a stopped run cannot be approved or completed afterwards. Runs left `running` by a page reload are stopped on the next load. The browser UI and its approvals are prototype controls, not a server-enforced authorization boundary for external tools.

## Validation

Prototype credits reset by UTC calendar month. Queued steps in active teams reserve credits; rejecting or failing a run releases its unused reservation. Plan changes are rechecked before each step. Started steps consume prototype credits even if the provider fails; these credits are not provider-token billing. Limits are browser-local and are not a production billing or authorization boundary. Active and approval-pending runs are retained independently of the 40-item finished-history limit.

Run `npm test` for agent lifecycle, streaming relay, Stop and API regression tests, and `npm run check` for a syntax check. Provider responses are fixtures; the tests do not establish live provider connectivity. Browser verification covers demo completion, visible demo labeling and unchanged reward balances.

## Predictive forecasts (MiroFish)

`api/forecast.js` drives a self-hosted [MiroFish](https://github.com/666ghj/MiroFish) backend through its HTTP API: read seed material → build knowledge graph → generate persona agents → simulate → ReportAgent report. The job object lives in the browser; each `POST /api/forecast {action:"advance"}` performs exactly one upstream step, so every serverless call is short and live forecasts resume after a reload. The server re-validates every job it receives (step names, id format, size and round limits). Forecasts cost 60 prototype credits.

- **Live:** set `MIROFISH_URL` (and `MIROFISH_TOKEN` if MiroFish sits behind an auth gateway). MiroFish itself needs its own `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL_NAME` and `ZEP_API_KEY`; run it with its Docker image or `npm run dev` from its repo.
- **Demo:** without `MIROFISH_URL` the app runs a labeled placeholder. No agents are simulated and the report says it is not a prediction.
- **Licensing:** MiroFish is AGPL-3.0. It runs unmodified as a separate service and is called only over HTTP; none of its code is copied here. If you modify MiroFish and offer it to users over a network, the AGPL requires publishing those modifications.
- **Security:** MiroFish ships with no authentication and open CORS. Never expose it publicly; keep it on a private network or behind a gateway that checks `MIROFISH_TOKEN`. `/api/forecast` is a prototype endpoint without user auth, so put the deployment behind access control before connecting a paid LLM key.
- **Cost:** a run makes many LLM calls. Rounds are capped at 40, following MiroFish's own advice to start below 40.

Other Infinitum products reuse `api/_mirofish.js` unchanged: `createJob()` + `advanceJob()` + `mirofishClient()`, passing their product name in `product`.

## Run locally

No dependencies, no build step. Node 20+.

```bash
cd scalvs
npm run dev                                  # demo mode, http://localhost:3000
ANTHROPIC_API_KEY=sk-ant-... npm run dev     # live mode
MIROFISH_URL=http://localhost:5001 npm run dev  # live forecasts (MiroFish backend)
```

## Deploy

Import the repo in Vercel and set **Root Directory** to `scalvs` (framework preset: **Other**, no build command). Static files are served as-is and `api/run.js` becomes `/api/run`. All paths are relative, so the static app also works from any subfolder (it falls back to demo mode where `/api/run` isn't deployed).

## Structure

```
index.html            app shell + sidebar
src/app.js            hash router, re-rendering
src/store.js          localStorage state (agents, teams, runs, vault, wallet)
src/runner.js         run lifecycle: sequencing, approvals, credits, rewards
src/data.js           templates, plans, connectors, reward rules
src/views/*.js        command, studio, connect, earnings
src/styles.css        clean white UI
api/run.js            Claude-backed agent step (Vercel function)
api/forecast.js       MiroFish forecast proxy (Vercel function)
api/_mirofish.js      MiroFish client + one-step-per-call job state machine
src/forecaster.js     browser forecast driver, demo mode, resume, ReportAgent chat
src/views/forecast.js Forecasts screen
dev-server.mjs        zero-dependency local server
```

## Next steps

- Accounts (Cumulus://ID) and a database so agents, runs and the vault sync across devices
- Real connectors (email, Slack, GitHub) behind OAuth, with approvals enforced server-side
- Server-side scheduler for scheduled agents
- Tool use in the agent runtime (web search, files) with per-tool approval

© 2026 Infinitum Corporation

