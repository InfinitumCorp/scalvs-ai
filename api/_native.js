// Built-in adapters for apps without open MCP sign-in: Google (Gmail, Calendar, Drive),
// Microsoft 365 (Outlook, calendar, OneDrive) and Slack. Each exposes MCP-shaped tools
// ({name, description, inputSchema, readOnly}) so connectors and agents treat them the
// same as remote MCP servers. Sign-in uses the operator's OAuth app for that provider:
// <APP>_CLIENT_ID and <APP>_CLIENT_SECRET as Worker secrets.

const MAX_TEXT = 20000;
const clip = (s, n = MAX_TEXT) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}\n…(truncated)` : String(s ?? ''));
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });

// OAuth apps. `app` names the env prefix; `services` adds per-connector scopes.
export const APPS = {
  GOOGLE: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    auth_method: 'client_secret_post',
    extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    scopes: {
      gmail: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',
      gcal: 'https://www.googleapis.com/auth/calendar.events',
      gdrive: 'https://www.googleapis.com/auth/drive.readonly',
    },
    console: 'console.cloud.google.com → APIs & Services → Credentials (enable the Gmail, Calendar and Drive APIs)',
  },
  MICROSOFT: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    auth_method: 'client_secret_post',
    scopes: { m365: 'offline_access User.Read Mail.ReadWrite Calendars.Read Files.Read' },
    console: 'entra.microsoft.com → App registrations',
  },
  SLACK: {
    authorize: 'https://slack.com/oauth/v2/authorize',
    token: 'https://slack.com/api/oauth.v2.access',
    auth_method: 'client_secret_post',
    scopeParam: 'user_scope', // act as the signing-in user, not a bot
    scopes: { slack: 'channels:read groups:read channels:history groups:history search:read chat:write users:read' },
    // Slack returns the user token under authed_user
    readToken: (d) => ({ ...d, access_token: d.authed_user?.access_token || d.access_token, refresh_token: d.authed_user?.refresh_token || d.refresh_token, expires_in: d.authed_user?.expires_in || d.expires_in }),
    console: 'api.slack.com/apps → OAuth & Permissions',
  },
  ASANA: {
    authorize: 'https://app.asana.com/-/oauth_authorize',
    token: 'https://app.asana.com/-/oauth_token',
    auth_method: 'client_secret_post',
    scopes: { asana: '' },
    console: 'app.asana.com/0/my-apps → Create new app → OAuth',
  },
  GITHUB: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    auth_method: 'client_secret_post',
    scopes: { github: 'repo read:org read:user' },
    console: 'github.com/settings/developers → OAuth Apps',
  },
};
export const PROVIDER_APP = { google: 'GOOGLE', microsoft: 'MICROSOFT', slack: 'SLACK' };

async function api(token, url, init = {}) {
  const r = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...init.headers },
    signal: AbortSignal.timeout(20000),
  });
  if (r.status === 401) { const e = new Error('Sign-in expired'); e.auth = true; throw e; }
  if (!r.ok) throw new Error(`${new URL(url).hostname} answered ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return r;
}
const getJson = async (token, url, init) => (await api(token, url, init)).json();

