/**
 * Tool Mock Fixtures for Agent Evals
 *
 * Provides deterministic, serializable mock responses for tools that would
 * otherwise require network access or credentials. Each eval can specify
 * per-tool mocks via the `toolMocks` field on AgentEval; this module
 * provides the reusable fixture data and a `buildMockPayload()` helper
 * that merges eval-specific mocks with sensible defaults.
 */

// ---------------------------------------------------------------------------
// Serializable mock spec types (sent over HTTP to POST /agent/tool-mocks)
// ---------------------------------------------------------------------------

export type ToolMockSpec =
  | { type: 'static'; response: any; description?: string; paramKeys?: string[]; hidden?: boolean }
  | { type: 'pattern'; patterns: Array<{ match: Record<string, string>; response: any }>; default?: any; description?: string; paramKeys?: string[]; hidden?: boolean }

export type ToolMockMap = Record<string, ToolMockSpec>

// ---------------------------------------------------------------------------
// Default mock responses (safe fallbacks)
// ---------------------------------------------------------------------------

const DEFAULT_WEB_FETCH: ToolMockSpec = {
  type: 'static',
  response: {
    content: '<html><body><h1>Mock Page</h1><p>This is a mocked web page for eval testing.</p></body></html>',
    status: 200,
    bytes: 120,
    url: 'https://example.com',
  },
}

const DEFAULT_EXEC: ToolMockSpec = {
  type: 'static',
  response: {
    stdout: '',
    stderr: '',
    exitCode: 0,
  },
}

const DEFAULT_SEND_MESSAGE: ToolMockSpec = {
  type: 'static',
  response: { ok: true, delivered: true, channel: 'mock-channel' },
}

const DEFAULT_MCP_FALLBACK: ToolMockSpec = {
  type: 'static',
  response: { ok: true, data: [] },
}

// ---------------------------------------------------------------------------
// Fixture: Competitive Intelligence Dashboard (Case 1)
// ---------------------------------------------------------------------------

export const COMPETITIVE_INTEL_MOCKS: ToolMockMap = {
  web: {
    type: 'pattern',
    patterns: [
      {
        match: { url: 'vercel' },
        response: {
          content: `<html><head><title>Vercel Pricing</title></head><body>
<h1>Vercel Pricing</h1>
<div class="plan">
  <h2>Pro Plan — $20/month per member</h2>
  <ul>
    <li>100GB Bandwidth included</li>
    <li>Serverless Functions: 1000 GB-hrs</li>
    <li>Edge Functions: 1M invocations</li>
    <li>Edge Network: Global CDN with 50+ PoPs</li>
    <li>Analytics: Web Vitals & Speed Insights</li>
    <li>Preview deployments: Unlimited</li>
    <li>Build time: 6000 min/month</li>
  </ul>
</div>
<div class="plan">
  <h2>Enterprise — Custom pricing</h2>
  <ul><li>SLA, SSO, Audit Logs, Dedicated Support</li></ul>
</div>
</body></html>`,
          status: 200,
          bytes: 580,
          url: 'https://vercel.com/pricing',
        },
      },
      {
        match: { url: 'netlify' },
        response: {
          content: `<html><head><title>Netlify Pricing</title></head><body>
<h1>Netlify Pricing</h1>
<div class="plan">
  <h2>Pro Plan — $19/month per member</h2>
  <ul>
    <li>100GB Bandwidth included</li>
    <li>Serverless Functions: 125K/month</li>
    <li>Edge Functions: Included</li>
    <li>Edge CDN: Global with instant rollbacks</li>
    <li>Analytics: Built-in server-side analytics</li>
    <li>Build minutes: 25,000/month</li>
    <li>Forms: 100/site/month</li>
  </ul>
</div>
<div class="plan">
  <h2>Enterprise — Custom pricing</h2>
  <ul><li>SLA, SSO, SAML, Priority Support</li></ul>
</div>
</body></html>`,
          status: 200,
          bytes: 560,
          url: 'https://netlify.com/pricing',
        },
      },
      {
        match: { url: 'render' },
        response: {
          content: `<html><head><title>Render Pricing</title></head><body>
<h1>Render Pricing</h1>
<div class="plan">
  <h2>Pro Plan — $25/month per service</h2>
  <ul>
    <li>100GB Bandwidth included</li>
    <li>Docker Containers: Full support</li>
    <li>Auto-scaling: Automatic horizontal scaling</li>
    <li>Private Networking: Built-in service mesh</li>
    <li>Persistent Disks: 20GB included</li>
    <li>DDoS Protection: Included</li>
    <li>Managed PostgreSQL: Starting at $7/mo</li>
  </ul>
</div>
<div class="plan">
  <h2>Enterprise — Custom pricing</h2>
  <ul><li>SLA, SOC 2, VPC Peering, Dedicated Support</li></ul>
</div>
</body></html>`,
          status: 200,
          bytes: 560,
          url: 'https://render.com/pricing',
        },
      },
    ],
    default: {
      content: '<html><body>Page not found</body></html>',
      status: 404,
      bytes: 40,
      url: 'https://unknown.com',
    },
  },
}

// ---------------------------------------------------------------------------
// Fixture: GitHub Issue Triage Board (Case 2)
// ---------------------------------------------------------------------------

export const GITHUB_TRIAGE_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'static',
    description: 'Search for MCP servers by capability or keyword.',
    paramKeys: ['query', 'limit'],
    response: {
      query: 'github',
      results: [
        { name: 'GitHub', qualifiedName: 'github', description: 'GitHub — managed OAuth integration. Access repos, issues, PRs.', source: 'managed', authType: 'oauth', composioToolkit: 'github' },
      ],
      message: 'Found 1 tool(s). Use tool_install to add one.',
    },
  },
  tool_install: {
    type: 'static',
    description: 'Install a tool, making its capabilities available immediately.',
    paramKeys: ['name'],
    response: {
      ok: true,
      server: 'composio',
      integration: 'github',
      toolCount: 5,
      connected: true,
      authStatus: 'active',
      tools: ['GITHUB_LIST_ISSUES', 'GITHUB_CREATE_ISSUE', 'GITHUB_UPDATE_ISSUE', 'GITHUB_SEARCH_ISSUES', 'GITHUB_GET_ISSUE'],
      message: 'Installed github with 5 tool(s). Auth is active — connected and ready.',
    },
  },
  GITHUB_LIST_ISSUES: {
    type: 'static',
    description: 'List issues in a GitHub repository. Returns an array of issues with title, labels, assignee, and state.',
    paramKeys: ['owner', 'repo', 'state', 'labels', 'per_page'],
    response: [
      { number: 42, title: 'App crashes on login with SSO', labels: ['bug', 'critical', 'P0'], assignee: 'alice', state: 'open', created_at: '2026-02-18T10:00:00Z', updated_at: '2026-02-20T08:30:00Z' },
      { number: 38, title: 'Memory leak in websocket handler', labels: ['bug', 'critical'], assignee: null, state: 'open', created_at: '2026-02-17T14:00:00Z', updated_at: '2026-02-19T16:00:00Z' },
      { number: 35, title: 'API rate limiting returns 500 instead of 429', labels: ['bug', 'high'], assignee: 'bob', state: 'open', created_at: '2026-02-15T09:00:00Z', updated_at: '2026-02-18T11:00:00Z' },
      { number: 31, title: 'Dashboard charts fail to render on Safari', labels: ['bug', 'high'], assignee: null, state: 'open', created_at: '2026-02-14T12:00:00Z', updated_at: '2026-02-17T10:00:00Z' },
      { number: 29, title: 'Add dark mode support', labels: ['enhancement', 'medium'], assignee: 'carol', state: 'open', created_at: '2026-02-12T08:00:00Z', updated_at: '2026-02-16T09:00:00Z' },
      { number: 27, title: 'Implement webhook retry logic', labels: ['enhancement', 'medium'], assignee: null, state: 'open', created_at: '2026-02-10T11:00:00Z', updated_at: '2026-02-15T14:00:00Z' },
      { number: 25, title: 'Update API documentation for v3 endpoints', labels: ['documentation', 'low'], assignee: 'dave', state: 'open', created_at: '2026-02-08T15:00:00Z', updated_at: '2026-02-14T10:00:00Z' },
      { number: 22, title: 'Add TypeScript examples to README', labels: ['documentation', 'low'], assignee: null, state: 'open', created_at: '2026-02-06T09:00:00Z', updated_at: '2026-02-12T08:00:00Z' },
    ],
  },
}

// ---------------------------------------------------------------------------
// Fixture: Daily News Research Brief (Case 3)
// ---------------------------------------------------------------------------

export const NEWS_BRIEF_MOCKS: ToolMockMap = {
  web: {
    type: 'pattern',
    patterns: [
      {
        match: { url: 'techcrunch' },
        response: {
          content: `<html><head><title>TechCrunch - AI Infrastructure</title></head><body>
<article>
  <h2>NVIDIA H200 drops to $2.50/hr on Lambda Labs</h2>
  <p>Lambda Labs announced today that H200 GPU instances are now available at $2.50/hour, a 40% reduction from previous pricing. This makes high-end GPU compute accessible to more startups. The H200 offers 141GB HBM3e memory, ideal for training large language models.</p>
  <time>February 21, 2026</time>
</article>
<article>
  <h2>Anthropic raises $3.5B Series D at $40B valuation</h2>
  <p>AI safety company Anthropic announced a $3.5 billion Series D round, valuing the company at $40 billion. The funding will accelerate development of Claude and expand enterprise infrastructure.</p>
  <time>February 20, 2026</time>
</article>
</body></html>`,
          status: 200,
          bytes: 720,
          url: 'https://techcrunch.com/tag/ai-infrastructure',
        },
      },
      {
        match: { url: 'theverge' },
        response: {
          content: `<html><head><title>The Verge - AI News</title></head><body>
<article>
  <h2>Meta releases Llama 4 Scout with 10M context window</h2>
  <p>Meta AI has released Llama 4 Scout, an open-source model featuring a 10 million token context window and 17B active parameters via mixture-of-experts architecture. Available under an open license for commercial use.</p>
  <time>February 21, 2026</time>
</article>
<article>
  <h2>Google DeepMind achieves 10x inference speedup with new distillation method</h2>
  <p>DeepMind published research showing a novel distillation technique that achieves 10x faster inference while retaining 98% of the original model's quality. The technique works across model families.</p>
  <time>February 19, 2026</time>
</article>
</body></html>`,
          status: 200,
          bytes: 680,
          url: 'https://theverge.com/ai',
        },
      },
      {
        match: { url: 'ycombinator' },
        response: {
          content: `<html><head><title>Hacker News - Top Stories</title></head><body>
<ol>
  <li><a href="https://github.com/vllm-project/vllm/releases/v0.8">vLLM 0.8 released with 3x throughput improvement</a> — 342 points, 89 comments</li>
  <li><a href="https://groq.com/cloud">Groq launches cloud API: 500 tokens/sec on Llama 3</a> — 287 points, 156 comments</li>
  <li><a href="https://github.com/example/gpu-orchestrator">Show HN: Open-source GPU orchestrator for multi-cloud inference</a> — 198 points, 67 comments</li>
  <li><a href="https://blog.together.ai/inference-cost-2026">Together AI cuts inference costs by 60% with speculative decoding</a> — 145 points, 42 comments</li>
  <li><a href="https://arxiv.org/abs/2026.12345">Paper: Ring Attention enables 100M context on consumer GPUs</a> — 122 points, 38 comments</li>
</ol>
</body></html>`,
          status: 200,
          bytes: 780,
          url: 'https://news.ycombinator.com',
        },
      },
    ],
    default: {
      content: '<html><body>No articles found</body></html>',
      status: 200,
      bytes: 40,
      url: 'https://unknown-news.com',
    },
  },
}

// ---------------------------------------------------------------------------
// Fixture: API Health Monitor (Case 4)
// ---------------------------------------------------------------------------

export const API_HEALTH_MOCKS: ToolMockMap = {
  web: {
    type: 'pattern',
    patterns: [
      {
        match: { url: 'api.example.com/health' },
        response: {
          content: JSON.stringify({ status: 'healthy', version: '2.4.1', uptime: '99.98%', responseTime: 45, checks: { database: 'ok', cache: 'ok', queue: 'ok' } }),
          status: 200,
          bytes: 140,
          url: 'https://api.example.com/health',
        },
      },
      {
        match: { url: 'staging.example.com' },
        response: {
          content: JSON.stringify({ status: 'degraded', version: '2.5.0-rc1', uptime: '98.5%', responseTime: 230, checks: { database: 'ok', cache: 'slow', queue: 'ok' } }),
          status: 200,
          bytes: 150,
          url: 'https://api.staging.example.com/health',
        },
      },
      {
        match: { url: 'internal.example.com' },
        response: {
          content: JSON.stringify({ status: 'healthy', version: '2.4.1', uptime: '99.99%', responseTime: 12, checks: { database: 'ok', cache: 'ok', queue: 'ok' } }),
          status: 200,
          bytes: 140,
          url: 'https://api.internal.example.com/health',
        },
      },
    ],
    default: {
      content: JSON.stringify({ error: 'Connection refused' }),
      status: 503,
      bytes: 30,
      url: 'https://unknown-api.example.com',
    },
  },
  exec: {
    type: 'static',
    response: {
      stdout: 'real\t0m0.045s\nuser\t0m0.003s\nsys\t0m0.002s',
      stderr: '',
      exitCode: 0,
    },
  },
}

// ---------------------------------------------------------------------------
// Fixture: Sentry Error Triage (Case 5)
// ---------------------------------------------------------------------------

export const SENTRY_TRIAGE_MOCKS: ToolMockMap = {
  SENTRY_LIST_ISSUES: {
    type: 'static',
    description: 'List error issues from Sentry. Returns an array of issues with title, count, level, firstSeen, lastSeen, and status.',
    paramKeys: ['project', 'query', 'sort'],
    response: [
      { id: 'SENTRY-1001', title: 'TypeError: Cannot read property "user" of undefined', count: 1234, userCount: 412, level: 'error', firstSeen: '2026-02-10T08:00:00Z', lastSeen: '2026-02-21T09:30:00Z', status: 'unresolved' },
      { id: 'SENTRY-1002', title: 'ReferenceError: "config" is not defined in worker.ts', count: 892, userCount: 234, level: 'error', firstSeen: '2026-02-12T11:00:00Z', lastSeen: '2026-02-21T08:45:00Z', status: 'unresolved' },
      { id: 'SENTRY-1003', title: 'NetworkError: Failed to fetch /api/v2/sync', count: 567, userCount: 189, level: 'warning', firstSeen: '2026-02-14T09:00:00Z', lastSeen: '2026-02-21T07:15:00Z', status: 'unresolved' },
      { id: 'SENTRY-1004', title: 'TimeoutError: Database query exceeded 30s limit', count: 445, userCount: 156, level: 'error', firstSeen: '2026-02-15T16:00:00Z', lastSeen: '2026-02-20T22:00:00Z', status: 'unresolved' },
      { id: 'SENTRY-1005', title: 'ValidationError: Invalid email format in registration', count: 234, userCount: 234, level: 'warning', firstSeen: '2026-02-16T13:00:00Z', lastSeen: '2026-02-21T06:00:00Z', status: 'unresolved' },
      { id: 'SENTRY-1006', title: 'MemoryError: Heap allocation failed in image processor', count: 123, userCount: 45, level: 'fatal', firstSeen: '2026-02-18T10:00:00Z', lastSeen: '2026-02-20T18:30:00Z', status: 'unresolved' },
    ],
  },
}

// ---------------------------------------------------------------------------
// Fixture: Meeting Prep Command Center (Case 6)
// ---------------------------------------------------------------------------

