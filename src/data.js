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

// Connectors live in src/connectors.js (shared with the Worker).


export const DATASETS = [
  { id: 'ds-prompts', name: 'Anonymized workflow templates', size: '1.2k records', price: 40 },
  { id: 'ds-research', name: 'Research summaries (public sources)', size: '380 documents', price: 65 },
  { id: 'ds-support', name: 'Redacted support resolutions', size: '2.4k tickets', price: 90 },
];

export const REWARD_RULES = {
  creditsPerRun: 12,          // AI credits consumed per agent step (simulated)
  creditsPerForecast: 60,     // AI credits per CONJURE™ forecast (simulated)
  activityPerVerified: 5,     // activity credits per verified run
  sclvPerVerified: 2,         // $SCLV per verified contribution
  sclvWeeklyCap: 50,          // capped rewards: value is real, not farmed
  dataShare: 0.85,            // keep 85% of every verified data sale
  adSharePerDay: 0.4,         // simulated ad revenue share (USD) when opted in
};

// CONJURE™ (the Infinitum prediction model) use cases: one per Infinitum product.
// Choosing a product tags the forecast and pre-fills a starting question.
export const FORECAST_PRESETS = [
  { product: 'SCALVS.ai', question: 'How will our target audience react to this launch over the first two weeks, and which objections will spread fastest?' },
  { product: '+SPCTR', question: 'How are our key accounts likely to respond to this pricing or contract change, and which relationships are most at risk?' },
  { product: 'METATRON¹⁰⁰', question: 'How will public opinion evolve after this announcement, and what are the most likely best, base and worst cases?' },
  { product: '/CNDCTR/', question: 'Before we execute this plan, how will the affected stakeholders react, and what should we change first?' },
  { product: 'ODIN°', question: 'How will partner organizations and oversight bodies respond to this policy or procurement decision, and where will support or resistance form?' },
  { product: '>_ARGUS', question: 'How will local communities and regulators react to this sensor deployment, and which privacy concerns need answering first?' },
  { product: 'ÆTHER', question: 'How will security teams and end users react to this change in our secure network, and what will slow adoption?' },
  { product: 'Cumulus://Cloud', question: 'How will developers and businesses react to this pricing or data-exchange change, and who is most likely to migrate away?' },
  { product: 'DAEMON', question: 'How will nearby communities, regulators and the press react to this planned flight-test program, and which concerns will dominate?' },
  { product: 'ei·det·ic', question: 'How will the public and privacy advocates react to this consent and purpose-control policy, and what would build trust fastest?' },
  { product: 'E(O)N', question: 'How will field teams react to wearing this device every day, and which comfort, privacy or usability objections come first?' },
  { product: 'FABRIC', question: 'How will users react to this change in messaging features or the opt-in data economy, and which groups are most likely to leave?' },
  { product: 'FIRM Wallet', question: 'How will token holders and the crypto community react to this wallet or exchange update, and what misunderstandings will spread?' },
  { product: 'Firmament Network', question: 'How will developers and partner products react to this protocol or governance change, and where will pushback come from?' },
  { product: 'Flower', question: 'How will site operators react to installing this base station, and what operational concerns will they raise?' },
  { product: '[HRVST]', question: 'How will capturers and the public react to this data-licensing offer, and which privacy concerns will decide uptake?' },
  { product: 'ORBIS', question: 'How will inspection crews and safety managers react to using this drone indoors, and which objections block adoption?' },
  { product: 'POLLEN', question: 'How will the public and regulators react to a swarm demonstration, and which messages reduce concern?' },
  { product: 'SLUG', question: 'How will crews and site managers react to working alongside this autonomous ground vehicle, and what will they push back on?' },
  { product: '#THRONE', question: 'How will buyers react to this computer launch and price point, and which competing products will they compare it with?' },
  { product: 'VEIL</>', question: 'How will privacy-focused users react to this browser update or $VEIL rewards change, and what will they distrust?' },
];
