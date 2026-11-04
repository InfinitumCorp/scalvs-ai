// Static catalog data for the SCALVS.ai prototype.

export const PLANS = {
  free: { label: 'Free', agents: 2, credits: 200, ads: 'Optional', workflow: 'Basic', deploy: 'Shared cloud' },
  pro: { label: 'Pro', agents: 10, credits: 2000, ads: 'None', workflow: 'Advanced', deploy: 'Shared cloud' },
  business: { label: 'Business', agents: 50, credits: 20000, ads: 'None', workflow: 'Team-wide', deploy: 'Isolated tenant option' },
  government: { label: 'Government', agents: 500, credits: 100000, ads: 'None', workflow: 'Controlled', deploy: 'Dedicated environment' },
};

export const TEMPLATES = [
  {
    id: 'research', name: 'Researcher', glyph: 'R',
    role: 'Research analyst who gathers, compares and summarizes information with sources',
    tools: ['Web search', 'METATRON¹⁰⁰', 'Cumulus://Cloud files'],
    example: 'Compare the top three open-source vector databases for a 10M-document workload.',
  },
  {
    id: 'writer', name: 'Writer', glyph: 'W',
    role: 'Writer who drafts clear documents, posts and briefs in the house voice',
    tools: ['Cumulus://Cloud files', 'VEIL</> sidebar'],
    example: 'Draft a one-page brief announcing our new support hours to customers.',
  },
  {
    id: 'coder', name: 'Coder', glyph: 'C',
    role: 'Software engineer who writes, reviews and explains code',
    tools: ['GitHub', '/CNDCTR/'],
    example: 'Write a TypeScript function that de-duplicates contacts by normalized email.',
  },
  {
    id: 'sales', name: 'Sales rep', glyph: 'S',
    role: 'Sales development rep who researches accounts and drafts outreach for approval',
    tools: ['+SPCTR CRM', 'Email', 'Web search'],
    example: 'Research a mid-size logistics company and draft a first-touch email for approval.',
  },
  {
    id: 'ops', name: 'Operator', glyph: 'O',
    role: 'Operations agent who turns repeatable processes into checklists and status reports',
    tools: ['Slack', 'Cumulus://Cloud files', '/CNDCTR/'],
    example: 'Turn our weekly vendor-invoice review into a step-by-step checklist.',
  },
  {
    id: 'support', name: 'Support', glyph: 'H',
    role: 'Customer support agent who answers tickets accurately and escalates edge cases',
    tools: ['Email', 'Knowledge base', 'FABRIC smart replies'],
    example: 'Reply to a customer who was double-charged and wants a refund.',
  },
];

export const ALL_TOOLS = [
  'Web search', 'Email', 'Slack', 'GitHub', 'Knowledge base',
  'Cumulus://Cloud files', 'METATRON¹⁰⁰', '+SPCTR CRM', '/CNDCTR/', 'VEIL</> sidebar', 'FABRIC smart replies',
];

export const CONNECTORS = [
  { id: 'gmail', name: 'Email', group: 'Your world', desc: 'Read threads and draft replies for approval.' },
  { id: 'slack', name: 'Slack', group: 'Your world', desc: 'Post updates and answer questions in channels.' },
  { id: 'github', name: 'GitHub', group: 'Your world', desc: 'Open issues, review pull requests, read code.' },
  { id: 'drive', name: 'Docs & files', group: 'Your world', desc: 'Use documents as source material.' },
  { id: 'calendar', name: 'Calendar', group: 'Your world', desc: 'Schedule follow-ups and meetings.' },
  { id: 'cumulus', name: 'Cumulus://Cloud', group: 'Infinitum Nexus', desc: 'Agent runtime, storage and data licensing.' },
  { id: 'cndctr', name: '/CNDCTR/', group: 'Infinitum Nexus', desc: 'Coordinate agents into verified workflows.' },
  { id: 'spectre', name: '+SPCTR', group: 'Infinitum Nexus', desc: 'The AI sales team and account memory.' },
  { id: 'veil', name: 'VEIL</>', group: 'Infinitum Nexus', desc: 'Browser sidebar assistant.' },
  { id: 'metatron', name: 'METATRON¹⁰⁰', group: 'Infinitum Nexus', desc: 'Research and prediction engine.' },
  { id: 'firm', name: 'FIRM Wallet', group: 'Infinitum Nexus', desc: 'Holds $SCLV rewards (simulated here).' },
];

export const DATASETS = [
  { id: 'ds-prompts', name: 'Anonymized workflow templates', size: '1.2k records', price: 40 },
  { id: 'ds-research', name: 'Research summaries (public sources)', size: '380 documents', price: 65 },
  { id: 'ds-support', name: 'Redacted support resolutions', size: '2.4k tickets', price: 90 },
];

export const REWARD_RULES = {
  creditsPerRun: 12,          // AI credits consumed per agent step (simulated)
  activityPerVerified: 5,     // activity credits per verified run
  sclvPerVerified: 2,         // $SCLV per verified contribution
  sclvWeeklyCap: 50,          // capped rewards: value is real, not farmed
  dataShare: 0.85,            // keep 85% of every verified data sale
  adSharePerDay: 0.4,         // simulated ad revenue share (USD) when opted in
};