export const MEETING_PREP_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'pattern',
    description: 'Search for tools by capability or keyword.',
    paramKeys: ['query', 'limit'],
    patterns: [
      {
        match: { query: 'calendar' },
        response: { query: 'google calendar', results: [{ name: 'googlecalendar', description: 'Google Calendar — managed OAuth integration.', source: 'managed', authType: 'oauth' }], message: 'Found 1 tool(s).' },
      },
      {
        match: { query: 'google' },
        response: { query: 'google calendar', results: [{ name: 'googlecalendar', description: 'Google Calendar — managed OAuth integration.', source: 'managed', authType: 'oauth' }], message: 'Found 1 tool(s).' },
      },
    ],
    default: { query: 'calendar', results: [{ name: 'googlecalendar', description: 'Google Calendar — managed OAuth integration.', source: 'managed', authType: 'oauth' }], message: 'Found 1 tool(s).' },
  },
  tool_install: {
    type: 'static',
    description: 'Install a tool, making its capabilities available immediately.',
    paramKeys: ['name'],
    response: {
      ok: true, server: 'composio', integration: 'googlecalendar', toolCount: 1, connected: true, authStatus: 'active',
      tools: ['GOOGLECALENDAR_FIND_EVENT'],
      message: 'Installed googlecalendar with 1 tool(s). Auth is active — connected and ready.',
    },
  },
  GOOGLECALENDAR_FIND_EVENT: {
    type: 'static',
    description: 'List events from Google Calendar. Returns an array of calendar events with summary, start/end times, attendees, location, and description.',
    paramKeys: ['calendarId', 'timeMin', 'timeMax', 'maxResults'],
    response: [
      {
        id: 'evt-001',
        summary: 'Q1 Planning Review',
        start: { dateTime: '2026-02-21T10:00:00-08:00' },
        end: { dateTime: '2026-02-21T11:00:00-08:00' },
        attendees: [
          { email: 'sarah@acme.com', displayName: 'Sarah Chen', responseStatus: 'accepted' },
          { email: 'mike@acme.com', displayName: 'Mike Torres', responseStatus: 'accepted' },
        ],
        location: 'Zoom',
        description: 'Review Q1 goals and set priorities for Q2',
      },
      {
        id: 'evt-002',
        summary: 'Partnership Review',
        start: { dateTime: '2026-02-21T13:00:00-08:00' },
        end: { dateTime: '2026-02-21T13:45:00-08:00' },
        attendees: [
          { email: 'jane@partnerco.io', displayName: 'Jane Park', responseStatus: 'accepted' },
        ],
        location: 'Google Meet',
        description: 'Discuss API integration partnership and co-marketing opportunities',
      },
      {
        id: 'evt-003',
        summary: 'Product Demo for Investors',
        start: { dateTime: '2026-02-21T15:30:00-08:00' },
        end: { dateTime: '2026-02-21T16:30:00-08:00' },
        attendees: [
          { email: 'investor@vcfirm.com', displayName: 'David Kim', responseStatus: 'tentative' },
        ],
        location: 'In-person — Office HQ',
        description: 'Live product demo and Q&A for potential Series A lead',
      },
    ],
  },
  web: {
    type: 'pattern',
    patterns: [
      {
        match: { url: 'acme' },
        response: {
          content: 'Acme Corp: Enterprise SaaS platform for supply chain management. Series B ($45M raised). 200 employees across SF and NYC. Recent news: launched AI-powered demand forecasting product in January 2026. Key competitors: SAP, Oracle SCM.',
          status: 200,
          bytes: 280,
          url: 'https://acme.com/about',
        },
      },
      {
        match: { url: 'partnerco' },
        response: {
          content: 'PartnerCo: API integration platform connecting 500+ SaaS tools. Bootstrapped, profitable. 50 employees, remote-first. Recently launched new partnership program offering revenue share to integration partners. Focus on developer experience and no-code connectors.',
          status: 200,
          bytes: 290,
          url: 'https://partnerco.io/about',
        },
      },
      {
        match: { url: 'vcfirm' },
        response: {
          content: 'VC Firm Capital: Early-stage venture fund, $500M AUM. Focus on developer tools, AI infrastructure, and DevOps. Led 12 deals in 2025 including Series A rounds for 3 AI startups. Managing Partner: David Kim. Portfolio includes notable exits in observability and database tooling.',
          status: 200,
          bytes: 310,
          url: 'https://vcfirm.com/about',
        },
      },
    ],
    default: {
      content: 'Company information not available.',
      status: 200,
      bytes: 35,
      url: 'https://unknown-company.com',
    },
  },
}

// ---------------------------------------------------------------------------
// Fixture: Stripe Revenue Dashboard (Case 7)
// ---------------------------------------------------------------------------

export const STRIPE_REVENUE_MOCKS: ToolMockMap = {
  STRIPE_GET_BALANCE: {
    type: 'static',
    description: 'Get the current Stripe account balance. Returns available and pending amounts by currency.',
    paramKeys: [],
    response: {
      available: [{ amount: 1250000, currency: 'usd' }],
      pending: [{ amount: 35000, currency: 'usd' }],
    },
  },
  STRIPE_LIST_PAYMENTS: {
    type: 'static',
    description: 'List recent Stripe payments/charges. Returns an array of payment objects with amount, currency, status, customer_email, and created timestamp.',
    paramKeys: ['limit', 'starting_after', 'status'],
    response: {
      data: [
        { id: 'pi_001', amount: 29900, currency: 'usd', status: 'succeeded', customer_email: 'enterprise@bigcorp.com', description: 'Pro Plan - Annual', created: 1740100800 },
        { id: 'pi_002', amount: 9900, currency: 'usd', status: 'succeeded', customer_email: 'team@startup.io', description: 'Team Plan - Monthly', created: 1740014400 },
        { id: 'pi_003', amount: 4900, currency: 'usd', status: 'succeeded', customer_email: 'dev@indie.dev', description: 'Pro Plan - Monthly', created: 1739928000 },
        { id: 'pi_004', amount: 29900, currency: 'usd', status: 'succeeded', customer_email: 'ops@midmarket.com', description: 'Pro Plan - Annual', created: 1739841600 },
        { id: 'pi_005', amount: 9900, currency: 'usd', status: 'succeeded', customer_email: 'cto@growthco.com', description: 'Team Plan - Monthly', created: 1739755200 },
        { id: 'pi_006', amount: 4900, currency: 'usd', status: 'succeeded', customer_email: 'founder@newapp.co', description: 'Pro Plan - Monthly', created: 1739668800 },
        { id: 'pi_007', amount: 14900, currency: 'usd', status: 'succeeded', customer_email: 'admin@agency.com', description: 'Agency Plan - Monthly', created: 1739582400 },
        { id: 'pi_008', amount: 9900, currency: 'usd', status: 'succeeded', customer_email: 'lead@saasco.com', description: 'Team Plan - Monthly', created: 1739496000 },
      ],
      has_more: false,
    },
  },
}

// ---------------------------------------------------------------------------
// Fixture: Multi-Repo PR Review Queue (Case 8)
// ---------------------------------------------------------------------------

const PR_DATA_BY_REPO: Record<string, any[]> = {
  frontend: [
    { number: 142, title: 'Fix navigation layout on mobile', user: { login: 'alice' }, labels: ['bug'], created_at: '2026-02-19T10:00:00Z', pull_request: { url: 'https://api.github.com/repos/org/frontend/pulls/142' }, draft: false, ci_status: 'success' },
    { number: 139, title: 'Add dark mode toggle', user: { login: 'bob' }, labels: ['enhancement'], created_at: '2026-02-21T05:00:00Z', pull_request: { url: 'https://api.github.com/repos/org/frontend/pulls/139' }, draft: false, ci_status: 'pending' },
    { number: 135, title: 'Refactor auth flow to use new SDK', user: { login: 'carol' }, labels: ['refactor'], created_at: '2026-02-17T08:00:00Z', pull_request: { url: 'https://api.github.com/repos/org/frontend/pulls/135' }, draft: false, ci_status: 'failure' },
  ],
  backend: [
    { number: 89, title: 'Implement API rate limiting middleware', user: { login: 'dave' }, labels: ['feature'], created_at: '2026-02-20T09:00:00Z', pull_request: { url: 'https://api.github.com/repos/org/backend/pulls/89' }, draft: false, ci_status: 'success' },
    { number: 87, title: 'Database migration v12 — add indexes', user: { login: 'eve' }, labels: ['database'], created_at: '2026-02-21T04:00:00Z', pull_request: { url: 'https://api.github.com/repos/org/backend/pulls/87' }, draft: false, ci_status: 'success' },
  ],
  infra: [
    { number: 56, title: 'Bump Terraform provider to 5.x', user: { login: 'frank' }, labels: ['infrastructure'], created_at: '2026-02-18T14:00:00Z', pull_request: { url: 'https://api.github.com/repos/org/infra/pulls/56' }, draft: false, ci_status: 'success' },
    { number: 54, title: 'Add Datadog monitoring for new services', user: { login: 'grace' }, labels: ['monitoring'], created_at: '2026-02-20T18:00:00Z', pull_request: { url: 'https://api.github.com/repos/org/infra/pulls/54' }, draft: false, ci_status: 'pending' },
  ],
}

const PR_PATTERN_SPEC: ToolMockSpec = {
  type: 'pattern',
  description: 'List issues and pull requests in a GitHub repository. Filter by state, labels, etc. Returns array of issues/PRs with title, user, labels, created_at, and pull_request URL.',
  paramKeys: ['owner', 'repo', 'state', 'labels', 'per_page'],
  patterns: [
    { match: { repo: 'frontend' }, response: PR_DATA_BY_REPO.frontend },
    { match: { repo: 'backend' }, response: PR_DATA_BY_REPO.backend },
    { match: { repo: 'infra' }, response: PR_DATA_BY_REPO.infra },
  ],
  default: [],
}

export const PR_REVIEW_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'static',
    description: 'Search for tools by capability or keyword.',
    paramKeys: ['query', 'limit'],
    response: {
      query: 'github',
      results: [
        { name: 'GitHub', qualifiedName: 'github', description: 'GitHub — managed OAuth integration. Access repos, issues, PRs.', source: 'managed', authType: 'oauth', composioToolkit: 'github' },
      ],
      message: 'Found 1 tool(s). Use tool_install to add one.',
    },
  },
  tool_install: {
    type: 'static',
    description: 'Install a tool, making its capabilities available immediately.',
    paramKeys: ['name'],
    response: {
      ok: true,
      server: 'composio',
      integration: 'github',
      toolCount: 6,
      connected: true,
      authStatus: 'active',
      tools: ['GITHUB_LIST_ISSUES', 'GITHUB_LIST_PULL_REQUESTS', 'GITHUB_CREATE_ISSUE', 'GITHUB_UPDATE_ISSUE', 'GITHUB_CREATE_PULL_REQUEST_REVIEW', 'GITHUB_GET_PULL_REQUEST'],
      message: 'Installed github with 6 tool(s). Auth is active — connected and ready.',
    },
  },
  GITHUB_LIST_ISSUES: PR_PATTERN_SPEC,
  GITHUB_LIST_PULL_REQUESTS: PR_PATTERN_SPEC,
  GITHUB_CREATE_PULL_REQUEST_REVIEW: {
    type: 'static',
    description: 'Create a review on a pull request (approve, request changes).',
    paramKeys: ['owner', 'repo', 'pull_number', 'event', 'body'],
    response: { id: 'review-001', state: 'APPROVED', submitted_at: '2026-02-25T12:00:00Z' },
  },
  send_message: {
    type: 'static',
    response: { ok: true, delivered: true, channel: 'discord', messageId: 'mock-msg-001' },
  },
}

// ---------------------------------------------------------------------------
// Fixture: MCP Discovery — List Installed (MCP Case 1)
// ---------------------------------------------------------------------------

export const MCP_LIST_INSTALLED_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'static',
    description: 'Search for available tools by capability or keyword.',
    paramKeys: ['query'],
    response: {
      query: 'integrations',
      results: [
        { name: 'Playwright Browser', qualifiedName: '@anthropic/mcp-server-playwright', description: 'Browser automation — navigate, click, fill forms, take screenshots.', installCommand: 'npx -y @anthropic/mcp-server-playwright', source: 'catalog' },
        { name: 'PostgreSQL', qualifiedName: '@anthropic/mcp-server-postgres', description: 'Query PostgreSQL databases.', installCommand: 'npx -y @anthropic/mcp-server-postgres', source: 'catalog' },
        { name: 'Google Calendar', qualifiedName: 'googlecalendar', description: 'List, create, update calendar events.', source: 'managed' },
      ],
      message: 'Found 3 available integrations.',
    },
  },
}

// ---------------------------------------------------------------------------
// Fixture: MCP Discovery — Search (MCP Case 2)
// ---------------------------------------------------------------------------

export const MCP_SEARCH_BASIC_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'pattern',
    description: 'Search for MCP servers by capability or keyword.',
    paramKeys: ['query', 'limit'],
    patterns: [
      {
        match: { query: 'postgres' },
        response: {
          query: 'postgres',
          results: [
            { name: 'Postgres MCP Server', qualifiedName: '@modelcontextprotocol/server-postgres', description: 'Query PostgreSQL databases with read-only access. Supports schema inspection and parameterized queries.', installCommand: 'npx -y @modelcontextprotocol/server-postgres', source: 'catalog' },
            { name: 'Neon Postgres', qualifiedName: '@neondatabase/mcp-server-neon', description: 'Manage Neon serverless Postgres — create databases, run SQL, manage branches.', installCommand: 'npx -y @neondatabase/mcp-server-neon', source: 'catalog' },
          ],
          message: 'Found 2 MCP server(s). Use tool_install to add one.',
        },
      },
    ],
    default: { query: 'unknown', results: [], message: 'No MCP servers found. Try a different search term.' },
  },
}

// ---------------------------------------------------------------------------
// Fixture: MCP Discovery — Install and Use (MCP Case 3)
// ---------------------------------------------------------------------------

export const MCP_INSTALL_AND_USE_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'static',
    description: 'Search for MCP servers by capability or keyword.',
    paramKeys: ['query', 'limit'],
    response: {
      query: 'filesystem',
      results: [
        { name: 'Filesystem MCP Server', qualifiedName: '@modelcontextprotocol/server-filesystem', description: 'Secure file operations with configurable access controls.', installCommand: 'npx -y @modelcontextprotocol/server-filesystem /tmp', source: 'catalog' },
      ],
      message: 'Found 1 MCP server(s). Use tool_install to add one.',
    },
  },
  tool_install: {
    type: 'static',
    description: 'Install and start an MCP server, making its tools available immediately.',
    paramKeys: ['name', 'command', 'args', 'env'],
    response: {
      ok: true,
      server: 'filesystem',
      toolCount: 4,
      tools: [
        { name: 'mcp_filesystem_read_file', description: 'Read a file from the allowed directories' },
        { name: 'mcp_filesystem_write_file', description: 'Write content to a file' },
        { name: 'mcp_filesystem_list_directory', description: 'List directory contents' },
        { name: 'mcp_filesystem_search_files', description: 'Search files by pattern' },
      ],
      message: 'Installed "filesystem" with 4 tool(s). They are now available for use.',
    },
  },
  mcp_filesystem_list_directory: {
    type: 'static',
    description: 'List directory contents',
    paramKeys: ['path'],
    response: { entries: [{ name: 'report.csv', type: 'file', size: 2048 }, { name: 'data', type: 'directory' }] },
  },
}

// ---------------------------------------------------------------------------
// Fixture: MCP Discovery — Uninstall (MCP Case 4)
// ---------------------------------------------------------------------------

export const MCP_UNINSTALL_MOCKS: ToolMockMap = {
  tool_uninstall: {
    type: 'static',
    description: 'Stop and remove an installed MCP server.',
    paramKeys: ['name'],
    response: { ok: true, removed: 'slack', message: 'Removed "slack" and all its tools.' },
  },
}

// ---------------------------------------------------------------------------
// Fixture: MCP Discovery — Self-Extend Figma (MCP Case 5)
// Discovery-only: agent has no built-in Figma capability. Must discover +
// install via search → install flow. No post-install tools mocked.
// ---------------------------------------------------------------------------

export const MCP_SELF_EXTEND_FIGMA_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'static',
    description: 'Search for MCP servers by capability or keyword.',
    paramKeys: ['query', 'limit'],
    response: {
      query: 'figma design',
      results: [
        { name: 'Figma MCP Server', qualifiedName: '@anthropic/mcp-server-figma', description: 'Access Figma files, components, and design tokens. List files, export assets, inspect design properties.', installCommand: 'npx -y @anthropic/mcp-server-figma', source: 'catalog' },
        { name: 'Figma Dev Mode', qualifiedName: '@figma/mcp-devmode', description: 'Read-only access to Figma dev mode — inspect components, spacing, and CSS.', installCommand: 'npx -y @figma/mcp-devmode', source: 'catalog' },
      ],
      message: 'Found 2 MCP server(s). Use tool_install to add one.',
    },
  },
  tool_install: {
    type: 'static',
    description: 'Install and start an MCP server, making its tools available immediately.',
    paramKeys: ['name', 'command', 'args', 'env'],
    response: {
      ok: true,
      server: 'figma',
      toolCount: 4,
      tools: [
        { name: 'mcp_figma_list_files', description: 'List files in a Figma project' },
        { name: 'mcp_figma_get_file', description: 'Get details of a Figma file' },
        { name: 'mcp_figma_list_components', description: 'List components in a file' },
        { name: 'mcp_figma_export_asset', description: 'Export an asset from Figma' },
      ],
      message: 'Installed "figma" with 4 tool(s). They are now available for use.',
    },
  },
}

// ---------------------------------------------------------------------------
// Fixture: MCP Discovery — Self-Extend Database (MCP Case 6)
// Discovery-only: no post-install postgres tools mocked. Agent must recognize
// it needs DB access and go through search → install with connection config.
// ---------------------------------------------------------------------------

