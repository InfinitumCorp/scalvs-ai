// OAuth 2.1 for connectors, following the MCP authorization spec:
//   RFC 9728 protected-resource metadata -> RFC 8414 / OIDC authorization-server metadata
//   -> RFC 7591 dynamic client registration (unless a pre-registered app is configured)
//   -> authorization code + PKCE (S256) with the RFC 8707 `resource` indicator -> refresh.
import { checkUrl, randomId, sha256 } from './_vault.js';

const T = 12000;
const getJson = async (url, env) => {
  checkUrl(url, env);
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(T) });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
};

// Where to sign in for an MCP server. `wwwAuthenticate` comes from its 401, when we have one.
export async function discover(mcpUrl, wwwAuthenticate, env) {
  const u = new URL(mcpUrl);
  const hinted = (String(wwwAuthenticate || '').match(/resource_metadata="([^"]+)"/) || [])[1];
  const prmCandidates = [hinted,
    `${u.origin}/.well-known/oauth-protected-resource${u.pathname.replace(/\/$/, '')}`,
    `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean);
  let prm = null;
  for (const c of [...new Set(prmCandidates)]) { prm = await getJson(c, env).catch(() => null); if (prm) break; }

  const issuer = new URL(prm?.authorization_servers?.[0] || u.origin);
  const path = issuer.pathname.replace(/\/$/, '');
  const asCandidates = path
    ? [`${issuer.origin}/.well-known/oauth-authorization-server${path}`, `${issuer.origin}/.well-known/openid-configuration${path}`, `${issuer.origin}${path}/.well-known/openid-configuration`]
    : [`${issuer.origin}/.well-known/oauth-authorization-server`, `${issuer.origin}/.well-known/openid-configuration`];
  let as = null;
  for (const c of asCandidates) { as = await getJson(c, env).catch(() => null); if (as?.authorization_endpoint && as?.token_endpoint) break; as = null; }
  if (!as) return null;
  for (const k of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) if (as[k]) checkUrl(as[k], env);
  return {
    resource: prm?.resource || `${u.origin}${u.pathname}`,
    authorization_endpoint: as.authorization_endpoint,
    token_endpoint: as.token_endpoint,
    registration_endpoint: as.registration_endpoint || null,
    scopes: prm?.scopes_supported || as.scopes_supported || [],
    auth_methods: as.token_endpoint_auth_methods_supported || ['client_secret_basic'],
  };
}

export async function register(meta, redirectUri, env) {
  checkUrl(meta.registration_endpoint, env);
  const publicOk = meta.auth_methods.includes('none');
  const r = await fetch(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    signal: AbortSignal.timeout(T),
    body: JSON.stringify({
      client_name: 'SCALVS.ai',
      client_uri: new URL(redirectUri).origin,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: publicOk ? 'none' : 'client_secret_post',
    }),
  });
  if (!r.ok) throw new Error(`The connector refused app registration (${r.status})`);
  const c = await r.json();
  if (!c.client_id) throw new Error('The connector did not return a client id');
  return { client_id: c.client_id, client_secret: c.client_secret || null, auth_method: c.token_endpoint_auth_method || (publicOk ? 'none' : 'client_secret_post') };
}

export async function pkce() {
  const verifier = randomId(48);
  return { verifier, challenge: await sha256(verifier) };
}

export function authorizeUrl({ endpoint, clientId, redirectUri, state, challenge, scope, resource, extra = {} }) {
  const u = new URL(endpoint);
  const p = { response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256', ...extra };
  if (scope) p.scope = scope;
  if (resource) p.resource = resource;
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
  return u.toString();
}

async function tokenRequest(endpoint, client, params, env) {
  checkUrl(endpoint, env);
  const body = new URLSearchParams(params);
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (client.client_secret && client.auth_method === 'client_secret_basic') {
    headers.authorization = `Basic ${btoa(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`)}`;
  } else {
    body.set('client_id', client.client_id);
    if (client.client_secret) body.set('client_secret', client.client_secret);
  }
  const r = await fetch(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(T) });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = Object.fromEntries(new URLSearchParams(text)); }
  if (!r.ok || data.error) throw new Error(`Sign-in failed: ${data.error_description || data.error || r.status}`);
  return data;
}

export const tokenSet = (data, previous = {}) => ({
  access_token: data.access_token,
  refresh_token: data.refresh_token || previous.refresh_token || null,
  expires_at: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null,
  scope: data.scope || previous.scope || null,
});

export async function exchangeCode({ endpoint, client, code, verifier, redirectUri, resource }, env) {
  const params = { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier };
  if (resource) params.resource = resource;
  return tokenRequest(endpoint, client, params, env);
}

export async function refreshTokens({ endpoint, client, tokens, resource }, env) {
  if (!tokens?.refresh_token) throw new Error('Session expired. Reconnect this connector.');
  const params = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token };
  if (resource) params.resource = resource;
  return tokenSet(await tokenRequest(endpoint, client, params, env), tokens);
}

export const expiresSoon = (tokens) => Boolean(tokens?.expires_at && tokens.expires_at - Date.now() < 60000);
