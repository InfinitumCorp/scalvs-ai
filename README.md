# SCALVS.ai — prototype

Infinitum's AI workforce platform: build agents that research, write, code, sell and operate for you, in any browser.

This is the first working prototype of the four-step flow from the [product page](https://infinitum-corporation.vercel.app/products/scalus):

| Step | Screen | What works |
|---|---|---|
| 01 Create | **Agent Studio** | Six templates (Researcher, Writer, Coder, Sales rep, Operator, Support); name, role, instructions, tools, Context Vault, approval and schedule per agent; plan-based agent limits; multi-agent **teams** run in sequence (/CNDCTR/-style), each agent building on the previous output. |
| 02 Connect | **Connect** | Toggle connections to your apps and Infinitum products (simulated); **Nexus Context Vault** entries with per-product permissions that agents read when memory is on. |
| 03 Run | **Command Center** | Chat-style composer to give an agent or team a task; agent output **streams in live**; **Stop** a running task; **human approval** gates; copy any agent's output; AI-credit meter per plan; schedules list. |
| 04 Earn | **Earnings & Data Wallet** | Activity credits and capped **$SCLV** rewards on verified runs, ad revenue share opt-in (Free plan), data licensing with an 85% share, ledger, plan switcher. |

> **Simulated economy.** $SCLV, balances, sales and the ledger are mock values stored in the browser. No tokens, wallets, blockchain transactions or payments are involved.

## Live vs demo mode

Agent steps run through `api/run.js`, a Vercel serverless function that calls the Claude Messages API.

- **Live:** set `ANTHROPIC_API_KEY` in the Vercel project (optionally `SCALVS_MODEL`, default `claude-sonnet-5-5`, and `ANTHROPIC_BASE_URL` for a gateway). Agents then produce real work, streamed token by token.
- **Demo:** with no key the function answers `503` and the app falls back to simulated agent output, so everything still works end to end.

The composer shows which mode is active.

## Run locally

No dependencies, no build step. Node 20+.

```bash
cd scalvs
npm run dev                                  # demo mode, http://localhost:3000
ANTHROPIC_API_KEY=sk-ant-... npm run dev     # live mode
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
dev-server.mjs        zero-dependency local server
```

## Next steps

- Accounts (Cumulus://ID) and a database so agents, runs and the vault sync across devices
- Real connectors (email, Slack, GitHub) behind OAuth, with approvals enforced server-side
- Server-side scheduler for scheduled agents
- Tool use in the agent runtime (web search, files) with per-tool approval

© 2026 Infinitum Corporation