export const MCP_SELF_EXTEND_DATABASE_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'static',
    description: 'Search for MCP servers by capability or keyword.',
    paramKeys: ['query', 'limit'],
    response: {
      query: 'postgres database',
      results: [
        { name: 'Postgres MCP Server', qualifiedName: '@modelcontextprotocol/server-postgres', description: 'Query PostgreSQL databases with read-only access. Supports schema inspection and parameterized queries.', installCommand: 'npx -y @modelcontextprotocol/server-postgres', source: 'catalog' },
      ],
      message: 'Found 1 MCP server(s). Use tool_install to add one.',
    },
  },
  tool_install: {
    type: 'static',
    description: 'Install and start an MCP server, making its tools available immediately.',
    paramKeys: ['name', 'command', 'args', 'env'],
    response: {
      ok: true,
      server: 'postgres',
      toolCount: 3,
      tools: [
        { name: 'mcp_postgres_query', description: 'Execute a read-only SQL query against the database' },
        { name: 'mcp_postgres_list_tables', description: 'List all tables in the database' },
        { name: 'mcp_postgres_describe_table', description: 'Get column definitions for a table' },
      ],
      message: 'Installed "postgres" with 3 tool(s). They are now available for use.',
    },
  },
}

// ---------------------------------------------------------------------------
// Fixture: MCP Discovery — Multi-Server Orchestration (MCP Case 7)
// ---------------------------------------------------------------------------

export const MCP_MULTI_SERVER_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'pattern',
    description: 'Search for MCP servers by capability or keyword.',
    paramKeys: ['query', 'limit'],
    patterns: [
      {
        match: { query: 'github' },
        response: {
          query: 'github',
          results: [
            { name: 'GitHub MCP Server', qualifiedName: '@modelcontextprotocol/server-github', description: 'Access GitHub repos, issues, PRs, and actions.', installCommand: 'npx -y @modelcontextprotocol/server-github', source: 'catalog' },
          ],
          message: 'Found 1 MCP server(s). Use tool_install to add one.',
        },
      },
      {
        match: { query: 'slack' },
        response: {
          query: 'slack',
          results: [
            { name: 'Slack MCP Server', qualifiedName: '@anthropic/mcp-server-slack', description: 'Send messages, read channels, manage Slack workspace.', installCommand: 'npx -y @anthropic/mcp-server-slack', source: 'catalog' },
          ],
          message: 'Found 1 MCP server(s). Use tool_install to add one.',
        },
      },
    ],
    default: { query: 'unknown', results: [], message: 'No MCP servers found.' },
  },
  tool_install: {
    type: 'pattern',
    description: 'Install and start an MCP server, making its tools available immediately.',
    paramKeys: ['name', 'command', 'args', 'env'],
    patterns: [
      {
        match: { name: 'github' },
        response: {
          ok: true, server: 'github', toolCount: 3,
          tools: [
            { name: 'mcp_github_list_pull_requests', description: 'List open PRs' },
            { name: 'mcp_github_get_issue', description: 'Get issue details' },
            { name: 'mcp_github_create_issue', description: 'Create an issue' },
          ],
          message: 'Installed "github" with 3 tool(s).',
        },
      },
      {
        match: { name: 'slack' },
        response: {
          ok: true, server: 'slack', toolCount: 2,
          tools: [
            { name: 'mcp_slack_send_message', description: 'Send a message to a Slack channel' },
            { name: 'mcp_slack_list_channels', description: 'List Slack channels' },
          ],
          message: 'Installed "slack" with 2 tool(s).',
        },
      },
    ],
    default: { error: 'Unknown server' },
  },
  mcp_github_list_pull_requests: {
    type: 'static',
    description: 'List open pull requests',
    paramKeys: ['owner', 'repo'],
    response: [
      { number: 42, title: 'Fix critical auth bypass', author: 'alice', labels: ['security', 'urgent'], created_at: '2026-02-20T08:00:00Z', mergeable: true },
      { number: 41, title: 'Add logging middleware', author: 'bob', labels: ['enhancement'], created_at: '2026-02-21T10:00:00Z', mergeable: true },
      { number: 40, title: 'Update dependencies', author: 'dependabot', labels: ['dependencies'], created_at: '2026-02-19T06:00:00Z', mergeable: false },
    ],
  },
  mcp_slack_send_message: {
    type: 'static',
    description: 'Send a message to a Slack channel',
    paramKeys: ['channel', 'text'],
    response: { ok: true, channel: '#engineering', ts: '1740200000.000100' },
  },
}

// ---------------------------------------------------------------------------
// Fixture: MCP Discovery — Discovery to Personality (MCP Case 8)
// ---------------------------------------------------------------------------

export const MCP_DISCOVERY_PERSONALITY_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'static',
    description: 'Search for MCP servers by capability or keyword.',
    paramKeys: ['query', 'limit'],
    response: {
      query: 'linear project management',
      results: [
        { name: 'Linear MCP Server', qualifiedName: '@linear/mcp-server', description: 'Manage Linear issues, projects, and cycles. Create, update, and search issues.', installCommand: 'npx -y @linear/mcp-server', source: 'catalog' },
      ],
      message: 'Found 1 MCP server(s). Use tool_install to add one.',
    },
  },
  tool_install: {
    type: 'static',
    description: 'Install and start an MCP server, making its tools available immediately.',
    paramKeys: ['name', 'command', 'args', 'env'],
    response: {
      ok: true,
      server: 'linear',
      toolCount: 4,
      tools: [
        { name: 'mcp_linear_list_issues', description: 'List issues with filters' },
        { name: 'mcp_linear_create_issue', description: 'Create a new issue' },
        { name: 'mcp_linear_update_issue', description: 'Update an issue' },
        { name: 'mcp_linear_search', description: 'Search across issues and projects' },
      ],
      message: 'Installed "linear" with 4 tool(s). They are now available for use.',
    },
  },
  mcp_linear_list_issues: {
    type: 'static',
    description: 'List issues with filters',
    paramKeys: ['project', 'status'],
    response: [
      { id: 'LIN-101', title: 'Implement SSO login', status: 'In Progress', assignee: 'alice', priority: 'High' },
      { id: 'LIN-102', title: 'Fix dashboard loading speed', status: 'Todo', assignee: 'bob', priority: 'Urgent' },
      { id: 'LIN-103', title: 'Add export to CSV feature', status: 'Todo', assignee: null, priority: 'Medium' },
    ],
  },
}

// ===========================================================================
// MCP Orchestration Fixtures (complex multi-server scenarios)
// ===========================================================================

// ---------------------------------------------------------------------------
// Orchestration 1: Investor Meeting Prep
// Services: Calendar + Postgres (metrics) + web research
// ---------------------------------------------------------------------------

export const INVESTOR_MEETING_PREP_MOCKS: ToolMockMap = {
  GOOGLECALENDAR_FIND_EVENT: {
    type: 'static',
    description: 'List events from Google Calendar.',
    paramKeys: ['calendarId', 'timeMin', 'timeMax', 'maxResults'],
    response: [
      {
        id: 'evt-003',
        summary: 'Product Demo for Investors',
        start: { dateTime: '2026-02-23T15:30:00-08:00' },
        end: { dateTime: '2026-02-23T16:30:00-08:00' },
        attendees: [
          { email: 'david@vcfirm.com', displayName: 'David Kim', responseStatus: 'accepted' },
          { email: 'me@acme.com', displayName: 'You', responseStatus: 'accepted' },
        ],
        location: 'In-person — Office HQ, Conf Room A',
        description: 'Live product demo and Q&A for potential Series A lead. David wants to see the AI workflow engine in action.',
      },
      {
        id: 'evt-001',
        summary: 'Team Standup',
        start: { dateTime: '2026-02-23T09:30:00-08:00' },
        end: { dateTime: '2026-02-23T09:45:00-08:00' },
        attendees: [],
        location: 'Zoom',
        description: 'Daily standup',
      },
    ],
  },
  mcp_postgres_query: {
    type: 'pattern',
    description: 'Execute a read-only SQL query against the database.',
    paramKeys: ['sql'],
    patterns: [
      {
        match: { sql: 'arr' },
        response: {
          rows: [{ metric: 'ARR', value: 2400000 }, { metric: 'MRR', value: 200000 }, { metric: 'monthly_growth', value: 18.2 }],
          rowCount: 3,
        },
      },
      {
        match: { sql: 'churn' },
        response: {
          rows: [{ metric: 'monthly_churn', value: 4.2 }, { metric: 'net_retention', value: 112 }],
          rowCount: 2,
        },
      },
      {
        match: { sql: 'user' },
        response: {
          rows: [{ metric: 'total_users', value: 1247 }, { metric: 'active_users_30d', value: 892 }, { metric: 'enterprise_accounts', value: 23 }, { metric: 'avg_seats_per_account', value: 8.4 }],
          rowCount: 4,
        },
      },
    ],
    default: {
      rows: [
        { metric: 'ARR', value: 2400000 }, { metric: 'MRR', value: 200000 },
        { metric: 'monthly_growth_pct', value: 18.2 }, { metric: 'monthly_churn_pct', value: 4.2 },
        { metric: 'net_retention_pct', value: 112 }, { metric: 'total_users', value: 1247 },
        { metric: 'active_users_30d', value: 892 }, { metric: 'enterprise_accounts', value: 23 },
      ],
      rowCount: 8,
    },
  },
  web: {
    type: 'pattern',
    patterns: [
      {
        match: { url: 'vcfirm' },
        response: {
          content: 'VC Firm Capital: Early-stage venture fund, $500M AUM. Focus on developer tools, AI infrastructure, and DevOps. Managing Partner: David Kim. Led 12 deals in 2025 including Series A rounds for 3 AI startups. Portfolio includes notable exits in observability and database tooling. Typical check size: $3-8M for Series A. David Kim is known for deep technical diligence and prefers founder-led demos.',
          status: 200, bytes: 380, url: 'https://vcfirm.com/about',
        },
      },
      {
        match: { url: 'david' },
        response: {
          content: 'David Kim — Managing Partner at VC Firm Capital. Previously VP Engineering at Datadog (pre-IPO). Stanford CS, MIT MBA. Publishes "The Infrastructure Investor" newsletter. Active on Twitter. Key interests: developer productivity, AI ops, open-source business models. Recent investments: Neon (serverless postgres), Railway (deployment platform), Inngest (event-driven functions).',
          status: 200, bytes: 400, url: 'https://linkedin.com/in/davidkim',
        },
      },
    ],
    default: { content: 'No information found.', status: 404, bytes: 20, url: 'https://unknown.com' },
  },
}

// ---------------------------------------------------------------------------
// Orchestration 3: Production Incident Investigation
// Services: Sentry + GitHub (deploys) + Datadog (metrics) + Slack
// ---------------------------------------------------------------------------

export const PRODUCTION_INCIDENT_MOCKS: ToolMockMap = {
  SENTRY_LIST_ISSUES: {
    type: 'static',
    description: 'List error issues from Sentry.',
    paramKeys: ['project', 'query', 'sort'],
    response: [
      { id: 'SENTRY-2001', title: 'TypeError: Cannot read property "session" of null', count: 1843, userCount: 672, level: 'error', firstSeen: '2026-02-22T14:32:00Z', lastSeen: '2026-02-22T15:01:00Z', status: 'unresolved', tags: { url: '/api/v2/auth/verify', handler: 'authMiddleware.ts:42' } },
      { id: 'SENTRY-2002', title: 'HTTP 500: Internal Server Error on /api/v2/users/me', count: 956, userCount: 445, level: 'error', firstSeen: '2026-02-22T14:35:00Z', lastSeen: '2026-02-22T15:00:00Z', status: 'unresolved', tags: { url: '/api/v2/users/me', handler: 'userController.ts:18' } },
      { id: 'SENTRY-2003', title: 'TimeoutError: Redis connection timed out', count: 234, userCount: 98, level: 'warning', firstSeen: '2026-02-22T14:40:00Z', lastSeen: '2026-02-22T14:58:00Z', status: 'unresolved', tags: { service: 'session-store' } },
    ],
  },
  GITHUB_LIST_RECENT_DEPLOYS: {
    type: 'static',
    description: 'List recent deployments/merged PRs.',
    paramKeys: ['owner', 'repo', 'limit'],
    response: [
      { sha: 'a1b2c3d', message: 'Refactor auth middleware to use new session store', author: 'bob', mergedAt: '2026-02-22T14:15:00Z', pr: '#187', labels: ['refactor', 'auth'] },
      { sha: 'e4f5g6h', message: 'Update Redis client to v5.0', author: 'bob', mergedAt: '2026-02-22T14:10:00Z', pr: '#186', labels: ['dependencies'] },
      { sha: 'i7j8k9l', message: 'Add billing webhook endpoint', author: 'carol', mergedAt: '2026-02-22T11:00:00Z', pr: '#185', labels: ['feature'] },
    ],
  },
  DATADOG_QUERY_METRICS: {
    type: 'pattern',
    description: 'Query infrastructure metrics from Datadog.',
    paramKeys: ['query', 'from', 'to'],
    patterns: [
      {
        match: { query: 'error' },
        response: {
          series: [
            { metric: 'http.error_rate', points: [[1740235800, 0.1], [1740236100, 0.1], [1740236400, 12.3], [1740236700, 15.1], [1740237000, 14.8]], unit: 'percent' },
          ],
          message: 'Error rate spiked from 0.1% to 15.1% at 14:33 UTC',
        },
      },
      {
        match: { query: 'latency' },
        response: {
          series: [
            { metric: 'http.response_time_p99', points: [[1740235800, 48], [1740236100, 52], [1740236400, 2340], [1740236700, 3100], [1740237000, 2890]], unit: 'ms' },
          ],
          message: 'P99 latency spiked from 52ms to 3.1s at 14:33 UTC',
        },
      },
    ],
    default: {
      series: [
        { metric: 'http.error_rate', points: [[1740236400, 15.1]], unit: 'percent' },
        { metric: 'http.response_time_p99', points: [[1740236400, 3100]], unit: 'ms' },
        { metric: 'http.requests_per_sec', points: [[1740236400, 245]], unit: 'req/s' },
      ],
      message: 'Anomaly detected: error rate and latency spiked at 14:33 UTC, correlates with deploy a1b2c3d',
    },
  },
  SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL: {
    type: 'static',
    description: 'Send a message to a Slack channel.',
    paramKeys: ['channel', 'text'],
    response: { ok: true, channel: '#incidents', ts: '1740237060.000100' },
  },
}

// ---------------------------------------------------------------------------
// Orchestration 4: Support Ticket Triage → Engineering Tasks
// Services: Zendesk + Linear + Slack
// ---------------------------------------------------------------------------