const b64urlUtf8 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s) => new TextDecoder().decode(Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

// ---------- Google ----------
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
function gmailBody(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return fromB64url(part.body.data);
  for (const p of part.parts || []) { const t = gmailBody(p); if (t) return t; }
  if (part.mimeType === 'text/html' && part.body?.data) return fromB64url(part.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  return '';
}

const google = {
  gmail: [
    { name: 'gmail_search', readOnly: true, description: 'Search Gmail with Gmail query syntax (e.g. "from:anna newer_than:7d"). Returns id, from, subject, date and snippet.',
      inputSchema: obj({ query: str('Gmail search query'), max: num('Max results, 1-20 (default 10)') }),
      async run(t, a) {
        const list = await getJson(t, `${GMAIL}/messages?${new URLSearchParams({ q: a.query || '', maxResults: String(Math.min(20, a.max || 10)) })}`);
        const msgs = await Promise.all((list.messages || []).map((m) => getJson(t, `${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`)));
        return msgs.map((m) => `id: ${m.id}\nfrom: ${header(m, 'From')}\nsubject: ${header(m, 'Subject')}\ndate: ${header(m, 'Date')}\n${m.snippet}`).join('\n\n') || 'No messages found.';
      } },
    { name: 'gmail_read', readOnly: true, description: 'Read one email by id (from gmail_search).',
      inputSchema: obj({ id: str('Message id') }, ['id']),
      async run(t, a) {
        const m = await getJson(t, `${GMAIL}/messages/${encodeURIComponent(a.id)}?format=full`);
        return clip(`from: ${header(m, 'From')}\nto: ${header(m, 'To')}\nsubject: ${header(m, 'Subject')}\ndate: ${header(m, 'Date')}\n\n${gmailBody(m.payload)}`);
      } },
    { name: 'gmail_create_draft', readOnly: false, description: 'Create a Gmail draft (not sent). The user reviews and sends it.',
      inputSchema: obj({ to: str('Recipient email'), subject: str('Subject'), body: str('Plain-text body') }, ['to', 'subject', 'body']),
      async run(t, a) {
        const raw = b64urlUtf8(`To: ${a.to}\r\nSubject: =?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(a.subject)))}?=\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${a.body}`);
        const d = await getJson(t, `${GMAIL}/drafts`, { method: 'POST', body: JSON.stringify({ message: { raw } }) });
        return `Draft created (id ${d.id}). Open Gmail → Drafts to review and send.`;
      } },
  ],
  gcal: [
    { name: 'calendar_list_events', readOnly: true, description: 'List events on the primary calendar. Defaults to the next 7 days.',
      inputSchema: obj({ from: str('ISO start (default now)'), to: str('ISO end (default +7 days)'), query: str('Text to match'), max: num('Max events, 1-50') }),
      async run(t, a) {
        const p = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: String(Math.min(50, a.max || 20)),
          timeMin: new Date(a.from || Date.now()).toISOString(), timeMax: new Date(a.to || Date.now() + 7 * 864e5).toISOString() });
        if (a.query) p.set('q', a.query);
        const d = await getJson(t, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${p}`);
        return (d.items || []).map((e) => `${e.start?.dateTime || e.start?.date} → ${e.end?.dateTime || e.end?.date}  ${e.summary || '(no title)'}${e.location ? ` @ ${e.location}` : ''}${e.attendees?.length ? `\n  with ${e.attendees.map((x) => x.email).join(', ')}` : ''}`).join('\n') || 'No events in that range.';
      } },
    { name: 'calendar_create_event', readOnly: false, description: 'Create an event on the primary calendar. Attendees are not emailed.',
      inputSchema: obj({ summary: str('Title'), start: str('ISO start'), end: str('ISO end'), description: str('Notes'), attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee emails' } }, ['summary', 'start', 'end']),
      async run(t, a) {
        const e = await getJson(t, 'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none', { method: 'POST', body: JSON.stringify({
          summary: a.summary, description: a.description, start: { dateTime: new Date(a.start).toISOString() }, end: { dateTime: new Date(a.end).toISOString() },
          attendees: (a.attendees || []).map((email) => ({ email })) }) });
        return `Event created: ${e.htmlLink}`;
      } },
  ],
  gdrive: [
    { name: 'drive_search', readOnly: true, description: 'Full-text search Google Drive. Returns id, name, type and link.',
      inputSchema: obj({ query: str('Words to search for'), max: num('Max files, 1-25') }, ['query']),
      async run(t, a) {
        const q = `fullText contains '${String(a.query).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and trashed = false`;
        const d = await getJson(t, `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, pageSize: String(Math.min(25, a.max || 10)), fields: 'files(id,name,mimeType,modifiedTime,webViewLink)' })}`);
        return (d.files || []).map((f) => `id: ${f.id}\n${f.name} (${f.mimeType.split('.').pop()}, modified ${f.modifiedTime})\n${f.webViewLink}`).join('\n\n') || 'No files found.';
      } },
    { name: 'drive_read', readOnly: true, description: 'Read a Drive file as text: Docs and Slides as text, Sheets as CSV, text files as-is.',
      inputSchema: obj({ id: str('File id from drive_search') }, ['id']),
      async run(t, a) {
        const id = encodeURIComponent(a.id);
        const f = await getJson(t, `https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType`);
        const exportAs = { 'application/vnd.google-apps.document': 'text/plain', 'application/vnd.google-apps.presentation': 'text/plain', 'application/vnd.google-apps.spreadsheet': 'text/csv' }[f.mimeType];
        let r;
        if (exportAs) r = await api(t, `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportAs)}`);
        else if (/^text\/|json|xml|csv|markdown/.test(f.mimeType)) r = await api(t, `https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
        else return `${f.name} is a ${f.mimeType} file; only documents, sheets, slides and text files can be read.`;
        return clip(`# ${f.name}\n\n${await r.text()}`);
      } },
  ],
};

// ---------- Microsoft 365 ----------
const GRAPH = 'https://graph.microsoft.com/v1.0';
const microsoft = {
  m365: [
    { name: 'outlook_search', readOnly: true, description: 'Search Outlook mail (or list the latest when no query). Returns id, from, subject, date and preview.',
      inputSchema: obj({ query: str('Search words'), max: num('Max results, 1-25') }),
      async run(t, a) {
        const top = Math.min(25, a.max || 10);
        const url = a.query
          ? `${GRAPH}/me/messages?$search=${encodeURIComponent(`"${String(a.query).replace(/"/g, '')}"`)}&$top=${top}&$select=id,subject,from,receivedDateTime,bodyPreview`
          : `${GRAPH}/me/messages?$top=${top}&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview`;
        const d = await getJson(t, url);
        return (d.value || []).map((m) => `id: ${m.id}\nfrom: ${m.from?.emailAddress?.address}\nsubject: ${m.subject}\ndate: ${m.receivedDateTime}\n${m.bodyPreview}`).join('\n\n') || 'No messages found.';
      } },
    { name: 'outlook_read', readOnly: true, description: 'Read one Outlook email by id.',
      inputSchema: obj({ id: str('Message id') }, ['id']),
      async run(t, a) {
        const m = await getJson(t, `${GRAPH}/me/messages/${encodeURIComponent(a.id)}?$select=subject,from,toRecipients,receivedDateTime,body`, { headers: { prefer: 'outlook.body-content-type="text"' } });
        return clip(`from: ${m.from?.emailAddress?.address}\nto: ${(m.toRecipients || []).map((r) => r.emailAddress?.address).join(', ')}\nsubject: ${m.subject}\ndate: ${m.receivedDateTime}\n\n${m.body?.content || ''}`);
      } },
    { name: 'outlook_create_draft', readOnly: false, description: 'Create an Outlook draft (not sent).',
      inputSchema: obj({ to: str('Recipient email'), subject: str('Subject'), body: str('Plain-text body') }, ['to', 'subject', 'body']),
      async run(t, a) {
        await getJson(t, `${GRAPH}/me/messages`, { method: 'POST', body: JSON.stringify({ subject: a.subject, body: { contentType: 'Text', content: a.body }, toRecipients: [{ emailAddress: { address: a.to } }] }) });
        return 'Draft created in Outlook → Drafts.';
      } },
    { name: 'outlook_calendar_events', readOnly: true, description: 'List calendar events. Defaults to the next 7 days.',
      inputSchema: obj({ from: str('ISO start'), to: str('ISO end') }),
      async run(t, a) {
        const p = new URLSearchParams({ startDateTime: new Date(a.from || Date.now()).toISOString(), endDateTime: new Date(a.to || Date.now() + 7 * 864e5).toISOString(), $top: '50', $select: 'subject,start,end,location,organizer', $orderby: 'start/dateTime' });
        const d = await getJson(t, `${GRAPH}/me/calendarView?${p}`);
        return (d.value || []).map((e) => `${e.start?.dateTime} → ${e.end?.dateTime} (${e.start?.timeZone})  ${e.subject}${e.location?.displayName ? ` @ ${e.location.displayName}` : ''}`).join('\n') || 'No events in that range.';
      } },
    { name: 'onedrive_search', readOnly: true, description: 'Search OneDrive files.',
      inputSchema: obj({ query: str('Words to search for') }, ['query']),
      async run(t, a) {
        const d = await getJson(t, `${GRAPH}/me/drive/root/search(q='${encodeURIComponent(String(a.query).replace(/'/g, "''"))}')?$top=20&$select=id,name,webUrl,file,lastModifiedDateTime`);
        return (d.value || []).map((f) => `id: ${f.id}\n${f.name} (modified ${f.lastModifiedDateTime})\n${f.webUrl}`).join('\n\n') || 'No files found.';
      } },
    { name: 'onedrive_read', readOnly: true, description: 'Read a OneDrive text file (txt, md, csv, json…).',
      inputSchema: obj({ id: str('File id from onedrive_search') }, ['id']),
      async run(t, a) {
        const f = await getJson(t, `${GRAPH}/me/drive/items/${encodeURIComponent(a.id)}?$select=name,file`);
        if (!/^text\/|json|xml|csv/.test(f.file?.mimeType || '')) return `${f.name} is a ${f.file?.mimeType || 'binary'} file; only text files can be read here.`;
        return clip(`# ${f.name}\n\n${await (await api(t, `${GRAPH}/me/drive/items/${encodeURIComponent(a.id)}/content`)).text()}`);
      } },
  ],
};

