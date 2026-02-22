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
  | { type: 'static'; response: any; description?: string; paramKeys?: string[] }
  | { type: 'pattern'; patterns: Array<{ match: Record<string, string>; response: any }>; default?: any; description?: string; paramKeys?: string[] }

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
  web_fetch: {
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
  mcp__github__list_issues: {
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
  web_fetch: {
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
  web_fetch: {
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
  mcp__sentry__list_issues: {
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
  mcp__google_calendar__list_events: {
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
  web_fetch: {
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
  mcp__stripe__get_balance: {
    type: 'static',
    description: 'Get the current Stripe account balance. Returns available and pending amounts by currency.',
    paramKeys: [],
    response: {
      available: [{ amount: 1250000, currency: 'usd' }],
      pending: [{ amount: 35000, currency: 'usd' }],
    },
  },
  mcp__stripe__list_payments: {
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

export const PR_REVIEW_MOCKS: ToolMockMap = {
  mcp__github__list_issues: {
    type: 'pattern',
    description: 'List issues and pull requests in a GitHub repository. Filter by state, labels, etc. Returns array of issues/PRs with title, user, labels, created_at, and pull_request URL.',
    paramKeys: ['owner', 'repo', 'state', 'labels', 'per_page'],
    patterns: [
      {
        match: { repo: 'frontend' },
        response: [
          { number: 142, title: 'Fix navigation layout on mobile', user: { login: 'alice' }, labels: ['bug'], created_at: '2026-02-19T10:00:00Z', pull_request: { url: 'https://api.github.com/repos/org/frontend/pulls/142' }, draft: false, ci_status: 'success' },
          { number: 139, title: 'Add dark mode toggle', user: { login: 'bob' }, labels: ['enhancement'], created_at: '2026-02-21T05:00:00Z', pull_request: { url: 'https://api.github.com/repos/org/frontend/pulls/139' }, draft: false, ci_status: 'pending' },
          { number: 135, title: 'Refactor auth flow to use new SDK', user: { login: 'carol' }, labels: ['refactor'], created_at: '2026-02-17T08:00:00Z', pull_request: { url: 'https://api.github.com/repos/org/frontend/pulls/135' }, draft: false, ci_status: 'failure' },
        ],
      },
      {
        match: { repo: 'backend' },
        response: [
          { number: 89, title: 'Implement API rate limiting middleware', user: { login: 'dave' }, labels: ['feature'], created_at: '2026-02-20T09:00:00Z', pull_request: { url: 'https://api.github.com/repos/org/backend/pulls/89' }, draft: false, ci_status: 'success' },
          { number: 87, title: 'Database migration v12 — add indexes', user: { login: 'eve' }, labels: ['database'], created_at: '2026-02-21T04:00:00Z', pull_request: { url: 'https://api.github.com/repos/org/backend/pulls/87' }, draft: false, ci_status: 'success' },
        ],
      },
      {
        match: { repo: 'infra' },
        response: [
          { number: 56, title: 'Bump Terraform provider to 5.x', user: { login: 'frank' }, labels: ['infrastructure'], created_at: '2026-02-18T14:00:00Z', pull_request: { url: 'https://api.github.com/repos/org/infra/pulls/56' }, draft: false, ci_status: 'success' },
          { number: 54, title: 'Add Datadog monitoring for new services', user: { login: 'grace' }, labels: ['monitoring'], created_at: '2026-02-20T18:00:00Z', pull_request: { url: 'https://api.github.com/repos/org/infra/pulls/54' }, draft: false, ci_status: 'pending' },
        ],
      },
    ],
    default: [],
  },
  send_message: {
    type: 'static',
    response: { ok: true, delivered: true, channel: 'discord', messageId: 'mock-msg-001' },
  },
}

// ---------------------------------------------------------------------------
// buildMockPayload — merges per-eval mocks with defaults
// ---------------------------------------------------------------------------

/**
 * Default mocks for built-in tools only (no MCP tools).
 * MCP tool mocks come from each eval's `toolMocks` field.
 */
const BUILTIN_MOCKS: ToolMockMap = {
  web_fetch: DEFAULT_WEB_FETCH,
  exec: DEFAULT_EXEC,
  send_message: DEFAULT_SEND_MESSAGE,
  browser: { type: 'static', response: { ok: true, snapshot: '<html>Mock browser snapshot</html>' } },
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