export const SUPPORT_TICKET_TRIAGE_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'pattern',
    description: 'Search for tools by capability or keyword.',
    paramKeys: ['query', 'limit'],
    patterns: [
      {
        match: { query: 'zendesk' },
        response: {
          query: 'zendesk',
          results: [{ name: 'zendesk', description: 'Zendesk — managed OAuth integration. List tickets, manage support.', source: 'managed', authType: 'oauth', composioToolkit: 'zendesk' }],
          message: 'Found 1 tool(s). Use tool_install to add one.',
        },
      },
      {
        match: { query: 'linear' },
        response: {
          query: 'linear',
          results: [{ name: 'linear', description: 'Linear — managed OAuth integration. Create and manage issues.', source: 'managed', authType: 'oauth', composioToolkit: 'linear' }],
          message: 'Found 1 tool(s). Use tool_install to add one.',
        },
      },
      {
        match: { query: 'slack' },
        response: {
          query: 'slack',
          results: [{ name: 'slack', description: 'Slack — managed OAuth integration. Send messages, manage channels.', source: 'managed', authType: 'oauth', composioToolkit: 'slack' }],
          message: 'Found 1 tool(s). Use tool_install to add one.',
        },
      },
    ],
    default: {
      query: 'support',
      results: [
        { name: 'zendesk', description: 'Zendesk — managed OAuth integration.', source: 'managed', authType: 'oauth' },
        { name: 'linear', description: 'Linear — managed OAuth integration.', source: 'managed', authType: 'oauth' },
        { name: 'slack', description: 'Slack — managed OAuth integration.', source: 'managed', authType: 'oauth' },
      ],
      message: 'Found 3 tool(s). Use tool_install to add one.',
    },
  },
  tool_install: {
    type: 'pattern',
    description: 'Install a tool, making its capabilities available immediately.',
    paramKeys: ['name'],
    patterns: [
      {
        match: { name: 'zendesk' },
        response: {
          ok: true, server: 'composio', integration: 'zendesk', toolCount: 2, connected: true, authStatus: 'active',
          tools: ['ZENDESK_LIST_TICKETS', 'ZENDESK_GET_TICKET'],
          message: 'Installed zendesk with 2 tool(s). Auth is active — connected and ready.',
        },
      },
      {
        match: { name: 'linear' },
        response: {
          ok: true, server: 'composio', integration: 'linear', toolCount: 3, connected: true, authStatus: 'active',
          tools: ['LINEAR_CREATE_ISSUE', 'LINEAR_LIST_ISSUES', 'LINEAR_UPDATE_ISSUE'],
          message: 'Installed linear with 3 tool(s). Auth is active — connected and ready.',
        },
      },
      {
        match: { name: 'slack' },
        response: {
          ok: true, server: 'composio', integration: 'slack', toolCount: 2, connected: true, authStatus: 'active',
          tools: ['SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL', 'SLACK_LIST_CHANNELS'],
          message: 'Installed slack with 2 tool(s). Auth is active — connected and ready.',
        },
      },
    ],
    default: { ok: true, connected: true, authStatus: 'active', tools: [], message: 'Installed. Auth is active — connected and ready.' },
  },
  ZENDESK_LIST_TICKETS: {
    type: 'static',
    description: 'List recent support tickets from Zendesk.',
    paramKeys: ['status', 'created_after', 'sort_by', 'limit'],
    response: {
      tickets: [
        { id: 'ZD-4501', subject: 'Can\'t log in after password reset', status: 'open', priority: 'high', created_at: '2026-02-20T09:00:00Z', requester: 'enterprise-user@bigcorp.com', tags: ['login', 'auth', 'password-reset'], description: 'After resetting my password via the email link, I get "Invalid session" when trying to log in. Tried 3 browsers.' },
        { id: 'ZD-4502', subject: 'Login stuck on loading screen', status: 'open', priority: 'high', created_at: '2026-02-20T11:00:00Z', requester: 'user2@startup.io', tags: ['login', 'auth'], description: 'After entering credentials the page just spins forever. Started happening yesterday.' },
        { id: 'ZD-4503', subject: 'SSO login broken for our team', status: 'open', priority: 'urgent', created_at: '2026-02-19T16:00:00Z', requester: 'admin@enterprise.co', tags: ['login', 'sso', 'auth'], description: 'None of our 50 team members can log in via SAML SSO. Getting "SAML assertion expired" error.' },
        { id: 'ZD-4504', subject: 'Password reset email never arrives', status: 'open', priority: 'normal', created_at: '2026-02-21T08:00:00Z', requester: 'user4@gmail.com', tags: ['login', 'password-reset', 'email'], description: 'Requested password reset 3 times, no email received. Checked spam.' },
        { id: 'ZD-4505', subject: 'Dashboard takes 30+ seconds to load', status: 'open', priority: 'high', created_at: '2026-02-18T14:00:00Z', requester: 'pm@midmarket.com', tags: ['performance', 'dashboard'], description: 'Dashboard page takes 30-40 seconds to fully render. Used to be under 3 seconds.' },
        { id: 'ZD-4506', subject: 'Charts not loading on dashboard', status: 'open', priority: 'normal', created_at: '2026-02-19T10:00:00Z', requester: 'analyst@acme.com', tags: ['performance', 'dashboard', 'charts'], description: 'The analytics charts show "Failed to load" error. Other parts of dashboard work fine.' },
        { id: 'ZD-4507', subject: 'Dashboard crashes when filtering by date range', status: 'open', priority: 'normal', created_at: '2026-02-20T15:00:00Z', requester: 'user7@company.com', tags: ['performance', 'dashboard', 'crash'], description: 'Selecting a custom date range causes the whole page to go blank.' },
        { id: 'ZD-4508', subject: 'Charged twice for this month', status: 'open', priority: 'urgent', created_at: '2026-02-21T09:00:00Z', requester: 'billing@startup.io', tags: ['billing', 'duplicate-charge'], description: 'We were charged $299 twice on Feb 1st. Invoice numbers INV-2026-0201 and INV-2026-0201b.' },
        { id: 'ZD-4509', subject: 'Can\'t update credit card', status: 'open', priority: 'normal', created_at: '2026-02-19T13:00:00Z', requester: 'admin@smallbiz.com', tags: ['billing', 'payment'], description: 'Settings > Billing > Update card button does nothing when clicked.' },
        { id: 'ZD-4510', subject: 'API returns stale data after update', status: 'open', priority: 'high', created_at: '2026-02-20T10:00:00Z', requester: 'dev@integration.io', tags: ['api', 'cache', 'data-integrity'], description: 'After updating a record via PUT /api/v2/records/:id, GET returns the old data for ~5 minutes.' },
        { id: 'ZD-4511', subject: 'Webhook deliveries failing since Tuesday', status: 'open', priority: 'high', created_at: '2026-02-18T16:00:00Z', requester: 'dev@partner.com', tags: ['api', 'webhooks'], description: 'Our webhook endpoint stopped receiving events. Dashboard shows all deliveries as "failed" since Feb 18.' },
        { id: 'ZD-4512', subject: 'Would love a CSV export feature', status: 'open', priority: 'low', created_at: '2026-02-17T11:00:00Z', requester: 'pm@agency.com', tags: ['feature-request', 'export'], description: 'It would be great to export report data as CSV for our quarterly reviews.' },
      ],
      count: 12,
      next_page: null,
    },
  },
  LINEAR_CREATE_ISSUE: {
    type: 'static',
    description: 'Create a new issue in Linear.',
    paramKeys: ['title', 'description', 'priority', 'labels', 'teamId'],
    response: { id: 'ENG-301', url: 'https://linear.app/acme/issue/ENG-301', status: 'Triage', created: true },
  },
  SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL: {
    type: 'static',
    description: 'Send a message to a Slack channel.',
    paramKeys: ['channel', 'text'],
    response: { ok: true, channel: '#engineering', ts: '1740240000.000200' },
  },
}

// ---------------------------------------------------------------------------
// Orchestration 5: New Team Member Onboarding
// Services: GitHub + Slack + Linear
// ---------------------------------------------------------------------------

export const TEAM_ONBOARDING_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'pattern',
    description: 'Search for tools by capability or keyword.',
    paramKeys: ['query', 'limit'],
    patterns: [
      {
        match: { query: 'github' },
        response: { query: 'github', results: [{ name: 'github', description: 'GitHub — managed OAuth integration.', source: 'managed', authType: 'oauth' }], message: 'Found 1 tool(s).' },
      },
      {
        match: { query: 'slack' },
        response: { query: 'slack', results: [{ name: 'slack', description: 'Slack — managed OAuth integration.', source: 'managed', authType: 'oauth' }], message: 'Found 1 tool(s).' },
      },
      {
        match: { query: 'linear' },
        response: { query: 'linear', results: [{ name: 'linear', description: 'Linear — managed OAuth integration.', source: 'managed', authType: 'oauth' }], message: 'Found 1 tool(s).' },
      },
    ],
    default: {
      query: 'onboarding',
      results: [
        { name: 'github', description: 'GitHub — managed OAuth integration.', source: 'managed', authType: 'oauth' },
        { name: 'slack', description: 'Slack — managed OAuth integration.', source: 'managed', authType: 'oauth' },
        { name: 'linear', description: 'Linear — managed OAuth integration.', source: 'managed', authType: 'oauth' },
      ],
      message: 'Found 3 tool(s).',
    },
  },
  tool_install: {
    type: 'pattern',
    description: 'Install a tool, making its capabilities available immediately.',
    paramKeys: ['name'],
    patterns: [
      {
        match: { name: 'github' },
        response: {
          ok: true, server: 'composio', integration: 'github', toolCount: 3, connected: true, authStatus: 'active',
          tools: ['GITHUB_ADD_MEMBER_TO_ORG', 'GITHUB_LIST_REPOS', 'GITHUB_CREATE_ISSUE'],
          message: 'Installed github with 3 tool(s). Auth is active — connected and ready.',
        },
      },
      {
        match: { name: 'slack' },
        response: {
          ok: true, server: 'composio', integration: 'slack', toolCount: 3, connected: true, authStatus: 'active',
          tools: ['SLACK_INVITE_USER_TO_WORKSPACE', 'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL', 'SLACK_LIST_CHANNELS'],
          message: 'Installed slack with 3 tool(s). Auth is active — connected and ready.',
        },
      },
      {
        match: { name: 'linear' },
        response: {
          ok: true, server: 'composio', integration: 'linear', toolCount: 3, connected: true, authStatus: 'active',
          tools: ['LINEAR_CREATE_ISSUE', 'LINEAR_LIST_ISSUES', 'LINEAR_UPDATE_ISSUE'],
          message: 'Installed linear with 3 tool(s). Auth is active — connected and ready.',
        },
      },
    ],
    default: { ok: true, connected: true, authStatus: 'active', tools: [], message: 'Installed. Auth is active — connected and ready.' },
  },
  GITHUB_ADD_MEMBER_TO_ORG: {
    type: 'static',
    description: 'Add a user to a GitHub organization and grant repo access.',
    paramKeys: ['org', 'username', 'role', 'repos'],
    response: { ok: true, user: 'sarahchen', org: 'acme-corp', role: 'member', repos_granted: ['acme-corp/backend', 'acme-corp/frontend', 'acme-corp/platform-infra', 'acme-corp/shared-libs'], invitation_sent: true },
  },
  SLACK_INVITE_USER_TO_WORKSPACE: {
    type: 'static',
    description: 'Invite a user to Slack workspace and add to channels.',
    paramKeys: ['email', 'channels'],
    response: { ok: true, user_id: 'U08SARAH', channels_added: ['#platform', '#engineering', '#general', '#new-hires', '#random'], invitation_sent: true },
  },
  SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL: {
    type: 'static',
    description: 'Send a message to a Slack channel.',
    paramKeys: ['channel', 'text'],
    response: { ok: true, channel: '#platform', ts: '1740300000.000100' },
  },
  LINEAR_CREATE_ISSUE: {
    type: 'pattern',
    description: 'Create a new issue in Linear.',
    paramKeys: ['title', 'description', 'priority', 'labels', 'teamId', 'assigneeId'],
    patterns: [
      { match: { title: 'dev' }, response: { id: 'PLT-201', url: 'https://linear.app/acme/issue/PLT-201', status: 'Todo', created: true } },
      { match: { title: 'doc' }, response: { id: 'PLT-202', url: 'https://linear.app/acme/issue/PLT-202', status: 'Todo', created: true } },
      { match: { title: 'PR' }, response: { id: 'PLT-203', url: 'https://linear.app/acme/issue/PLT-203', status: 'Todo', created: true } },
      { match: { title: 'meet' }, response: { id: 'PLT-204', url: 'https://linear.app/acme/issue/PLT-204', status: 'Todo', created: true } },
    ],
    default: { id: 'PLT-200', url: 'https://linear.app/acme/issue/PLT-200', status: 'Todo', created: true },
  },
}

// ---------------------------------------------------------------------------
// Orchestration 6: Weekly Business Dashboard
// Services: Stripe + Postgres (usage) + GitHub (velocity)
// ---------------------------------------------------------------------------

export const BUSINESS_DASHBOARD_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'pattern',
    description: 'Search for tools by capability or keyword.',
    paramKeys: ['query', 'limit'],
    patterns: [
      {
        match: { query: 'stripe' },
        response: { query: 'stripe', results: [{ name: 'stripe', description: 'Stripe — managed OAuth integration. Payments, subscriptions, invoices.', source: 'managed', authType: 'oauth' }], message: 'Found 1 tool(s).' },
      },
      {
        match: { query: 'postgres' },
        response: { query: 'postgres', results: [{ name: 'Postgres MCP Server', qualifiedName: '@modelcontextprotocol/server-postgres', description: 'Query PostgreSQL databases.', source: 'catalog', installCommand: 'npx -y @modelcontextprotocol/server-postgres' }], message: 'Found 1 tool(s).' },
      },
      {
        match: { query: 'github' },
        response: { query: 'github', results: [{ name: 'github', description: 'GitHub — managed OAuth integration.', source: 'managed', authType: 'oauth' }], message: 'Found 1 tool(s).' },
      },
    ],
    default: {
      query: 'business',
      results: [
        { name: 'stripe', description: 'Stripe — managed OAuth integration.', source: 'managed', authType: 'oauth' },
        { name: 'Postgres MCP Server', qualifiedName: '@modelcontextprotocol/server-postgres', description: 'Query PostgreSQL databases.', source: 'catalog' },
        { name: 'github', description: 'GitHub — managed OAuth integration.', source: 'managed', authType: 'oauth' },
      ],
      message: 'Found 3 tool(s).',
    },
  },
  tool_install: {
    type: 'pattern',
    description: 'Install a tool, making its capabilities available immediately.',
    paramKeys: ['name', 'command', 'args', 'env'],
    patterns: [
      {
        match: { name: 'stripe' },
        response: {
          ok: true, server: 'composio', integration: 'stripe', toolCount: 2, connected: true, authStatus: 'active',
          tools: ['STRIPE_GET_BALANCE', 'STRIPE_LIST_PAYMENTS'],
          message: 'Installed stripe with 2 tool(s). Auth is active — connected and ready.',
        },
      },
      {
        match: { name: 'postgres' },
        response: {
          ok: true, server: 'postgres', toolCount: 1, connected: true, authStatus: 'active',
          tools: [{ name: 'mcp_postgres_query', description: 'Execute a read-only SQL query' }],
          message: 'Installed postgres with 1 tool(s). Connected and ready.',
        },
      },
      {
        match: { name: 'github' },
        response: {
          ok: true, server: 'composio', integration: 'github', toolCount: 1, connected: true, authStatus: 'active',
          tools: ['GITHUB_LIST_PULL_REQUESTS'],
          message: 'Installed github with 1 tool(s). Auth is active — connected and ready.',
        },
      },
    ],
    default: { ok: true, connected: true, authStatus: 'active', tools: [], message: 'Installed. Auth is active — connected and ready.' },
  },
  STRIPE_GET_BALANCE: {
    type: 'static',
    description: 'Get Stripe account balance.',
    paramKeys: [],
    response: { available: [{ amount: 1250000, currency: 'usd' }], pending: [{ amount: 35000, currency: 'usd' }] },
  },
  STRIPE_LIST_PAYMENTS: {
    type: 'static',
    description: 'List recent Stripe payments.',
    paramKeys: ['limit', 'starting_after', 'status'],
    response: {
      data: [
        { id: 'pi_001', amount: 29900, currency: 'usd', status: 'succeeded', customer_email: 'enterprise@bigcorp.com', description: 'Pro Plan - Annual', created: 1740100800 },
        { id: 'pi_002', amount: 9900, currency: 'usd', status: 'succeeded', customer_email: 'team@startup.io', description: 'Team Plan - Monthly', created: 1740014400 },
        { id: 'pi_003', amount: 4900, currency: 'usd', status: 'succeeded', customer_email: 'dev@indie.dev', description: 'Pro Plan - Monthly', created: 1739928000 },
        { id: 'pi_004', amount: 29900, currency: 'usd', status: 'succeeded', customer_email: 'ops@midmarket.com', description: 'Pro Plan - Annual', created: 1739841600 },
        { id: 'pi_005', amount: 9900, currency: 'usd', status: 'succeeded', customer_email: 'cto@growthco.com', description: 'Team Plan - Monthly', created: 1739755200 },
      ],
      has_more: true,
    },
  },
  mcp_postgres_query: {
    type: 'pattern',
    description: 'Execute a read-only SQL query.',
    paramKeys: ['sql'],
    patterns: [
      {
        match: { sql: 'signup' },
        response: {
          rows: [
            { week: '2026-W05', signups: 89 }, { week: '2026-W06', signups: 112 },
            { week: '2026-W07', signups: 134 }, { week: '2026-W08', signups: 156 },
          ],
          rowCount: 4,
        },
      },
      {
        match: { sql: 'active' },
        response: {
          rows: [
            { week: '2026-W05', wau: 634 }, { week: '2026-W06', wau: 689 },
            { week: '2026-W07', wau: 741 }, { week: '2026-W08', wau: 892 },
          ],
          rowCount: 4,
        },
      },
      {
        match: { sql: 'retention' },
        response: {
          rows: [{ cohort: 'Jan 2026', week1: 100, week2: 72, week4: 58, week8: 41 }],
          rowCount: 1,
        },
      },
    ],
    default: {
      rows: [
        { metric: 'total_users', value: 1247 }, { metric: 'wau', value: 892 },
        { metric: 'signups_this_week', value: 156 }, { metric: 'trial_to_paid_pct', value: 12.4 },
      ],
      rowCount: 4,
    },
  },
  GITHUB_LIST_PULL_REQUESTS: {
    type: 'static',
    description: 'List recent pull requests.',
    paramKeys: ['owner', 'repo', 'state'],
    response: {
      summary: { merged_this_week: 14, avg_cycle_time_hours: 18.5, open_prs: 7, avg_review_time_hours: 4.2 },
      recent: [
        { number: 89, title: 'Implement API rate limiting', author: 'dave', merged_at: '2026-02-21T16:00:00Z', additions: 342, deletions: 28 },
        { number: 87, title: 'Add database indexes for search', author: 'eve', merged_at: '2026-02-21T11:00:00Z', additions: 45, deletions: 3 },
        { number: 86, title: 'Fix memory leak in WS handler', author: 'alice', merged_at: '2026-02-20T14:00:00Z', additions: 12, deletions: 67 },
        { number: 85, title: 'Upgrade auth library to v4', author: 'bob', merged_at: '2026-02-20T10:00:00Z', additions: 156, deletions: 203 },
      ],
    },
  },
}