// ---------- Slack ----------
async function slackApi(t, method, params = {}, post = false) {
  const r = post
    ? await api(t, `https://slack.com/api/${method}`, { method: 'POST', body: JSON.stringify(params), headers: { 'content-type': 'application/json; charset=utf-8' } })
    : await api(t, `https://slack.com/api/${method}?${new URLSearchParams(params)}`);
  const d = await r.json();
  if (!d.ok) { const e = new Error(`Slack: ${d.error}`); if (['invalid_auth', 'token_expired', 'token_revoked'].includes(d.error)) e.auth = true; throw e; }
  return d;
}
const slack = {
  slack: [
    { name: 'slack_list_channels', readOnly: true, description: 'List channels you can see (id and name).',
      inputSchema: obj({}),
      async run(t) {
        const d = await slackApi(t, 'conversations.list', { types: 'public_channel,private_channel', limit: '200', exclude_archived: 'true' });
        return d.channels.map((c) => `${c.id}  #${c.name}${c.is_private ? ' (private)' : ''}`).join('\n') || 'No channels.';
      } },
    { name: 'slack_read_channel', readOnly: true, description: 'Read recent messages in a channel.',
      inputSchema: obj({ channel: str('Channel id from slack_list_channels'), limit: num('Messages, 1-100 (default 30)') }, ['channel']),
      async run(t, a) {
        const d = await slackApi(t, 'conversations.history', { channel: a.channel, limit: String(Math.min(100, a.limit || 30)) });
        return clip(d.messages.reverse().map((m) => `[${new Date(Number(m.ts) * 1000).toISOString()}] ${m.user || m.bot_id || '?'}: ${m.text}`).join('\n')) || 'No messages.';
      } },
    { name: 'slack_search', readOnly: true, description: 'Search messages across Slack.',
      inputSchema: obj({ query: str('Slack search query') }, ['query']),
      async run(t, a) {
        const d = await slackApi(t, 'search.messages', { query: a.query, count: '20' });
        return (d.messages?.matches || []).map((m) => `#${m.channel?.name} ${m.username}: ${m.text}\n${m.permalink}`).join('\n\n') || 'No matches.';
      } },
    { name: 'slack_post_message', readOnly: false, description: 'Post a message to a channel as you.',
      inputSchema: obj({ channel: str('Channel id'), text: str('Message text') }, ['channel', 'text']),
      async run(t, a) {
        const d = await slackApi(t, 'chat.postMessage', { channel: a.channel, text: a.text }, true);
        return `Posted to ${d.channel} at ${d.ts}.`;
      } },
  ],
};

const PROVIDERS = { google, microsoft, slack };

export function nativeTools(entry) {
  return (PROVIDERS[entry.provider]?.[entry.service] || []).map(({ run, ...t }) => t);
}

export async function runNativeTool(entry, token, name, args) {
  const tool = PROVIDERS[entry.provider]?.[entry.service]?.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool ${name}`);
  return { text: String(await tool.run(token, args || {})), isError: false };
}
