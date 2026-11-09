// Connector catalog, shared by the Connect page and the Worker (api/connectors.js).
//
// kind:
//   mcp     a remote MCP server (Streamable HTTP). Signs in with MCP OAuth (discovery,
//           dynamic client registration, PKCE), with a pre-registered OAuth app
//           (`app`, read from <APP>_CLIENT_ID / <APP>_CLIENT_SECRET), or with a pasted token.
//   native  an app without open MCP sign-in, served by a built-in adapter in api/_native.js.
//   builtin an Infinitum product that runs inside the same platform; no sign-in.
//
// Remote MCP URLs are the vendors' published endpoints. Anyone can add any other
// MCP server as a custom connector.

export const CONNECTOR_GROUPS = ['Your world', 'Directory', 'Infinitum Nexus'];

export const CATALOG = [
  // ---- Your world: the everyday accounts agents work in ----
  { id: 'gmail', name: 'Gmail', group: 'Your world', kind: 'native', provider: 'google', service: 'gmail', desc: 'Search and read email, draft replies for approval.' },
  { id: 'gcal', name: 'Google Calendar', group: 'Your world', kind: 'native', provider: 'google', service: 'gcal', desc: 'See your schedule and propose meetings.' },
  { id: 'gdrive', name: 'Google Drive', group: 'Your world', kind: 'native', provider: 'google', service: 'gdrive', desc: 'Search and read Docs, Sheets and files as source material.' },
  { id: 'slack', name: 'Slack', group: 'Your world', kind: 'native', provider: 'slack', service: 'slack', desc: 'Read channels, search messages, post updates.' },
  { id: 'github', name: 'GitHub', group: 'Your world', kind: 'mcp', url: 'https://api.githubcopilot.com/mcp/', app: 'GITHUB', token: true,
    tokenHelp: 'Paste a GitHub personal access token (github.com → Settings → Developer settings → Fine-grained tokens).',
    desc: 'Repositories, issues, pull requests and code.' },
  { id: 'm365', name: 'Microsoft 365', group: 'Your world', kind: 'native', provider: 'microsoft', service: 'm365', desc: 'Outlook mail and calendar, OneDrive files.' },

  // ---- Directory: the remote MCP connectors offered in Claude ----
  { id: 'notion', name: 'Notion', group: 'Directory', kind: 'mcp', url: 'https://mcp.notion.com/mcp', desc: 'Search, read and update pages and databases.' },
  { id: 'linear', name: 'Linear', group: 'Directory', kind: 'mcp', url: 'https://mcp.linear.app/mcp', desc: 'Issues, projects and cycles.' },
  { id: 'atlassian', name: 'Atlassian', group: 'Directory', kind: 'mcp', url: 'https://mcp.atlassian.com/v1/mcp', desc: 'Jira issues and Confluence pages.' },
  { id: 'asana', name: 'Asana', group: 'Directory', kind: 'mcp', url: 'https://mcp.asana.com/v2/mcp', app: 'ASANA', appOnly: true, desc: 'Tasks, projects and goals.' },
  { id: 'monday', name: 'monday.com', group: 'Directory', kind: 'mcp', url: 'https://mcp.monday.com/mcp', desc: 'Boards, items and updates.' },
  { id: 'intercom', name: 'Intercom', group: 'Directory', kind: 'mcp', url: 'https://mcp.intercom.com/mcp', desc: 'Conversations and customer data.' },
  { id: 'stripe', name: 'Stripe', group: 'Directory', kind: 'mcp', url: 'https://mcp.stripe.com', token: true,
    tokenHelp: 'Or paste a restricted Stripe API key (dashboard.stripe.com → Developers → API keys).', desc: 'Customers, payments, invoices and docs.' },
  { id: 'paypal', name: 'PayPal', group: 'Directory', kind: 'mcp', url: 'https://mcp.paypal.com/mcp', desc: 'Invoices, orders and transactions.' },
  { id: 'figma', name: 'Figma', group: 'Directory', kind: 'mcp', url: 'https://mcp.figma.com/mcp', desc: 'Design files, components and variables.' },
  { id: 'canva', name: 'Canva', group: 'Directory', kind: 'mcp', url: 'https://mcp.canva.com/mcp', desc: 'Find, create and export designs.' },
  { id: 'wix', name: 'Wix', group: 'Directory', kind: 'mcp', url: 'https://mcp.wix.com/mcp', desc: 'Sites, stores and bookings.' },
  { id: 'sentry', name: 'Sentry', group: 'Directory', kind: 'mcp', url: 'https://mcp.sentry.dev/mcp', desc: 'Errors, issues and releases.' },
  { id: 'posthog', name: 'PostHog', group: 'Directory', kind: 'mcp', url: 'https://mcp.posthog.com/mcp', desc: 'Product analytics, flags and insights.' },
  { id: 'cloudflare', name: 'Cloudflare', group: 'Directory', kind: 'mcp', url: 'https://bindings.mcp.cloudflare.com/mcp', desc: 'Workers, KV, R2 and D1.' },
  { id: 'vercel', name: 'Vercel', group: 'Directory', kind: 'mcp', url: 'https://mcp.vercel.com', desc: 'Projects, deployments and logs.' },
  { id: 'supabase', name: 'Supabase', group: 'Directory', kind: 'mcp', url: 'https://mcp.supabase.com/mcp', desc: 'Databases, tables and edge functions.' },
  { id: 'neon', name: 'Neon', group: 'Directory', kind: 'mcp', url: 'https://mcp.neon.tech/mcp', desc: 'Serverless Postgres projects and queries.' },
  { id: 'huggingface', name: 'Hugging Face', group: 'Directory', kind: 'mcp', url: 'https://huggingface.co/mcp', desc: 'Models, datasets, Spaces and papers.' },
  { id: 'deepwiki', name: 'DeepWiki', group: 'Directory', kind: 'mcp', url: 'https://mcp.deepwiki.com/mcp', auth: 'none', desc: 'Ask questions about any public GitHub repository.' },
  { id: 'context7', name: 'Context7', group: 'Directory', kind: 'mcp', url: 'https://mcp.context7.com/mcp', auth: 'none', desc: 'Up-to-date library and API docs.' },
  { id: 'cfdocs', name: 'Cloudflare Docs', group: 'Directory', kind: 'mcp', url: 'https://docs.mcp.cloudflare.com/mcp', auth: 'none', desc: 'Search Cloudflare documentation.' },

  // ---- Infinitum Nexus: products on the same platform ----
  { id: 'cumulus', name: 'Cumulus://Cloud', group: 'Infinitum Nexus', kind: 'builtin', desc: 'Agent runtime, storage and data licensing.' },
  { id: 'cndctr', name: '/CNDCTR/', group: 'Infinitum Nexus', kind: 'builtin', desc: 'Coordinate agents into verified workflows.' },
  { id: 'spectre', name: '+SPCTR', group: 'Infinitum Nexus', kind: 'builtin', desc: 'The AI sales team and account memory.' },
  { id: 'veil', name: 'VEIL</>', group: 'Infinitum Nexus', kind: 'builtin', desc: 'Browser sidebar assistant.' },
  { id: 'metatron', name: 'METATRON¹⁰⁰', group: 'Infinitum Nexus', kind: 'builtin', desc: 'Research and prediction engine.' },
  { id: 'firm', name: 'FIRM Wallet', group: 'Infinitum Nexus', kind: 'builtin', desc: 'Holds $SCLV rewards (simulated here).' },
];

export const findConnector = (id) => CATALOG.find((c) => c.id === id);

// Read-only tools are on for agents by default; anything that writes starts off.
const READ_VERBS = /^(get|list|search|read|fetch|find|query|retrieve|describe|lookup|view|show|count|resolve|ask|browse|check)/i;
export function isReadOnlyTool(tool) {
  const a = tool?.annotations || {};
  if (typeof a.readOnlyHint === 'boolean') return a.readOnlyHint;
  if (typeof tool?.readOnly === 'boolean') return tool.readOnly;
  const name = String(tool?.name || '');
  // also matches prefixed names such as "notion-search" or "gmail_read"
  return READ_VERBS.test(name) || READ_VERBS.test(name.replace(/^[a-z0-9]+[_-]/i, ''));
}