// ---------------------------------------------------------------------------
// Fixture: Airbnb Vacation Planner — MCP Discovery + Canvas Dashboard
// Full flow: search → install → use airbnb tool → build canvas with OPEN links
// ---------------------------------------------------------------------------

export const AIRBNB_VACATION_PLANNER_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'pattern',
    description: 'Search for MCP servers by capability or keyword.',
    paramKeys: ['query', 'limit'],
    patterns: [
      {
        match: { query: 'airbnb' },
        response: {
          query: 'airbnb',
          results: [
            { name: 'Airbnb MCP Server', qualifiedName: '@openbnb/mcp-server-airbnb', description: 'Search Airbnb listings, get pricing, availability, and property details. Access real Airbnb data for travel planning.', installCommand: 'npx -y @openbnb/mcp-server-airbnb', source: 'catalog', category: 'travel', relevanceScore: 95 },
          ],
          message: 'Found 1 MCP server(s). Use tool_install to add one.',
        },
      },
    ],
    default: {
      query: 'travel',
      results: [
        { name: 'Airbnb MCP Server', qualifiedName: '@openbnb/mcp-server-airbnb', description: 'Search Airbnb listings, get pricing, availability, and property details.', installCommand: 'npx -y @openbnb/mcp-server-airbnb', source: 'catalog', category: 'travel', relevanceScore: 80 },
      ],
      message: 'Found 1 MCP server(s). Use tool_install to add one.',
    },
  },
  tool_install: {
    type: 'static',
    description: 'Install and start an MCP server, making its tools available immediately.',
    paramKeys: ['name', 'command', 'args', 'env'],
    response: {
      ok: true,
      server: 'airbnb',
      toolCount: 2,
      tools: [
        { name: 'mcp_airbnb_airbnb_search', description: 'Search for Airbnb listings by location, dates, guests, and filters' },
        { name: 'mcp_airbnb_airbnb_listing_details', description: 'Get detailed information about a specific Airbnb listing' },
      ],
      message: 'Installed "airbnb" with 2 tool(s). Auth is active — connected and ready. Call mcp_airbnb_airbnb_search now to find listings.',
    },
  },
  mcp_airbnb_airbnb_search: {
    type: 'static',
    description: 'Search for Airbnb listings by location, dates, guests, and filters.',
    paramKeys: ['location', 'checkin', 'checkout', 'adults', 'ignoreRobotstxt'],
    hidden: true,
    response: {
      listings: [
        { id: '1001', name: 'Ubud Jungle Retreat — Private Pool Villa', url: 'https://www.airbnb.com/rooms/1001', price: { amount: 85, currency: 'USD', period: 'night' }, rating: 4.96, reviewCount: 234, beds: '1 king', bathrooms: 1, amenities: ['Pool', 'WiFi', 'Kitchen', 'Garden view'], superhost: true, location: 'Ubud, Bali' },
        { id: '1002', name: 'Rice Terrace Eco Lodge — Organic Breakfast', url: 'https://www.airbnb.com/rooms/1002', price: { amount: 62, currency: 'USD', period: 'night' }, rating: 4.92, reviewCount: 187, beds: '1 queen', bathrooms: 1, amenities: ['WiFi', 'Breakfast', 'Garden view', 'Yoga deck'], superhost: true, location: 'Tegallalang, Ubud' },
        { id: '1003', name: 'Bamboo House in the Heart of Ubud', url: 'https://www.airbnb.com/rooms/1003', price: { amount: 45, currency: 'USD', period: 'night' }, rating: 4.89, reviewCount: 312, beds: '1 double', bathrooms: 1, amenities: ['WiFi', 'Kitchen', 'Terrace', 'Bicycle'], superhost: false, location: 'Central Ubud' },
        { id: '1004', name: 'Peaceful Garden Bungalow — Near Organic Cafes', url: 'https://www.airbnb.com/rooms/1004', price: { amount: 38, currency: 'USD', period: 'night' }, rating: 4.95, reviewCount: 156, beds: '1 queen', bathrooms: 1, amenities: ['WiFi', 'Garden', 'Kitchen', 'Free parking'], superhost: true, location: 'Ubud, Bali' },
        { id: '1005', name: 'Treehouse Experience — Ayung River Valley', url: 'https://www.airbnb.com/rooms/1005', price: { amount: 120, currency: 'USD', period: 'night' }, rating: 4.98, reviewCount: 89, beds: '1 king', bathrooms: 1, amenities: ['Pool', 'WiFi', 'Breakfast', 'River view', 'Spa'], superhost: true, location: 'Ubud, Bali' },
      ],
      totalResults: 5,
      location: 'Ubud, Bali',
    },
  },
  mcp_airbnb_airbnb_listing_details: {
    type: 'pattern',
    description: 'Get detailed information about a specific Airbnb listing.',
    paramKeys: ['listingId'],
    hidden: true,
    patterns: [
      {
        match: { listingId: '1001' },
        response: { id: '1001', name: 'Ubud Jungle Retreat — Private Pool Villa', description: 'Nestled in the lush jungles of Ubud, this private villa features an infinity pool, open-air living, and is a 10-minute walk from organic restaurants.', host: 'Made Wijaya', url: 'https://www.airbnb.com/rooms/1001', price: { amount: 85, currency: 'USD', period: 'night', total: 935 } },
      },
    ],
    default: { id: 'unknown', name: 'Listing', description: 'A listing in Ubud.', url: 'https://www.airbnb.com/rooms/unknown' },
  },
}

// ---------------------------------------------------------------------------
// Fixture: Composio Google Calendar Discovery (Composio Case 1)
// Full Composio flow: tool_search → tool_install → SEARCH_TOOLS → MANAGE_CONNECTIONS → MULTI_EXECUTE
// ---------------------------------------------------------------------------

export const COMPOSIO_GOOGLE_CALENDAR_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'pattern',
    description: 'Search for MCP servers by capability or keyword.',
    paramKeys: ['query', 'limit'],
    patterns: [
      {
        match: { query: 'google calendar' },
        response: {
          query: 'google calendar',
          results: [
            { name: 'googlecalendar', description: 'Google Calendar — manage events, check availability, create and update meetings', source: 'composio' },
          ],
          message: 'Found 1 integration(s). Composio results are preferred — install with just the name.',
        },
      },
      {
        match: { query: 'calendar' },
        response: {
          query: 'calendar',
          results: [
            { name: 'googlecalendar', description: 'Google Calendar — manage events, check availability, create and update meetings', source: 'composio' },
          ],
          message: 'Found 1 integration(s). Composio results are preferred — install with just the name.',
        },
      },
    ],
    default: { query: 'unknown', results: [], message: 'No integrations found.' },
  },
  tool_install: {
    type: 'static',
    description: 'Install and start an MCP server, making its tools available immediately.',
    paramKeys: ['name'],
    response: {
      ok: true,
      server: 'composio',
      integration: 'googlecalendar',
      toolCount: 4,
      tools: [
        'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS',
        'GOOGLECALENDAR_LIST_CALENDARS',
        'GOOGLECALENDAR_EVENTS_LIST',
        'GOOGLECALENDAR_CREATE_EVENT',
      ],
      authStatus: 'active',
      message: 'Installed googlecalendar with 4 tool(s). Auth is active.',
    },
  },
GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS: {
    type: 'static',
    description: 'List events across all calendars within a time range.',
    paramKeys: ['time_min', 'time_max', 'single_events'],
    hidden: true,
    response: {
      data: {
        summary_view: [
          { title: 'Team Standup', start: '2026-02-23T09:00:00-08:00', end: '2026-02-23T09:15:00-08:00', calendar: 'Work' },
          { title: 'Product Review', start: '2026-02-23T11:00:00-08:00', end: '2026-02-23T12:00:00-08:00', calendar: 'Work' },
          { title: 'Lunch with Sarah', start: '2026-02-23T12:30:00-08:00', end: '2026-02-23T13:30:00-08:00', calendar: 'Personal' },
          { title: '1:1 with Manager', start: '2026-02-24T10:00:00-08:00', end: '2026-02-24T10:30:00-08:00', calendar: 'Work' },
          { title: 'Sprint Planning', start: '2026-02-24T14:00:00-08:00', end: '2026-02-24T15:00:00-08:00', calendar: 'Work' },
          { title: 'Engineering All-Hands', start: '2026-02-25T11:00:00-08:00', end: '2026-02-25T12:00:00-08:00', calendar: 'Work' },
          { title: 'Dentist Appointment', start: '2026-02-26T15:00:00-08:00', end: '2026-02-26T16:00:00-08:00', calendar: 'Personal' },
          { title: 'Friday Demo', start: '2026-02-27T14:00:00-08:00', end: '2026-02-27T15:00:00-08:00', calendar: 'Work' },
        ],
        total_events: 8,
      },
      successful: true,
    },
  },
}

// ---------------------------------------------------------------------------
// Fixture: Composio preference over local MCP (Composio Case 2)
// tool_search returns both Composio and npm results
// ---------------------------------------------------------------------------

export const COMPOSIO_PREFERENCE_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'static',
    description: 'Search for MCP servers by capability or keyword.',
    paramKeys: ['query', 'limit'],
    response: {
      query: 'github',
      results: [
        { name: 'github', description: 'GitHub — manage repos, issues, PRs, actions, and code', source: 'composio' },
        { name: 'GitHub MCP Server', qualifiedName: '@modelcontextprotocol/server-github', description: 'Access GitHub repos, issues, PRs, and actions.', installCommand: 'npx -y @modelcontextprotocol/server-github', source: 'npm' },
      ],
      message: 'Found 2 integration(s). Composio results are preferred.',
    },
  },
  tool_install: {
    type: 'static',
    description: 'Install and start an MCP server.',
    paramKeys: ['name'],
    response: {
      ok: true,
      server: 'composio',
      integration: 'github',
      toolCount: 3,
      tools: ['GITHUB_LIST_ISSUES', 'GITHUB_CREATE_ISSUE', 'GITHUB_LIST_PULL_REQUESTS'],
      authStatus: 'active',
      message: 'Installed github with 3 tool(s). Auth is active.',
    },
  },
GITHUB_LIST_ISSUES: {
    type: 'static',
    description: 'List issues in a repository.',
    paramKeys: ['repo', 'state'],
    hidden: true,
    response: {
      data: [
        { number: 42, title: 'Fix login SSO bug', labels: ['bug', 'critical'], assignee: 'alice', state: 'open' },
        { number: 38, title: 'Memory leak in WS handler', labels: ['bug'], assignee: null, state: 'open' },
        { number: 35, title: 'Add dark mode', labels: ['enhancement'], assignee: 'bob', state: 'open' },
      ],
      successful: true,
    },
  },
}

// ---------------------------------------------------------------------------
// Fixture: Composio auth required (Composio Case 4)
// MANAGE_CONNECTIONS returns needs_auth with URL
// ---------------------------------------------------------------------------

export const COMPOSIO_AUTH_REQUIRED_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'static',
    paramKeys: ['query', 'limit'],
    response: {
      query: 'gmail',
      results: [
        { name: 'gmail', description: 'Gmail — send, read, and manage emails', source: 'composio' },
      ],
      message: 'Found 1 integration(s).',
    },
  },
  tool_install: {
    type: 'static',
    paramKeys: ['name'],
    response: {
      ok: true,
      server: 'composio',
      integration: 'gmail',
      toolCount: 2,
      tools: ['GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL'],
      authStatus: 'needs_auth',
      authUrl: 'https://connect.composio.dev/link/lk_test123',
      message: 'Installed gmail with 2 tool(s). User needs to authorize: https://connect.composio.dev/link/lk_test123',
    },
  },
GMAIL_FETCH_EMAILS: {
    type: 'static',
    paramKeys: ['query', 'max_results'],
    hidden: true,
    response: { error: 'Not authenticated. User must complete OAuth first.' },
  },
GMAIL_SEND_EMAIL: {
    type: 'static',
    paramKeys: ['to', 'subject', 'body'],
    hidden: true,
    response: { error: 'Not authenticated. User must complete OAuth first.' },
  },
}

// ---------------------------------------------------------------------------
// Fixture: Composio Gmail send (Composio Case 5)
// Pre-authenticated Gmail write operation
// ---------------------------------------------------------------------------

export const COMPOSIO_GMAIL_SEND_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'static',
    paramKeys: ['query', 'limit'],
    response: {
      query: 'gmail',
      results: [
        { name: 'gmail', description: 'Gmail — send, read, and manage emails', source: 'composio' },
      ],
      message: 'Found 1 integration(s).',
    },
  },
  tool_install: {
    type: 'static',
    paramKeys: ['name'],
    response: {
      ok: true,
      server: 'composio',
      integration: 'gmail',
      toolCount: 3,
      tools: ['GMAIL_SEND_EMAIL', 'GMAIL_FETCH_EMAILS', 'GMAIL_CREATE_DRAFT'],
      authStatus: 'active',
      message: 'Installed gmail with 3 tool(s). Auth is active.',
    },
  },
GMAIL_SEND_EMAIL: {
    type: 'static',
    description: 'Send an email via Gmail.',
    paramKeys: ['to', 'subject', 'body'],
    hidden: true,
    response: {
      data: { message_id: 'msg_abc123', thread_id: 'thread_xyz', to: 'john@example.com', subject: 'Meeting Tomorrow', status: 'sent' },
      successful: true,
    },
  },
GMAIL_FETCH_EMAILS: {
    type: 'static',
    description: 'Fetch emails from inbox.',
    paramKeys: ['query', 'max_results'],
    hidden: true,
    response: { data: [], successful: true },
  },
}

// ---------------------------------------------------------------------------
// Fixture: Composio GitHub PR — skill auto-save eval (Composio Case 6)
// Full discovery flow + write_file to save skill
// ---------------------------------------------------------------------------

export const COMPOSIO_GITHUB_PR_SKILL_SAVE_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'static',
    paramKeys: ['query', 'limit'],
    response: {
      query: 'github',
      results: [
        { name: 'github', description: 'GitHub — manage repos, issues, PRs, actions, and code', source: 'composio' },
      ],
      message: 'Found 1 integration(s). Composio results are preferred.',
    },
  },
  tool_install: {
    type: 'static',
    paramKeys: ['name'],
    response: {
      ok: true,
      server: 'composio',
      integration: 'github',
      toolCount: 3,
      tools: ['GITHUB_LIST_PULL_REQUESTS', 'GITHUB_GET_PULL_REQUEST', 'GITHUB_CREATE_PULL_REQUEST'],
      authStatus: 'active',
      message: 'Installed github with 3 tool(s). Auth is active.',
    },
  },
GITHUB_LIST_PULL_REQUESTS: {
    type: 'static',
    description: 'List your open pull requests across all repos.',
    paramKeys: ['owner', 'repo', 'state'],
    hidden: true,
    response: {
      data: [
        { number: 42, title: 'Fix critical auth bypass', author: 'alice', state: 'open', labels: ['security', 'urgent'], created_at: '2026-02-20T08:00:00Z' },
        { number: 41, title: 'Add logging middleware', author: 'bob', state: 'open', labels: ['enhancement'], created_at: '2026-02-21T10:00:00Z' },
        { number: 40, title: 'Update dependencies', author: 'dependabot', state: 'open', labels: ['dependencies'], created_at: '2026-02-19T06:00:00Z' },
      ],
      successful: true,
    },
  },
  write_file: {
    type: 'static',
    paramKeys: ['path', 'content'],
    response: { ok: true, path: 'skills/github-pull-requests.md', bytes: 512 },
  },
  list_files: {
    type: 'static',
    paramKeys: ['path'],
    response: { files: [], total: 0 },
  },
  read_file: {
    type: 'static',
    paramKeys: ['path'],
    response: { error: 'File not found' },
  },
}

// ---------------------------------------------------------------------------
// Fixture: Airbnb local MCP — skill auto-save eval (Composio Case 7)
// search → install local → use → write_file to save skill
// ---------------------------------------------------------------------------

