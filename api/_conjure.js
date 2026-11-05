// CONJURE™ predictive-simulation client (server side, product-agnostic).
//
// CONJURE™ is Infinitum's in-house prediction model. Its engine is the
// open-source MiroFish (https://github.com/666ghj/MiroFish, AGPL-3.0): it turns
// seed material into a knowledge graph, spawns persona agents, simulates how
// they react on Twitter- and Reddit-like platforms, then has a ReportAgent write
// a forecast. Infinitum runs the engine UNMODIFIED as a separate service and
// talks to it only over its HTTP API; no MiroFish code is copied here.
//
// The job is a plain object the caller stores and sends back. Each call to
// advanceJob() performs at most ONE upstream request, so serverless calls stay
// short and a forecast survives page reloads. Any Infinitum product (SCALVS.ai,
// +SPCTR, METATRON¹⁰⁰, /CNDCTR/) can drive a forecast through the same job.

export const STAGES = [
  { id: 'ontology', label: 'Read seed material' },
  { id: 'graph', label: 'Build knowledge graph' },
  { id: 'agents', label: 'Generate persona agents' },
  { id: 'simulate', label: 'Simulate reactions' },
  { id: 'report', label: 'Write forecast report' },
];

// Fine-grained steps of the state machine -> the user-facing stage they belong to.
const STEP_STAGE = {
  ontology: 'ontology',
  graph_build: 'graph', graph_wait: 'graph',
  sim_create: 'agents', prepare: 'agents', prepare_wait: 'agents',
  run_start: 'simulate', run_wait: 'simulate',
  report_start: 'report', report_wait: 'report', report_fetch: 'report',
  done: 'report',
};
export const stageOf = (step) => STEP_STAGE[step] || 'ontology';

export const LIMITS = { question: 2000, seed: 60000, maxRounds: 40, minRounds: 5 };
const MAX_POLL_FAILURES = 5;
const ID = /^[A-Za-z0-9_-]{1,100}$/;

const clip = (v, n) => String(v ?? '').slice(0, n);
const safeId = (v) => (typeof v === 'string' && ID.test(v) ? v : null);

export class UpstreamError extends Error {
  constructor(message, { transient = false } = {}) {
    super(message);
    this.transient = transient;
  }
}

// Validates and normalizes a new job request from any product.
export function createJob(input = {}) {
  const question = clip(input.question, LIMITS.question).trim();
  const seed = clip(input.seed, LIMITS.seed).trim();
  if (!question) return { error: 'Describe what you want to predict.' };
  if (seed.length < 40) return { error: 'Add at least a paragraph of seed material (news, notes, a plan, data).' };
  const rounds = Math.round(Number(input.rounds) || 20);
  const platform = ['parallel', 'twitter', 'reddit'].includes(input.platform) ? input.platform : 'parallel';
  return {
    job: {
      v: 1,
      step: 'ontology',
      status: 'running',
      product: clip(input.product || 'SCALVS.ai', 40),
      title: clip(input.title || question, 120),
      question,
      seed,
      rounds: Math.min(LIMITS.maxRounds, Math.max(LIMITS.minRounds, rounds)),
      platform,
      ids: {},
      progress: 0,
      message: 'Queued',
      failures: 0,
      report: null,
      error: null,
    },
  };
}

