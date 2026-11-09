// Browser client for the optional Google Workspace connectors.
// Real OAuth is off until the server reports configured: true.

export const GOOGLE_IDS = ['gmail', 'drive', 'calendar'];

export function connectorMode(remote, id, simulatedOn) {
  if (!GOOGLE_IDS.includes(id) || !remote?.configured) return { mode: 'simulated', on: Boolean(simulatedOn) };
  return { mode: 'google', on: Boolean(remote.connectors?.[id]) };
}

export async function googleStatus() {
  try {
    const res = await fetch('api/google/status');
    const data = await res.json();
    if (!data || data.configured !== true) return { configured: false, connectors: {} };
    return {
      configured: true,
      connectors: {
        gmail: Boolean(data.connectors?.gmail),
        drive: Boolean(data.connectors?.drive),
        calendar: Boolean(data.connectors?.calendar),
      },
    };
  } catch {
    return { configured: false, connectors: {} };
  }
}

export async function googlePost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