export const AIRBNB_SKILL_SAVE_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'static',
    paramKeys: ['query', 'limit'],
    response: {
      query: 'airbnb',
      results: [
        { name: 'Airbnb MCP Server', qualifiedName: '@openbnb/mcp-server-airbnb', description: 'Search Airbnb listings, get pricing, availability, and property details.', installCommand: 'npx -y @openbnb/mcp-server-airbnb', source: 'catalog' },
      ],
      message: 'Found 1 MCP server(s). Use tool_install to add one.',
    },
  },
  tool_install: {
    type: 'static',
    paramKeys: ['name', 'command', 'args', 'env'],
    response: {
      ok: true,
      server: 'airbnb',
      toolCount: 2,
      tools: [
        { name: 'mcp_airbnb_airbnb_search', description: 'Search for Airbnb listings by location, dates, guests' },
        { name: 'mcp_airbnb_airbnb_listing_details', description: 'Get details about a specific listing' },
      ],
      message: 'Installed "airbnb" with 2 tool(s). Auth is active — connected and ready. Call mcp_airbnb_airbnb_search now to find listings.',
    },
  },
  mcp_airbnb_airbnb_search: {
    type: 'static',
    description: 'Search for Airbnb listings by location, dates, guests',
    paramKeys: ['location', 'checkin', 'checkout', 'adults'],
    hidden: true,
    response: {
      listings: [
        { id: '1001', name: 'Ubud Jungle Retreat — Private Pool Villa', url: 'https://www.airbnb.com/rooms/1001', price: { amount: 85, currency: 'USD', period: 'night' }, rating: 4.96, reviewCount: 234, location: 'Ubud, Bali' },
        { id: '1002', name: 'Rice Terrace Eco Lodge', url: 'https://www.airbnb.com/rooms/1002', price: { amount: 62, currency: 'USD', period: 'night' }, rating: 4.92, reviewCount: 187, location: 'Tegallalang, Ubud' },
        { id: '1003', name: 'Bamboo House in Ubud', url: 'https://www.airbnb.com/rooms/1003', price: { amount: 45, currency: 'USD', period: 'night' }, rating: 4.89, reviewCount: 312, location: 'Central Ubud' },
      ],
      totalResults: 3,
      location: 'Ubud, Bali',
    },
  },
  write_file: {
    type: 'static',
    paramKeys: ['path', 'content'],
    response: { ok: true, path: 'skills/airbnb-search.md', bytes: 480 },
  },
  list_files: {
    type: 'static',
    paramKeys: ['path'],
    response: { files: [], total: 0 },
  },
  read_file: {
    type: 'static',
    paramKeys: ['path'],
    response: { error: 'File not found' },
  },
}

// ---------------------------------------------------------------------------
// Fixture: Composio Calendar follow-up — multi-turn eval (Composio Case 8)
// Tools already installed from turn 1, agent creates an event in turn 2
// ---------------------------------------------------------------------------

export const COMPOSIO_CALENDAR_FOLLOWUP_MOCKS: ToolMockMap = {
GOOGLECALENDAR_CREATE_EVENT: {
    type: 'static',
    description: 'Create a new calendar event.',
    paramKeys: ['summary', 'start', 'end'],
    response: {
      data: { id: 'evt-new-001', summary: 'Team Sync', start: '2026-02-24T14:00:00-08:00', end: '2026-02-24T15:00:00-08:00', status: 'confirmed', htmlLink: 'https://calendar.google.com/event?eid=evt-new-001' },
      successful: true,
    },
  },
GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS: {
    type: 'static',
    description: 'List events across all calendars.',
    paramKeys: ['time_min', 'time_max'],
    response: { data: { items: [], total_events: 0 }, successful: true },
  },
  tool_install: {
    type: 'static',
    paramKeys: ['name'],
    response: {
      ok: true,
      server: 'composio',
      integration: 'googlecalendar',
      toolCount: 2,
      tools: ['GOOGLECALENDAR_CREATE_EVENT', 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS'],
      authStatus: 'active',
      message: 'Installed googlecalendar with 2 tool(s). Auth is active.',
    },
  },
}

// ---------------------------------------------------------------------------
// Fixture: Gmail + Calendar multi-skill (Composio Case 9)
// Both Gmail and Calendar via Composio in one session
// ---------------------------------------------------------------------------

export const COMPOSIO_GMAIL_CALENDAR_MULTI_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'pattern',
    paramKeys: ['query', 'limit'],
    patterns: [
      {
        match: { query: 'gmail' },
        response: {
          query: 'gmail',
          results: [{ name: 'gmail', description: 'Gmail — send, read, and manage emails', source: 'composio' }],
          message: 'Found 1 integration(s).',
        },
      },
      {
        match: { query: 'email' },
        response: {
          query: 'email',
          results: [{ name: 'gmail', description: 'Gmail — send, read, and manage emails', source: 'composio' }],
          message: 'Found 1 integration(s).',
        },
      },
      {
        match: { query: 'calendar' },
        response: {
          query: 'calendar',
          results: [{ name: 'googlecalendar', description: 'Google Calendar — manage events, check availability', source: 'composio' }],
          message: 'Found 1 integration(s).',
        },
      },
      {
        match: { query: 'google calendar' },
        response: {
          query: 'google calendar',
          results: [{ name: 'googlecalendar', description: 'Google Calendar — manage events, check availability', source: 'composio' }],
          message: 'Found 1 integration(s).',
        },
      },
    ],
    default: {
      query: 'gmail calendar',
      results: [
        { name: 'gmail', description: 'Gmail — send, read, and manage emails', source: 'composio' },
        { name: 'googlecalendar', description: 'Google Calendar — manage events, check availability', source: 'composio' },
      ],
      message: 'Found 2 integration(s).',
    },
  },
  tool_install: {
    type: 'pattern',
    paramKeys: ['name'],
    patterns: [
      {
        match: { name: 'gmail' },
        response: {
          ok: true, server: 'composio', integration: 'gmail', toolCount: 2,
          tools: ['GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL'],
          authStatus: 'active',
          message: 'Installed gmail with 2 tool(s). Auth is active.',
        },
      },
      {
        match: { name: 'googlecalendar' },
        response: {
          ok: true, server: 'composio', integration: 'googlecalendar', toolCount: 2,
          tools: ['GOOGLECALENDAR_CREATE_EVENT', 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS'],
          authStatus: 'active',
          message: 'Installed googlecalendar with 2 tool(s). Auth is active.',
        },
      },
    ],
    default: {
      ok: true, server: 'composio', integration: 'unknown', toolCount: 0, tools: [],
      authStatus: 'active', message: 'Installed integration.',
    },
  },
GMAIL_FETCH_EMAILS: {
    type: 'static',
    description: 'Fetch emails from inbox.',
    paramKeys: ['query', 'max_results'],
    hidden: true,
    response: {
      data: [
        { from: 'john@example.com', subject: 'Re: Budget proposal for Q2', date: '2026-02-25T10:30:00Z', snippet: 'Hey, I reviewed the budget numbers. The Q2 allocation looks good but we need to discuss the marketing spend. Can we meet tomorrow?' },
        { from: 'john@example.com', subject: 'Budget spreadsheet attached', date: '2026-02-24T14:00:00Z', snippet: 'Here is the updated budget spreadsheet with the Q1 actuals filled in. Let me know if the projections make sense.' },
      ],
      successful: true,
    },
  },
GMAIL_SEND_EMAIL: {
    type: 'static',
    description: 'Send an email via Gmail.',
    paramKeys: ['to', 'subject', 'body'],
    hidden: true,
    response: { data: { message_id: 'msg_abc123', status: 'sent' }, successful: true },
  },
GOOGLECALENDAR_CREATE_EVENT: {
    type: 'static',
    description: 'Create a new calendar event.',
    paramKeys: ['summary', 'start', 'end'],
    hidden: true,
    response: {
      data: { id: 'evt-budget-001', summary: 'Budget Review Meeting', start: '2026-02-27T15:00:00-08:00', end: '2026-02-27T16:00:00-08:00', status: 'confirmed' },
      successful: true,
    },
  },
GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS: {
    type: 'static',
    description: 'List events across all calendars.',
    paramKeys: ['time_min', 'time_max'],
    hidden: true,
    response: { data: { items: [], total_events: 0 }, successful: true },
  },
}

// ---------------------------------------------------------------------------
// buildMockPayload — merges per-eval mocks with defaults
// ---------------------------------------------------------------------------
// Fixture: Real-data preference — GitHub issues dashboard (Real-Data Case 1)
// User says "show my GitHub issues" → agent should search for integration, NOT seed fake data
// ---------------------------------------------------------------------------

export const REAL_DATA_GITHUB_ISSUES_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'pattern',
    description: 'Search for MCP servers by capability or keyword.',
    paramKeys: ['query', 'limit'],
    patterns: [
      {
        match: { query: 'github' },
        response: {
          query: 'github',
          results: [
            { name: 'github', description: 'GitHub — manage repos, issues, PRs, and more via Composio OAuth', source: 'composio' },
            { name: '@modelcontextprotocol/server-github', description: 'GitHub MCP server (npm)', source: 'npm' },
          ],
          message: 'Found 2 result(s). 1 is a Composio managed integration (no credentials needed) — prefer it.',
        },
      },
    ],
    default: { query: 'unknown', results: [], message: 'No integrations found.' },
  },
  tool_install: {
    type: 'static',
    description: 'Install and start an MCP server, making its tools available immediately.',
    paramKeys: ['name'],
    response: {
      ok: true,
      server: 'composio',
      integration: 'github',
      toolCount: 3,
      tools: ['GITHUB_LIST_ISSUES', 'GITHUB_GET_ISSUE', 'GITHUB_CREATE_ISSUE'],
      authStatus: 'active',
      message: 'Installed github with 3 tool(s). Auth is active.',
    },
  },
GITHUB_LIST_ISSUES: {
    type: 'static',
    description: 'List issues in a repository.',
    paramKeys: ['repo', 'state'],
    hidden: true,
    response: {
      data: {
        issues: [
          { number: 142, title: 'Login page CSS broken on mobile', state: 'open', labels: ['bug', 'frontend'], assignee: 'alice', created_at: '2026-02-20T10:00:00Z' },
          { number: 138, title: 'API rate limiter not working for batch endpoints', state: 'open', labels: ['bug', 'backend'], assignee: 'bob', created_at: '2026-02-18T14:30:00Z' },
          { number: 135, title: 'Add dark mode support', state: 'open', labels: ['enhancement'], assignee: null, created_at: '2026-02-15T09:00:00Z' },
          { number: 131, title: 'Memory leak in WebSocket handler', state: 'open', labels: ['bug', 'critical'], assignee: 'carol', created_at: '2026-02-12T16:45:00Z' },
          { number: 127, title: 'Upgrade TypeScript to 5.4', state: 'open', labels: ['chore'], assignee: 'dave', created_at: '2026-02-10T11:00:00Z' },
        ],
        total_count: 5,
      },
      successful: true,
    },
  },
}

// ---------------------------------------------------------------------------
// Fixture: Real-data preference — Expense tracker with uploaded CSV (Real-Data Case 2)
// User uploaded a CSV → agent should read it, NOT invent fake expenses
// ---------------------------------------------------------------------------

export const REAL_DATA_UPLOADED_CSV_MOCKS: ToolMockMap = {
  list_files: {
    type: 'static',
    description: 'List files in a directory.',
    paramKeys: ['directory'],
    response: {
      files: [
        { name: 'expenses.csv', path: 'files/expenses.csv', size: 1245, type: 'file' },
      ],
    },
  },
  read_file: {
    type: 'pattern',
    description: 'Read the contents of a file.',
    paramKeys: ['path'],
    patterns: [
      {
        match: { path: 'expenses' },
        response: {
          content: 'date,description,amount,category\n2026-02-01,AWS hosting,342.50,Infrastructure\n2026-02-03,Figma subscription,15.00,Design\n2026-02-05,Team lunch,187.30,Team\n2026-02-08,Google Workspace,72.00,Software\n2026-02-10,Conference tickets,499.00,Events\n2026-02-14,Office supplies,63.25,Office\n2026-02-18,Uber for client meeting,28.40,Travel\n2026-02-20,Slack subscription,12.50,Software\n2026-02-22,Catering for demo day,215.00,Team\n2026-02-25,Domain renewal,14.99,Infrastructure',
          path: 'files/expenses.csv',
        },
      },
    ],
    default: { content: '', path: 'unknown' },
  },
  search_files: {
    type: 'static',
    description: 'Search across indexed files using hybrid keyword + semantic search.',
    paramKeys: ['query'],
    response: {
      results: [
        { path: 'files/expenses.csv', score: 0.95, snippet: 'date,description,amount,category\n2026-02-01,AWS hosting,342.50,Infrastructure' },
      ],
    },
  },
}

// ---------------------------------------------------------------------------
// Fixture: Real-data preference — Google Sheets expense data (Real-Data Case 3)
// User says "pull my expenses from Google Sheets" → agent should use Composio
// ---------------------------------------------------------------------------

export const REAL_DATA_GOOGLE_SHEETS_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'pattern',
    description: 'Search for MCP servers by capability or keyword.',
    paramKeys: ['query', 'limit'],
    patterns: [
      {
        match: { query: 'google sheets' },
        response: {
          query: 'google sheets',
          results: [
            { name: 'googlesheets', description: 'Google Sheets — read, write, and manage spreadsheets via Composio OAuth', source: 'composio' },
          ],
          message: 'Found 1 result(s). Composio managed integration — no credentials needed.',
        },
      },
      {
        match: { query: 'google' },
        response: {
          query: 'google',
          results: [
            { name: 'googlesheets', description: 'Google Sheets — read, write, and manage spreadsheets via Composio OAuth', source: 'composio' },
          ],
          message: 'Found 1 result(s). Composio managed integration — no credentials needed.',
        },
      },
      {
        match: { query: 'sheets' },
        response: {
          query: 'sheets',
          results: [
            { name: 'googlesheets', description: 'Google Sheets — read, write, and manage spreadsheets via Composio OAuth', source: 'composio' },
          ],
          message: 'Found 1 result(s). Composio managed integration — no credentials needed.',
        },
      },
      {
        match: { query: 'spreadsheet' },
        response: {
          query: 'spreadsheet',
          results: [
            { name: 'googlesheets', description: 'Google Sheets — read, write, and manage spreadsheets via Composio OAuth', source: 'composio' },
          ],
          message: 'Found 1 result(s). Composio managed integration — no credentials needed.',
        },
      },
    ],
    default: { query: 'unknown', results: [], message: 'No integrations found.' },
  },
  tool_install: {
    type: 'static',
    description: 'Install and start an MCP server, making its tools available immediately.',
    paramKeys: ['name'],
    response: {
      ok: true,
      server: 'composio',
      integration: 'googlesheets',
      toolCount: 3,
      tools: ['GOOGLESHEETS_GET_SPREADSHEET_DATA', 'GOOGLESHEETS_LIST_SPREADSHEETS', 'GOOGLESHEETS_BATCH_UPDATE'],
      authStatus: 'active',
      connected: true,
      message: 'Installed googlesheets with 3 tool(s). Auth is active — connected and ready. Call GOOGLESHEETS_GET_SPREADSHEET_DATA to fetch data.',
    },
  },
  GOOGLESHEETS_GET_SPREADSHEET_DATA: {
    type: 'static',
    description: 'Read data from a spreadsheet.',
    paramKeys: ['spreadsheet_id', 'range'],
    hidden: true,
    response: {
      data: {
        values: [
          ['Date', 'Description', 'Amount', 'Category'],
          ['2026-02-01', 'AWS hosting', '342.50', 'Infrastructure'],
          ['2026-02-03', 'Figma Pro', '15.00', 'Design'],
          ['2026-02-07', 'Team dinner', '245.00', 'Team'],
          ['2026-02-10', 'Zoom subscription', '14.99', 'Software'],
          ['2026-02-15', 'Flight to SF', '389.00', 'Travel'],
        ],
      },
      successful: true,
    },
  },
}

// ---------------------------------------------------------------------------
// Fixture: Generic CRUD — no real data source (Real-Data Case 4)
// "Build me a todo app" → sample data is acceptable here
// ---------------------------------------------------------------------------

export const GENERIC_CRUD_NO_REAL_DATA_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'static',
    description: 'Search for MCP servers by capability or keyword.',
    paramKeys: ['query', 'limit'],
    response: { query: 'unknown', results: [], message: 'No integrations found.' },
  },
}

// ===========================================================================
// Unified Tool System Fixtures
// Tests the unified tool_search / tool_install interface that abstracts
// Composio (managed) and catalog (local MCP) sources behind one API.
// ===========================================================================

// ---------------------------------------------------------------------------
// Fixture: Unified search returning mixed results (managed + catalog)
// ---------------------------------------------------------------------------

