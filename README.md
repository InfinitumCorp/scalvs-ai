# SCALVS.ai — prototype

Infinitum's AI workforce platform: build agents that research, write, code, sell and operate for you, in any browser.

This is the first working prototype of the four-step flow from the [product page](https://infinitum-corporation.vercel.app/products/scalus):

| Step | Screen | What works |
|---|---|---|
| 01 Create | **Agent Studio** | Six templates (Researcher, Writer, Coder, Sales rep, Operator, Support); name, role, instructions, tools, Context Vault, approval and schedule per agent; plan-based agent limits; multi-agent **teams** run in sequence (/CNDCTR/-style), each agent building on the previous output. |
| 02 Connect | **Connect** | Google Workspace (Gmail, Drive, Calendar) when OAuth credentials are set; other apps and Infinitum products stay simulated toggles. **Nexus Context Vault** entries with per-product permissions that agents read when memory is on. |
| 03 Run | **Command Center** | Chat-style composer to give an agent or team a task; agent output **streams in live**; **Stop** a running task; **human approval** gates; copy any agent's output; AI-credit meter per plan; schedules list. |
| Predict | **Forecasts** | Swarm forecasts from **CONJURE™**, the Infinitum prediction model: paste seed material, ask a question, and persona agents simulate reactions on Twitter- and Reddit-style platforms before a ReportAgent writes the forecast. A starter question for every Infinitum product (pick it from the Product menu); **Forecast this** on any agent result; live stage progress; Stop; resumes after reload; chat with the ReportAgent. |
| 04 Earn | **Earnings & Data Wallet** | Activity credits and capped **$SCLV** rewards on verified runs, **Data exchange** (sell usage data to ad platforms, data brokers and researchers with per-category, per-buyer consent; 85% paid back in $SCLV), ad revenue share in $SCLV (Free plan), data licensing with an 85% share, ledger, plan switcher. |

> **Simulated economy.** $SCLV, balances, sales and the ledger are mock values stored in the browser. No tokens, wallets, blockchain transactions or payments are involved. Completing a demo or live AI draft does not verify a contribution and does not award activity credits or tokens. Contribution verification and settlement remain unimplemented.

## Live vs demo mode

Agent steps run through `api/run.js`, served by the Cloudflare Worker (`worker.js`), which calls the Claude Messages API.

- **Live on Workers AI (default on scalvs.app):** with no key set, agents run on the Worker's Workers AI binding (`WORKERS_AI_MODEL`, default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`), billed to the Cloudflare account. No provider key is needed.
- **Live on Claude:** set `ANTHROPIC_API_KEY` as a Worker secret (optionally `SCALVS_MODEL`, default `claude-sonnet-5-5`, and `ANTHROPIC_BASE_URL` for a gateway). Agents then produce real work, streamed token by token. Claude stays ahead of Workers AI and Gemini.
- **Live on Gemini (optional fallback):** set `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com/apikey). This is the free-tier API key, not Vertex AI and not a billed Google Cloud project. Gemini runs only when Claude and Workers AI are not configured, or when an earlier provider returns HTTP 429. `GEMINI_MODEL` defaults to `gemini-2.5-flash`. `GEMINI_BASE_URL` may point at another HTTPS gateway; hosts under `aiplatform.googleapis.com` are refused.
- **Demo:** with no Claude key, no Gemini key and no Workers AI binding, the function answers `503` and the app falls back to simulated agent output, so everything still works end to end.

The composer shows which mode is active.

Provider failures and empty model responses fail the run with a retryable error; they are not replaced with a simulated successful result. An HTTP 429 tries the next configured provider (Claude, then Workers AI, then Gemini) before that failure is returned. A streamed answer counts only when the stream ends with an explicit completion event; provider stream errors, early disconnects and text-less streams fail the step. Approval applies only to the currently pending draft and cannot advance a team twice. **Stop** aborts the in-flight request, marks the run stopped and releases queued steps' credit reservations (the started step keeps its charge); a stopped run cannot be approved or completed afterwards. Runs left `running` by a page reload are stopped on the next load. The browser UI and its approvals are prototype controls, not a server-enforced authorization boundary for external tools.

## Validation

Prototype credits reset by UTC calendar month. Queued steps in active teams reserve credits; rejecting or failing a run releases its unused reservation. Plan changes are rechecked before each step. Started steps consume prototype credits even if the provider fails; these credits are not provider-token billing. Limits are browser-local and are not a production billing or authorization boundary. Active and approval-pending runs are retained independently of the 40-item finished-history limit.

Run `npm test` for agent lifecycle, streaming relay, Stop and API regression tests, and `npm run check` for a syntax check. Provider responses are fixtures; the tests do not establish live provider connectivity. Browser verification covers demo completion, visible demo labeling and unchanged reward balances.

## Predictive forecasts (CONJURE™)

`api/forecast.js` drives CONJURE™, the Infinitum prediction model, through its HTTP API. The CONJURE engine is a self-hosted, unmodified [MiroFish](https://github.com/666ghj/MiroFish) backend. Pipeline: read seed material → build knowledge graph → generate persona agents → simulate → ReportAgent report. The job object lives in the browser; each `POST /api/forecast {action:"advance"}` performs exactly one upstream step, so every serverless call is short and live forecasts resume after a reload. The server re-validates every job it receives (step names, id format, size and round limits). Forecasts cost 60 prototype credits.

- **Live:** set `CONJURE_URL` (and `CONJURE_TOKEN` if the engine sits behind an auth gateway; the old `MIROFISH_*` names still work). The engine itself needs its own `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL_NAME` and `ZEP_API_KEY`; run it with its Docker image or `npm run dev` from its repo.
- **Live on Workers AI (default on scalvs.app):** without `CONJURE_URL`, CONJURE™ runs inside the Worker: the nexus engine (`api/_conjure-engine.ts`, vendored from infinitum-nexus `packages/conjure`) builds a world of 12 persona agents, plays up to 6 rounds (one per request) and writes the report. Caps are enforced server-side; API POSTs are rate-limited to 60 per minute per IP.
- **Demo:** with no engine URL and no AI binding (for example `npm run dev`), the app runs a labeled placeholder. No agents are simulated and the report says it is not a prediction.
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

No install is required for demo mode. Node 20+. `npm install` is needed for Wrangler and, only if you turn AWS on, for `aws4fetch` (the signer). The dev server does not load it unless an AWS call is actually made.

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
| `ANTHROPIC_API_KEY` | secret | Turns on live agents (primary). |
| `SCALVS_MODEL` | var | Optional Claude model override (default `claude-sonnet-5-5`). |
| `ANTHROPIC_BASE_URL` | var | Optional Claude gateway URL. |
| `GEMINI_API_KEY` | secret | Optional Google AI Studio key. Free tier, not Vertex. Off when unset. |
| `GEMINI_MODEL` | var | Optional Gemini model (default `gemini-2.5-flash`). |
| `GEMINI_BASE_URL` | var | Optional HTTPS base. Vertex hosts are refused. |
| `GOOGLE_CLIENT_ID` | var | OAuth client id for Gmail, Drive and Calendar. Off unless this and the secret are set. |
| `GOOGLE_CLIENT_SECRET` | secret | OAuth client secret. |
| `GOOGLE_TOKEN_KEY` | secret | Optional 32-byte AES-GCM key (base64 or 64 hex chars). Otherwise derived from the client secret. |
| `GOOGLE_REDIRECT_URI` | var | Optional. Defaults to this host's `/api/google/callback`. |
| `CONJURE_URL` | var | CONJURE™ engine base URL. Must be private or behind a token-checking proxy. |
| `CONJURE_TOKEN` | secret | Token for that proxy. |
| `AWS_REGION` | var | Required before any AWS adapter turns on, together with the two keys below. |
| `AWS_ACCESS_KEY_ID` | secret | IAM access key. Least privilege for the adapters you enable. |
| `AWS_SECRET_ACCESS_KEY` | secret | IAM secret key. |
| `AWS_SESSION_TOKEN` | secret | Optional temporary credential. |
| `AWS_SQS_QUEUE_URL` | var | Standard queue URL. Off when unset, and the synchronous run/forecast path is used. |
| `AWS_DYNAMODB_TABLE` | var | Provisioned Standard table name. Off when unset; the browser keeps localStorage. |
| `AWS_CLOUDWATCH_NAMESPACE` | var | Custom-metric namespace. Off when unset. Do not use an `AWS/` prefix. |

There's no database: agent state stays in the browser (`localStorage`). Google OAuth tokens, when connectors are enabled, are encrypted with AES-GCM and kept in an HttpOnly cookie instead. This app has no Supabase schema.

## Google Workspace

Optional. Nothing calls Google unless both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. The Connect screen then sends Email, Docs & files, and Calendar through OAuth 2.0 with PKCE and a `state` check. The person consents on Google's own screen. Other connectors stay simulated.

| Connector | Actions | Scopes |
|---|---|---|
| Email | List and read threads. Save a draft. Mail is never sent. | `gmail.readonly`, `gmail.compose` |
| Docs & files | List files. Read text, or export a Doc, Sheet or Slides file as text. | `drive.readonly` |
| Calendar | List upcoming events. Create an event on the primary calendar, without guests. | `calendar.events` |

`gmail.compose` is the narrowest scope Google offers that can create a draft. This app never calls Gmail's send methods. Calendar events are created without attendees, so Google is not asked to mail invitations.

Create a Web application OAuth client in a Google Cloud project and leave billing off. Enable the Gmail, Google Drive and Google Calendar APIs. Register the redirect URI `https://<host>/api/google/callback` (locally, `http://localhost:3000/api/google/callback`). The refresh token and access token are sealed with AES-GCM before they are stored. Set `GOOGLE_TOKEN_KEY` to a 32-byte key, or leave it unset to derive one from `GOOGLE_CLIENT_SECRET`. Disconnecting the last Google connector revokes the token.

## AWS Always Free

Optional, and off with no change to demo or live behavior unless `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and that service's own variable are set. These adapters do not call Bedrock or any other paid AWS API. Confirm the current Always Free numbers on the AWS Free Tier page before enabling them; the code is shaped for the limits below.

| Service | Turns on with | Always Free shape used here |
|---|---|---|
| SQS | `AWS_SQS_QUEUE_URL` | Standard queue. 1 million requests per month. A step is one send, one short receive (`WaitTimeSeconds` 0), and one delete. |
| DynamoDB | `AWS_DYNAMODB_TABLE` | One provisioned Standard table at 25 RCU and 25 WCU, 25 GB. On-demand (`PAY_PER_REQUEST`) is not used and bills. |
| CloudWatch | `AWS_CLOUDWATCH_NAMESPACE` | Two custom metrics and no dimensions: `AgentRunErrors` and `QueueFailures`. The first 10 custom metrics are free. Dimensions would each count as another metric. Puts are best-effort and do not delay or fail the request. |

Create the queue and the table yourself. Do not switch the table to on-demand.

```bash
aws sqs create-queue --queue-name scalvs-jobs \
  --attributes VisibilityTimeout=90,ReceiveMessageWaitTimeSeconds=0
aws dynamodb create-table --table-name scalvs-state \
  --attribute-definitions AttributeName=pk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH \
  --billing-mode PROVISIONED \
  --provisioned-throughput ReadCapacityUnits=25,WriteCapacityUnits=25 \
  --table-class STANDARD
```

SQS holds one agent step or one forecast step so a Worker timeout can be retried from the message. `POST /api/run` and `POST /api/forecast` stay synchronous when the queue URL is unset. A step larger than 200 KB is refused by the queue and the client uses the synchronous path. Visibility is 90 seconds. A message received more than three times is dropped.

DynamoDB stores one item per profile code (`pk`) so a second browser can load the same agents, runs, and vault. localStorage remains the default and the on-device copy. The item is capped at 20 KB: one write is then 20 WCU, under the 25 WCU ceiling, and an eventually consistent read of that item is a few RCU, under the 25 RCU ceiling. Larger state is kept only in the browser. The profile code is the access key for that item. The Connect screen shows it only when this adapter is on.

Give the IAM user only `sqs:SendMessage`, `sqs:ReceiveMessage`, `sqs:DeleteMessage`, and `sqs:ChangeMessageVisibility` on that queue, `dynamodb:GetItem` and `dynamodb:PutItem` on that table, and `cloudwatch:PutMetricData` for the namespace. Do not grant Bedrock.

## Structure

```
index.html            app shell + sidebar
src/app.js            hash router, re-rendering
src/store.js          localStorage state (agents, teams, runs, vault, wallet)
src/runner.js         run lifecycle: sequencing, approvals, credits, rewards
src/data.js           templates, plans, connectors, reward rules
src/google.js         Connect-screen helper for optional Google OAuth
src/views/*.js        command, studio, connect, earnings
src/styles.css        clean white UI
worker.js             Cloudflare Worker: /api/* routes, assets for the rest
api/run.js            agent step (Claude, then Workers AI, then optional Gemini)
api/_gemini.js        Google AI Studio Gemini client
api/google.js         Google Workspace OAuth connectors
api/_google.js        PKCE, AES-GCM token cookie, Gmail/Drive/Calendar calls
api/_aws.js           optional SQS, DynamoDB, and CloudWatch (Always Free)
api/jobs.js           optional SQS step queue
api/state.js          optional DynamoDB profile store
src/queue.js          client: use the queue only when the server enabled it
src/remote.js         client: localStorage sync when DynamoDB is enabled
api/forecast.js       CONJURE™ forecast proxy
api/_conjure.js       CONJURE™ client + one-step-per-call job state machine
src/forecaster.js     browser forecast driver, demo mode, resume, ReportAgent chat
src/exchange.js       data exchange: consent, points, sales and $SCLV payouts
src/views/forecast.js Forecasts screen
dev-server.mjs        zero-dependency local server
```

## Next steps

- Accounts (Cumulus://ID) and a database so agents, runs and the vault sync across devices
- Slack and GitHub connectors behind OAuth (Gmail, Drive and Calendar are optional when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set)
- Server-side approval gates before any external action an agent takes on its own
- Server-side scheduler for scheduled agents
- Tool use in the agent runtime (web search, files) with per-tool approval

© 2026 Infinitum Corporation