// Minimal CONJURE engine (MiroFish) HTTP client. `fetchImpl` is injectable for tests.
export function conjureClient({ baseUrl, token, fetchImpl = fetch, timeoutMs = 30000 }) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  async function call(method, path, { json, form, timeout = timeoutMs } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let body;
    if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;
    let res;
    try {
      res = await fetchImpl(`${root}${path}`, { method, headers, body, signal: AbortSignal.timeout(timeout) });
    } catch {
      throw new UpstreamError('The forecasting engine could not be reached.', { transient: true });
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok || !data || data.success === false) {
      // 5xx and gateway errors may be temporary; 4xx means the request itself is wrong.
      throw new UpstreamError('The forecasting engine rejected a step.', { transient: res.status >= 500 && res.status !== 501 });
    }
    return data.data ?? {};
  }
  return {
    generateOntology(job) {
      const form = new FormData();
      form.append('simulation_requirement', job.question);
      form.append('project_name', job.title);
      form.append('additional_context', `Requested from ${job.product} (Infinitum).`);
      form.append('files', new Blob([job.seed], { type: 'text/markdown' }), 'seed.md');
      return call('POST', '/api/graph/ontology/generate', { form, timeout: 240000 });
    },
    buildGraph: (projectId) => call('POST', '/api/graph/build', { json: { project_id: projectId } }),
    task: (taskId) => call('GET', `/api/graph/task/${taskId}`),
    createSimulation: (projectId, graphId, platform) => call('POST', '/api/simulation/create', {
      json: { project_id: projectId, graph_id: graphId, enable_twitter: platform !== 'reddit', enable_reddit: platform !== 'twitter' },
    }),
    prepare: (simulationId) => call('POST', '/api/simulation/prepare', { json: { simulation_id: simulationId } }),
    prepareStatus: (taskId, simulationId) => call('POST', '/api/simulation/prepare/status', { json: { task_id: taskId, simulation_id: simulationId } }),
    start: (simulationId, platform, maxRounds) => call('POST', '/api/simulation/start', {
      json: { simulation_id: simulationId, platform, max_rounds: maxRounds, enable_graph_memory_update: false },
    }),
    runStatus: (simulationId) => call('GET', `/api/simulation/${simulationId}/run-status`),
    stop: (simulationId) => call('POST', '/api/simulation/stop', { json: { simulation_id: simulationId } }),
    generateReport: (simulationId) => call('POST', '/api/report/generate', { json: { simulation_id: simulationId } }),
    reportStatus: (taskId, simulationId) => call('POST', '/api/report/generate/status', { json: { task_id: taskId, simulation_id: simulationId } }),
    report: (reportId) => call('GET', `/api/report/${reportId}`),
    chat: (simulationId, message, history) => call('POST', '/api/report/chat', {
      json: { simulation_id: simulationId, message, chat_history: history }, timeout: 120000,
    }),
  };
}

const pct = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
// Overall progress: each of the 5 stages is 20%.
const overall = (step, inner = 0) => Math.min(99, STAGES.findIndex((s) => s.id === stageOf(step)) * 20 + Math.round(pct(inner) / 5));

function requireId(value, what) {
  const id = safeId(value);
  if (!id) throw new UpstreamError(`The forecasting engine returned no valid ${what}.`);
  return id;
}