export const UNIFIED_SEARCH_MIXED_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'pattern',
    description: 'Search for tools by capability or keyword.',
    paramKeys: ['query', 'limit'],
    patterns: [
      {
        match: { query: 'browser' },
        response: {
          query: 'browser',
          results: [
            { name: 'Playwright Browser', qualifiedName: '@playwright/mcp@latest', description: 'Full browser automation — navigate pages, click elements, fill forms, take screenshots.', source: 'catalog', installCommand: 'npx -y @playwright/mcp@latest', authType: 'none', icon: '🎭' },
          ],
          message: 'Found 1 tool(s). Use tool_install to add one.',
        },
      },
      {
        match: { query: 'calendar' },
        response: {
          query: 'calendar',
          results: [
            { name: 'Google Calendar', qualifiedName: 'googlecalendar', description: 'Google Calendar — managed OAuth integration. No credentials needed.', source: 'managed', authType: 'oauth', composioToolkit: 'googlecalendar' },
          ],
          message: 'Found 1 tool(s). Use tool_install to add one.',
        },
      },
    ],
    default: { query: 'unknown', results: [], message: 'No tools found.' },
  },
  tool_install: {
    type: 'pattern',
    description: 'Install a tool, making its capabilities available immediately.',
    paramKeys: ['name', 'command', 'args', 'env'],
    patterns: [
      {
        match: { name: 'playwright' },
        response: {
          ok: true, server: 'playwright', toolCount: 6,
          tools: [
            { name: 'mcp_playwright_browser_navigate', description: 'Navigate to a URL' },
            { name: 'mcp_playwright_browser_click', description: 'Click an element' },
            { name: 'mcp_playwright_browser_type', description: 'Type text' },
            { name: 'mcp_playwright_browser_snapshot', description: 'Get page snapshot' },
            { name: 'mcp_playwright_browser_take_screenshot', description: 'Take screenshot' },
            { name: 'mcp_playwright_browser_close', description: 'Close browser' },
          ],
          message: 'Installed "playwright" with 6 tool(s). They are now available.',
        },
      },
      {
        match: { name: 'googlecalendar' },
        response: {
          ok: true, server: 'composio', source: 'managed', integration: 'googlecalendar', toolCount: 4,
          tools: ['GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', 'GOOGLECALENDAR_CREATE_EVENT', 'GOOGLECALENDAR_LIST_CALENDARS', 'GOOGLECALENDAR_DELETE_EVENT'],
          authStatus: 'active',
          message: 'Installed googlecalendar with 4 tool(s). Auth is active.',
        },
      },
    ],
    default: { error: 'Unknown tool' },
  },
}

// ---------------------------------------------------------------------------
// Fixture: Jira + Slack managed install and use
// Agent discovers both integrations, installs them, fetches Jira bugs,
// and posts a summary to Slack.
// ---------------------------------------------------------------------------

export const JIRA_SLACK_INSTALL_USE_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'pattern',
    description: 'Search for tools by capability or keyword.',
    paramKeys: ['query', 'limit'],
    patterns: [
      {
        match: { query: 'jira' },
        response: {
          query: 'jira',
          results: [
            { name: 'Jira', qualifiedName: 'jira', description: 'Jira — managed OAuth integration. Track issues, bugs, and sprints.', source: 'managed', authType: 'oauth', composioToolkit: 'jira' },
          ],
          message: 'Found 1 tool(s). Use tool_install to add one.',
        },
      },
      {
        match: { query: 'slack' },
        response: {
          query: 'slack',
          results: [
            { name: 'Slack', qualifiedName: 'slack', description: 'Slack — managed OAuth integration. Send messages, manage channels.', source: 'managed', authType: 'oauth', composioToolkit: 'slack' },
          ],
          message: 'Found 1 tool(s). Use tool_install to add one.',
        },
      },
    ],
    default: {
      query: 'unknown',
      results: [
        { name: 'Jira', qualifiedName: 'jira', description: 'Jira — managed OAuth integration.', source: 'managed', authType: 'oauth', composioToolkit: 'jira' },
        { name: 'Slack', qualifiedName: 'slack', description: 'Slack — managed OAuth integration.', source: 'managed', authType: 'oauth', composioToolkit: 'slack' },
      ],
      message: 'Found 2 tool(s). Use tool_install to add one.',
    },
  },
  tool_install: {
    type: 'pattern',
    description: 'Install a tool, making its capabilities available immediately.',
    paramKeys: ['name', 'command', 'args', 'env'],
    patterns: [
      {
        match: { name: 'jira' },
        response: {
          ok: true, server: 'composio', source: 'managed', integration: 'jira', toolCount: 3,
          tools: ['JIRA_GET_ISSUES', 'JIRA_CREATE_ISSUE', 'JIRA_GET_ISSUE'],
          authStatus: 'active',
          message: 'Installed jira with 3 tool(s). Auth is active.',
        },
      },
      {
        match: { name: 'slack' },
        response: {
          ok: true, server: 'composio', source: 'managed', integration: 'slack', toolCount: 2,
          tools: ['SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL', 'SLACK_LIST_CHANNELS'],
          authStatus: 'active',
          message: 'Installed slack with 2 tool(s). Auth is active.',
        },
      },
    ],
    default: {
      ok: true, server: 'composio', source: 'managed', toolCount: 0, tools: [],
      authStatus: 'active',
      message: 'Connected integration via managed OAuth.',
    },
  },
JIRA_GET_ISSUES: {
    type: 'static',
    description: 'Search and list Jira issues with JQL.',
    paramKeys: ['jql', 'maxResults'],
    hidden: true,
    response: {
      data: {
        issues: [
          { key: 'ENG-401', summary: 'Auth tokens not refreshing on mobile', priority: 'Critical', status: 'Open', assignee: 'alice', created: '2026-02-25' },
          { key: 'ENG-398', summary: 'Payment webhook silently failing for Stripe EU', priority: 'Critical', status: 'Open', assignee: 'bob', created: '2026-02-24' },
          { key: 'ENG-395', summary: 'Dashboard 500 error when filtering by date range', priority: 'Critical', status: 'In Progress', assignee: 'carol', created: '2026-02-23' },
        ],
      },
      successful: true,
    },
  },
SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL: {
    type: 'static',
    description: 'Send a message to a Slack channel.',
    paramKeys: ['channel', 'text'],
    hidden: true,
    response: { data: { ok: true, message: 'Message sent successfully.' }, successful: true },
  },
}

// ---------------------------------------------------------------------------
// Fixture: canvas_api_bind — bind installed tool to canvas CRUD
// Assumes Google Calendar Composio is already installed. Agent must bind
// calendar events to the canvas so the UI can display them.
// ---------------------------------------------------------------------------

export const CANVAS_API_BIND_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'static',
    description: 'Search for tools by capability or keyword.',
    paramKeys: ['query', 'limit'],
    response: {
      query: 'google calendar',
      results: [
        { name: 'Google Calendar', qualifiedName: 'googlecalendar', description: 'Google Calendar — managed OAuth integration.', source: 'managed', authType: 'oauth', composioToolkit: 'googlecalendar' },
      ],
      message: 'Found 1 tool(s).',
    },
  },
  tool_install: {
    type: 'static',
    description: 'Install a tool.',
    paramKeys: ['name'],
    response: {
      ok: true, server: 'composio', source: 'managed', integration: 'googlecalendar', toolCount: 4,
      tools: ['GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', 'GOOGLECALENDAR_CREATE_EVENT', 'GOOGLECALENDAR_GET_EVENT', 'GOOGLECALENDAR_DELETE_EVENT'],
      authStatus: 'active',
      message: 'Installed googlecalendar with 4 tool(s). Auth is active.',
    },
  },
GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS: {
    type: 'static',
    description: 'List events across all calendars.',
    paramKeys: ['time_min', 'time_max'],
    hidden: true,
    response: {
      data: {
        items: [
          { id: 'evt-1', summary: 'Team Standup', start: { dateTime: '2026-02-27T09:00:00-08:00' }, end: { dateTime: '2026-02-27T09:15:00-08:00' } },
          { id: 'evt-2', summary: 'Product Review', start: { dateTime: '2026-02-27T11:00:00-08:00' }, end: { dateTime: '2026-02-27T12:00:00-08:00' } },
        ],
      },
      successful: true,
    },
  },
  canvas_create: {
    type: 'static',
    description: 'Create a new canvas surface.',
    paramKeys: ['title', 'content'],
    response: { ok: true, surfaceId: 'surface-cal-1', url: '/canvas/surface-cal-1' },
  },
  canvas_api_bind: {
    type: 'static',
    description: 'Bind CRUD API routes to installed tools so the canvas can display live data.',
    paramKeys: ['surfaceId', 'model', 'fields', 'bindings', 'cache', 'dataPath'],
    response: {
      ok: true,
      surfaceId: 'surface-cal-1',
      model: 'CalendarEvent',
      endpoint: '/api/calendarevents',
      methods: ['GET /api/calendarevents', 'GET /api/calendarevents/:id'],
      dataPath: '/events',
      message: 'Bound CalendarEvent CRUD to Composio Google Calendar tools. The canvas can now fetch live data. Data auto-loaded at "/events".',
    },
  },
}

// ---------------------------------------------------------------------------
// Fixture: Full lifecycle — search → install → use → bind to canvas
// Tests the complete agent flow from having no tools to displaying live data.
// ---------------------------------------------------------------------------

export const TOOL_LIFECYCLE_FULL_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'static',
    description: 'Search for tools by capability or keyword.',
    paramKeys: ['query', 'limit'],
    response: {
      query: 'github',
      results: [
        { name: 'GitHub', qualifiedName: 'github', description: 'GitHub — managed OAuth integration. Access repos, issues, PRs.', source: 'managed', authType: 'oauth', composioToolkit: 'github' },
      ],
      message: 'Found 1 tool(s). Use tool_install to add one.',
    },
  },
  tool_install: {
    type: 'static',
    description: 'Install a tool.',
    paramKeys: ['name'],
    response: {
      ok: true, server: 'composio', source: 'managed', integration: 'github', toolCount: 3,
      tools: ['GITHUB_LIST_ISSUES', 'GITHUB_CREATE_ISSUE', 'GITHUB_GET_ISSUE'],
      authStatus: 'active',
      message: 'Installed github with 3 tool(s). Auth is active.',
    },
  },
GITHUB_LIST_ISSUES: {
    type: 'static',
    description: 'List issues in a repository.',
    paramKeys: ['owner', 'repo', 'state'],
    hidden: true,
    response: {
      data: {
        items: [
          { number: 42, title: 'Fix auth bypass vulnerability', state: 'open', labels: ['security', 'critical'], assignee: 'alice', created_at: '2026-02-25T10:00:00Z' },
          { number: 38, title: 'Add dark mode support', state: 'open', labels: ['enhancement'], assignee: 'bob', created_at: '2026-02-24T14:00:00Z' },
          { number: 35, title: 'Memory leak in dashboard', state: 'open', labels: ['bug'], assignee: null, created_at: '2026-02-23T08:00:00Z' },
        ],
      },
      successful: true,
    },
  },
  canvas_create: {
    type: 'static',
    description: 'Create a new canvas surface.',
    paramKeys: ['title', 'content'],
    response: { ok: true, surfaceId: 'surface-gh-1', url: '/canvas/surface-gh-1' },
  },
  canvas_api_bind: {
    type: 'static',
    description: 'Bind CRUD API routes to installed tools.',
    paramKeys: ['surfaceId', 'model', 'fields', 'bindings', 'cache', 'dataPath'],
    response: {
      ok: true,
      surfaceId: 'surface-gh-1',
      model: 'GitHubIssue',
      endpoint: '/api/githubissues',
      methods: ['GET /api/githubissues', 'GET /api/githubissues/:id', 'POST /api/githubissues'],
      dataPath: '/issues',
      message: 'Bound GitHubIssue CRUD to GitHub tools. Data auto-loaded at "/issues".',
    },
  },
}

// ---------------------------------------------------------------------------
// Fixture: Composio auto-bind — install triggers auto-bind deferred
// Tests that agent trusts auto-bind and creates canvas efficiently.
// ---------------------------------------------------------------------------

export const TOOL_BIND_AT_INSTALL_MOCKS: ToolMockMap = {
  tool_install: {
    type: 'static',
    description: 'Install a tool. Auto-bind discovers CRUD operations automatically.',
    paramKeys: ['name'],
    response: {
      ok: true, server: 'composio', source: 'managed', integration: 'googlecalendar', toolCount: 4,
      connected: true,
      tools: ['GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', 'GOOGLECALENDAR_CREATE_EVENT', 'GOOGLECALENDAR_LIST_CALENDARS', 'GOOGLECALENDAR_DELETE_EVENT'],
      authStatus: 'active',
      message: 'Installed googlecalendar with 4 tool(s). Auth is active.',
      autoBind: {
        ok: true, deferred: true,
        surfaceId: '(next canvas)',
        entity: 'CalendarEvent',
        message: 'Auto-bind ready — "CalendarEvent" CRUD binding will apply automatically to the next canvas you create.',
      },
    },
  },
  GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS: {
    type: 'static',
    description: 'List events across all calendars.',
    paramKeys: ['time_min', 'time_max'],
    hidden: true,
    response: {
      data: {
        items: [
          { id: 'evt-1', summary: 'Team Standup', start: { dateTime: '2026-02-27T09:00:00-08:00' }, end: { dateTime: '2026-02-27T09:15:00-08:00' } },
          { id: 'evt-2', summary: 'Product Review', start: { dateTime: '2026-02-27T11:00:00-08:00' }, end: { dateTime: '2026-02-27T12:00:00-08:00' } },
          { id: 'evt-3', summary: '1:1 with Manager', start: { dateTime: '2026-02-27T14:00:00-08:00' }, end: { dateTime: '2026-02-27T14:30:00-08:00' } },
        ],
      },
      successful: true,
    },
  },
  canvas_create: {
    type: 'static',
    description: 'Create a new canvas surface.',
    paramKeys: ['surfaceId', 'title'],
    response: { ok: true, surfaceId: 'app', url: '/canvas/app' },
  },
  canvas_update: {
    type: 'static',
    description: 'Update canvas components.',
    paramKeys: ['surfaceId', 'components'],
    response: { ok: true, surfaceId: 'app', status: 'rendered', componentsUpdated: 5 },
  },
}

// ---------------------------------------------------------------------------
// Fixture: Luxury Bali Trip Planner (Trip Planner Eval)
// Agent uses web tool for flight search + discovers Airbnb MCP for accommodations
// ---------------------------------------------------------------------------

export const LUXURY_BALI_TRIP_PLANNER_MOCKS: ToolMockMap = {
  web: {
    type: 'pattern',
    paramKeys: ['url', 'query'],
    patterns: [
      {
        match: { query: 'flight' },
        response: {
          content: `<html><body>
<h1>Flights to Bali (Ngurah Rai International Airport — DPS)</h1>
<div class="flight-result">
  <h3>Singapore Airlines SQ946</h3>
  <p>Departs: LAX 11:30 PM → Arrives: DPS 6:45 AM +2 (via SIN)</p>
  <p>Duration: 19h 15m | Price: $1,250 round trip | Class: Economy</p>
  <p>Business class: $3,400 round trip</p>
</div>
<div class="flight-result">
  <h3>Qatar Airways QR365</h3>
  <p>Departs: LAX 4:15 PM → Arrives: DPS 11:30 PM +1 (via DOH)</p>
  <p>Duration: 23h 15m | Price: $980 round trip | Class: Economy</p>
  <p>Business class: $2,900 round trip</p>
</div>
<div class="flight-result">
  <h3>Cathay Pacific CX873</h3>
  <p>Departs: LAX 1:00 AM → Arrives: DPS 3:45 PM +1 (via HKG)</p>
  <p>Duration: 20h 45m | Price: $1,100 round trip | Class: Economy</p>
  <p>Business class: $3,150 round trip</p>
</div>
</body></html>`,
          status: 200,
          bytes: 820,
          url: 'https://www.google.com/travel/flights',
        },
      },
      {
        match: { query: 'bali' },
        response: {
          content: `<html><body>
<h1>Flights to Bali (DPS)</h1>
<div class="flight-result">
  <h3>Singapore Airlines SQ946 — LAX to DPS</h3>
  <p>Round trip from $980. Business class from $2,900.</p>
  <p>Multiple daily flights via Singapore.</p>
</div>
<div class="flight-result">
  <h3>Qatar Airways — LAX to DPS via Doha</h3>
  <p>Round trip from $1,100. Business class from $3,150.</p>
</div>
</body></html>`,
          status: 200,
          bytes: 480,
          url: 'https://www.google.com/travel/flights?q=bali',
        },
      },
      {
        match: { url: 'flight' },
        response: {
          content: `<html><body>
<h1>Flight Search Results — Bali</h1>
<div class="result">
  <h3>Singapore Airlines — $980 round trip (economy) / $2,900 (business)</h3>
  <p>LAX → DPS via SIN, 19h 15m</p>
</div>
<div class="result">
  <h3>Qatar Airways — $1,100 round trip (economy) / $3,150 (business)</h3>
  <p>LAX → DPS via DOH, 23h 15m</p>
</div>
<div class="result">
  <h3>Cathay Pacific — $1,250 round trip (economy) / $3,400 (business)</h3>
  <p>LAX → DPS via HKG, 20h 45m</p>
</div>
</body></html>`,
          status: 200,
          bytes: 520,
          url: 'https://www.google.com/travel/flights',
        },
      },
      {
        match: { url: 'restaurant' },
        response: {
          content: `<html><body>
<h1>Top Luxury Restaurants in Bali</h1>
<ol>
  <li><strong>Locavore</strong> — Ubud. Tasting menu $150/person. Award-winning farm-to-table.</li>
  <li><strong>Mozaic</strong> — Ubud. French-Indonesian fusion. Degustation $120/person.</li>
  <li><strong>Swept Away at The Samaya</strong> — Ubud. Riverside fine dining, $80-120/person.</li>
  <li><strong>Sundara</strong> — Jimbaran. Beachfront, $90-150/person.</li>
  <li><strong>Kubu at Mandapa</strong> — Ubud. Bamboo cocoon fine dining, $130/person.</li>
</ol>
</body></html>`,
          status: 200,
          bytes: 480,
          url: 'https://www.google.com/search?q=luxury+restaurants+bali',
        },
      },
      {
        match: { url: 'activit' },
        response: {
          content: `<html><body>
<h1>Luxury Activities in Bali</h1>
<ul>
  <li><strong>Private Sunrise Trek — Mount Batur</strong> — $120/person with luxury breakfast at summit.</li>
  <li><strong>Private Surf Lesson</strong> — Seminyak Beach, $85/person, 2 hours.</li>
  <li><strong>Balinese Spa Day — COMO Shambhala</strong> — $200, full day wellness retreat.</li>
  <li><strong>Private Temple Tour</strong> — Tirta Empul, Uluwatu, Tanah Lot. $95/person, full day with guide.</li>
  <li><strong>White Water Rafting — Ayung River</strong> — $65/person, includes lunch.</li>
  <li><strong>Cooking Class at Bali Farm</strong> — $75/person, half day with organic ingredients.</li>
</ul>
</body></html>`,
          status: 200,
          bytes: 520,
          url: 'https://www.google.com/search?q=luxury+activities+bali',
        },
      },
      {
        match: { url: 'transport' },
        response: {
          content: `<html><body>
<h1>Transportation in Bali</h1>
<ul>
  <li><strong>Private Driver (full day)</strong> — $40-60/day, air-conditioned car.</li>
  <li><strong>Airport Transfer</strong> — $25-35 one way to Ubud (1.5 hours).</li>
  <li><strong>Scooter Rental</strong> — $5-8/day.</li>
  <li><strong>Luxury Car Rental</strong> — $80-120/day with driver.</li>
</ul>
</body></html>`,
          status: 200,
          bytes: 340,
          url: 'https://www.google.com/search?q=transportation+bali',
        },
      },
    ],
    default: {
      content: '<html><body><h1>Travel Search</h1><p>Bali is a top luxury destination in Indonesia. Flights from the US range $900-$1,300 economy, $2,500-$3,500 business class. Private villas from $80/night, luxury resorts from $200/night.</p></body></html>',
      status: 200,
      bytes: 200,
      url: 'https://www.google.com/search',
    },
  },
  tool_search: {
    type: 'pattern',
    paramKeys: ['query', 'limit'],
    patterns: [
      {
        match: { query: 'airbnb' },
        response: {
          query: 'airbnb',
          results: [
            { name: 'Airbnb MCP Server', qualifiedName: '@openbnb/mcp-server-airbnb', description: 'Search Airbnb listings, get pricing, availability, and property details. Access real Airbnb data for travel planning.', installCommand: 'npx -y @openbnb/mcp-server-airbnb', source: 'catalog', category: 'travel', relevanceScore: 95 },
          ],
          message: 'Found 1 MCP server(s). Use tool_install to add one.',
        },
      },
    ],
    default: {
      query: 'accommodation',
      results: [
        { name: 'Airbnb MCP Server', qualifiedName: '@openbnb/mcp-server-airbnb', description: 'Search Airbnb listings, get pricing, availability, and property details.', installCommand: 'npx -y @openbnb/mcp-server-airbnb', source: 'catalog', category: 'travel', relevanceScore: 80 },
      ],
      message: 'Found 1 MCP server(s). Use tool_install to add one.',
    },
  },
  tool_install: {
    type: 'static',
    paramKeys: ['name', 'command', 'args', 'env'],
    response: {
      ok: true,
      server: 'airbnb',
      toolCount: 2,
      tools: [
        { name: 'mcp_airbnb_airbnb_search', description: 'Search for Airbnb listings by location, dates, guests, and filters' },
        { name: 'mcp_airbnb_airbnb_listing_details', description: 'Get detailed information about a specific Airbnb listing' },
      ],
      message: 'Installed "airbnb" with 2 tool(s). Auth is active — connected and ready. Call mcp_airbnb_airbnb_search now to find listings.',
    },
  },
  mcp_airbnb_airbnb_search: {
    type: 'static',
    description: 'Search for Airbnb listings by location, dates, guests, and filters.',
    paramKeys: ['location', 'checkin', 'checkout', 'adults', 'ignoreRobotstxt'],
    hidden: true,
    response: {
      listings: [
        { id: '2001', name: 'Royal Ubud Luxury Villa — Infinity Pool & Butler', url: 'https://www.airbnb.com/rooms/2001', price: { amount: 220, currency: 'USD', period: 'night' }, rating: 4.98, reviewCount: 156, beds: '2 king', bathrooms: 2, amenities: ['Private Pool', 'Butler Service', 'WiFi', 'Spa', 'Gym', 'Ocean View'], superhost: true, location: 'Ubud, Bali' },
        { id: '2002', name: 'Seminyak Beachfront Boutique Villa', url: 'https://www.airbnb.com/rooms/2002', price: { amount: 185, currency: 'USD', period: 'night' }, rating: 4.95, reviewCount: 203, beds: '1 king, 1 queen', bathrooms: 2, amenities: ['Beach Access', 'Pool', 'WiFi', 'Kitchen', 'BBQ'], superhost: true, location: 'Seminyak, Bali' },
        { id: '2003', name: 'Cliffside Retreat — Uluwatu Panoramic Views', url: 'https://www.airbnb.com/rooms/2003', price: { amount: 310, currency: 'USD', period: 'night' }, rating: 4.99, reviewCount: 87, beds: '1 king', bathrooms: 1, amenities: ['Infinity Pool', 'WiFi', 'Chef Service', 'Cliff View', 'Hot Tub'], superhost: true, location: 'Uluwatu, Bali' },
        { id: '2004', name: 'Tropical Garden Estate — Private Chef Included', url: 'https://www.airbnb.com/rooms/2004', price: { amount: 165, currency: 'USD', period: 'night' }, rating: 4.93, reviewCount: 278, beds: '3 king', bathrooms: 3, amenities: ['Pool', 'Private Chef', 'WiFi', 'Garden', 'Yoga Pavilion'], superhost: true, location: 'Canggu, Bali' },
        { id: '2005', name: 'Jungle Treehouse Villa — Ayung River', url: 'https://www.airbnb.com/rooms/2005', price: { amount: 145, currency: 'USD', period: 'night' }, rating: 4.97, reviewCount: 134, beds: '1 king', bathrooms: 1, amenities: ['River View', 'Pool', 'WiFi', 'Breakfast', 'Spa Access'], superhost: true, location: 'Ubud, Bali' },
      ],
      totalResults: 5,
      location: 'Bali, Indonesia',
    },
  },
  mcp_airbnb_airbnb_listing_details: {
    type: 'pattern',
    description: 'Get detailed information about a specific Airbnb listing.',
    paramKeys: ['listingId'],
    hidden: true,
    patterns: [
      {
        match: { listingId: '2001' },
        response: { id: '2001', name: 'Royal Ubud Luxury Villa — Infinity Pool & Butler', description: 'A stunning 2-bedroom villa set among rice paddies in Ubud. Features a private infinity pool, personal butler, in-villa spa treatments, and gourmet breakfast daily. 10 min from Ubud center.', host: 'Wayan Artika', url: 'https://www.airbnb.com/rooms/2001', price: { amount: 220, currency: 'USD', period: 'night', total: 2200 } },
      },
      {
        match: { listingId: '2003' },
        response: { id: '2003', name: 'Cliffside Retreat — Uluwatu Panoramic Views', description: 'Perched on the cliffs of Uluwatu with 180-degree ocean views. Features an infinity edge pool, private chef, nightly sunset sessions, and direct access to hidden beach.', host: 'Komang Sari', url: 'https://www.airbnb.com/rooms/2003', price: { amount: 310, currency: 'USD', period: 'night', total: 3100 } },
      },
    ],
    default: { id: 'unknown', name: 'Luxury Villa', description: 'A luxury villa in Bali.', url: 'https://www.airbnb.com/rooms/unknown' },
  },
}

// ---------------------------------------------------------------------------

/**
 * Default mocks for built-in tools only (no MCP tools).
 * MCP tool mocks come from each eval's `toolMocks` field.
 */
const BUILTIN_MOCKS: ToolMockMap = {
  web: DEFAULT_WEB_FETCH,
  exec: DEFAULT_EXEC,
  send_message: DEFAULT_SEND_MESSAGE,
  browser: { type: 'static', response: { ok: true, snapshot: '<html>Mock browser snapshot</html>' } },
}

// ---------------------------------------------------------------------------
// Fixture: CI/CD Pipeline Monitor — GitHub Actions Deployments
// Agent should search for GitHub, install it, call GITHUB_LIST_WORKFLOW_RUNS,
// then build a canvas dashboard with deploy status, branch, and trend chart.
// ---------------------------------------------------------------------------

export const CICD_PIPELINE_MOCKS: ToolMockMap = {
  tool_search: {
    type: 'pattern',
    description: 'Search for MCP servers by capability or keyword.',
    paramKeys: ['query', 'limit'],
    patterns: [
      {
        match: { query: 'github' },
        response: {
          query: 'github',
          results: [
            { name: 'github', description: 'GitHub — managed OAuth integration. Access repos, issues, PRs, and Actions.', source: 'composio' },
          ],
          message: 'Found 1 result(s). Use tool_install to add it.',
        },
      },
      {
        match: { query: 'deploy' },
        response: {
          query: 'deploy',
          results: [
            { name: 'github', description: 'GitHub — managed OAuth integration. Access repos, issues, PRs, and Actions.', source: 'composio' },
            { name: 'vercel', description: 'Vercel — managed OAuth integration. View deployments and projects.', source: 'composio' },
          ],
          message: 'Found 2 result(s). Use tool_install to add one.',
        },
      },
      {
        match: { query: 'ci' },
        response: {
          query: 'ci',
          results: [
            { name: 'github', description: 'GitHub — managed OAuth integration. Access repos, issues, PRs, and Actions.', source: 'composio' },
          ],
          message: 'Found 1 result(s). Use tool_install to add it.',
        },
      },
    ],
    default: {
      query: 'deployment',
      results: [
        { name: 'github', description: 'GitHub — managed OAuth integration. Access repos, issues, PRs, and Actions.', source: 'composio' },
      ],
      message: 'Found 1 result(s). Use tool_install to add it.',
    },
  },
  tool_install: {
    type: 'static',
    description: 'Install a tool, making its capabilities available immediately.',
    paramKeys: ['name'],
    response: {
      ok: true,
      server: 'composio',
      integration: 'github',
      toolCount: 3,
      connected: true,
      authStatus: 'active',
      tools: ['GITHUB_LIST_WORKFLOW_RUNS', 'GITHUB_LIST_ISSUES', 'GITHUB_GET_REPO'],
      message: 'Installed github with 3 tool(s). Auth is active — connected and ready.',
    },
  },
  GITHUB_LIST_WORKFLOW_RUNS: {
    type: 'static',
    description: 'List recent workflow runs (deployments) for a GitHub repository.',
    paramKeys: ['owner', 'repo', 'per_page', 'status'],
    hidden: true,
    response: {
      data: {
        workflow_runs: [
          { id: 9001, name: 'Deploy Production', head_branch: 'main', head_sha: 'a1b2c3d', status: 'completed', conclusion: 'success', created_at: '2026-02-27T14:30:00Z', run_started_at: '2026-02-27T14:30:12Z', updated_at: '2026-02-27T14:33:45Z', html_url: 'https://github.com/acme/app/actions/runs/9001' },
          { id: 8998, name: 'Deploy Production', head_branch: 'main', head_sha: 'e4f5g6h', status: 'completed', conclusion: 'failure', created_at: '2026-02-27T10:15:00Z', run_started_at: '2026-02-27T10:15:08Z', updated_at: '2026-02-27T10:18:22Z', html_url: 'https://github.com/acme/app/actions/runs/8998' },
          { id: 8995, name: 'Deploy Staging', head_branch: 'feature/auth-v2', head_sha: 'i7j8k9l', status: 'completed', conclusion: 'success', created_at: '2026-02-26T16:45:00Z', run_started_at: '2026-02-26T16:45:05Z', updated_at: '2026-02-26T16:48:30Z', html_url: 'https://github.com/acme/app/actions/runs/8995' },
          { id: 8990, name: 'Deploy Production', head_branch: 'main', head_sha: 'm0n1o2p', status: 'completed', conclusion: 'success', created_at: '2026-02-26T11:00:00Z', run_started_at: '2026-02-26T11:00:10Z', updated_at: '2026-02-26T11:04:15Z', html_url: 'https://github.com/acme/app/actions/runs/8990' },
          { id: 8987, name: 'Deploy Staging', head_branch: 'fix/memory-leak', head_sha: 'q3r4s5t', status: 'completed', conclusion: 'success', created_at: '2026-02-25T09:30:00Z', run_started_at: '2026-02-25T09:30:08Z', updated_at: '2026-02-25T09:33:50Z', html_url: 'https://github.com/acme/app/actions/runs/8987' },
          { id: 8984, name: 'Deploy Production', head_branch: 'main', head_sha: 'u6v7w8x', status: 'completed', conclusion: 'failure', created_at: '2026-02-24T15:20:00Z', run_started_at: '2026-02-24T15:20:15Z', updated_at: '2026-02-24T15:24:02Z', html_url: 'https://github.com/acme/app/actions/runs/8984' },
          { id: 8980, name: 'Deploy Production', head_branch: 'main', head_sha: 'y9z0a1b', status: 'completed', conclusion: 'success', created_at: '2026-02-24T10:00:00Z', run_started_at: '2026-02-24T10:00:06Z', updated_at: '2026-02-24T10:03:42Z', html_url: 'https://github.com/acme/app/actions/runs/8980' },
          { id: 8976, name: 'Deploy Staging', head_branch: 'feature/dashboard', head_sha: 'c2d3e4f', status: 'completed', conclusion: 'success', created_at: '2026-02-23T17:10:00Z', run_started_at: '2026-02-23T17:10:10Z', updated_at: '2026-02-23T17:13:28Z', html_url: 'https://github.com/acme/app/actions/runs/8976' },
          { id: 8972, name: 'Deploy Production', head_branch: 'main', head_sha: 'g5h6i7j', status: 'completed', conclusion: 'success', created_at: '2026-02-22T13:45:00Z', run_started_at: '2026-02-22T13:45:12Z', updated_at: '2026-02-22T13:48:55Z', html_url: 'https://github.com/acme/app/actions/runs/8972' },
          { id: 8968, name: 'Deploy Production', head_branch: 'main', head_sha: 'k8l9m0n', status: 'in_progress', conclusion: null, created_at: '2026-02-21T11:30:00Z', run_started_at: '2026-02-21T11:30:05Z', updated_at: '2026-02-21T11:31:00Z', html_url: 'https://github.com/acme/app/actions/runs/8968' },
        ],
        total_count: 10,
      },
      successful: true,
    },
  },
}

/**
 * Build the mock payload for an eval. Merges built-in tool mocks with
 * the eval's specific `toolMocks`. Only MCP tools explicitly listed in
 * `toolMocks` will be injected as synthetic tools — this prevents
 * irrelevant MCP tools from confusing the agent.
 */
export function buildMockPayload(
  evalToolMocks?: ToolMockMap,
): ToolMockMap {
  if (!evalToolMocks) return BUILTIN_MOCKS
  return { ...BUILTIN_MOCKS, ...evalToolMocks }
}