// Performs one upstream step and returns the next job. Never throws.
export async function advanceJob(job, client) {
  if (!job || job.status !== 'running') return job;
  const next = structuredClone(job);
  const ids = next.ids;
  const go = (step, message, inner = 0) => {
    next.step = step;
    next.message = message;
    next.progress = Math.max(Number(job.progress) || 0, overall(step, inner)); // never moves backwards
  };

  try {
    switch (next.step) {
      case 'ontology': {
        const d = await client.generateOntology(next);
        ids.project_id = requireId(d.project_id, 'project');
        go('graph_build', 'Seed material analysed');
        break;
      }
      case 'graph_build': {
        const d = await client.buildGraph(ids.project_id);
        ids.task_id = requireId(d.task_id, 'task');
        go('graph_wait', 'Building knowledge graph');
        break;
      }
      case 'graph_wait': {
        const d = await client.task(ids.task_id);
        if (d.status === 'failed') throw new UpstreamError('Knowledge graph build failed.');
        if (d.status === 'completed') {
          ids.graph_id = requireId(d.result?.graph_id, 'graph');
          go('sim_create', 'Knowledge graph ready');
        } else go('graph_wait', 'Building knowledge graph', d.progress);
        break;
      }
      case 'sim_create': {
        const d = await client.createSimulation(ids.project_id, ids.graph_id, next.platform);
        ids.simulation_id = requireId(d.simulation_id, 'simulation');
        go('prepare', 'Simulation created');
        break;
      }
      case 'prepare': {
        const d = await client.prepare(ids.simulation_id);
        if (d.already_prepared || d.status === 'ready') go('run_start', 'Persona agents ready');
        else { ids.task_id = requireId(d.task_id, 'task'); go('prepare_wait', 'Generating persona agents'); }
        break;
      }
      case 'prepare_wait': {
        const d = await client.prepareStatus(ids.task_id, ids.simulation_id);
        if (d.status === 'failed') throw new UpstreamError('Persona generation failed.');
        if (d.status === 'completed' || d.status === 'ready' || d.already_prepared) go('run_start', 'Persona agents ready');
        else go('prepare_wait', 'Generating persona agents', d.progress);
        break;
      }
      case 'run_start': {
        await client.start(ids.simulation_id, next.platform, next.rounds);
        go('run_wait', 'Simulation running');
        break;
      }
      case 'run_wait': {
        const d = await client.runStatus(ids.simulation_id);
        if (d.runner_status === 'failed') throw new UpstreamError('The simulation failed.');
        if (d.runner_status === 'stopped') throw new UpstreamError('The simulation was stopped on the engine.');
        if (d.runner_status === 'completed') {
          next.stats = { rounds: d.current_round ?? null, actions: d.total_actions_count ?? null };
          go('report_start', 'Simulation complete');
        } else {
          const round = d.current_round != null && d.total_rounds ? ` · round ${d.current_round}/${d.total_rounds}` : '';
          const acts = d.total_actions_count != null ? ` · ${d.total_actions_count} agent actions` : '';
          go('run_wait', `Simulation running${round}${acts}`, d.progress_percent);
        }
        break;
      }
      case 'report_start': {
        const d = await client.generateReport(ids.simulation_id);
        ids.report_id = requireId(d.report_id, 'report');
        if (d.already_generated || d.status === 'completed') go('report_fetch', 'Report ready');
        else { ids.task_id = safeId(d.task_id); go('report_wait', 'ReportAgent writing forecast'); }
        break;
      }
      case 'report_wait': {
        const d = await client.reportStatus(ids.task_id, ids.simulation_id);
        if (d.status === 'failed') throw new UpstreamError('Report generation failed.');
        if (d.status === 'completed') go('report_fetch', 'Report ready');
        else go('report_wait', 'ReportAgent writing forecast', d.progress);
        break;
      }
      case 'report_fetch': {
        const d = await client.report(ids.report_id);
        const markdown = typeof d.markdown_content === 'string' ? d.markdown_content.trim() : '';
        if (!markdown) throw new UpstreamError('The forecast report was empty.');
        next.report = clip(markdown, 200000);
        next.step = 'done';
        next.status = 'completed';
        next.progress = 100;
        next.message = 'Forecast complete';
        break;
      }
      default:
        throw new UpstreamError('Unknown forecast step.');
    }
    next.failures = 0;
  } catch (err) {
    const transient = err instanceof UpstreamError ? err.transient : false;
    const message = err instanceof UpstreamError ? err.message : 'The forecast step could not complete.';
    next.failures = (job.failures || 0) + 1;
    // Only polling steps are safe to retry blindly; kick-off steps could double-submit.
    const isPoll = /_wait$/.test(job.step);
    if (transient && isPoll && next.failures < MAX_POLL_FAILURES) {
      next.message = `${message} Retrying…`;
    } else {
      next.status = 'failed';
      next.message = 'Failed';
      next.error = `${message} (${STAGES.find((s) => s.id === stageOf(job.step))?.label || 'forecast'})`;
    }
  }
  return next;
}

// Is the job waiting on the engine (poll later) rather than ready for its next kick?
export const isWaiting = (job) => /_wait$/.test(job?.step || '');
