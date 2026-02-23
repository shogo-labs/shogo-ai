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
// Fixture: MCP Discovery — List Installed (MCP Case 1)
// ---------------------------------------------------------------------------

export const MCP_LIST_INSTALLED_MOCKS: ToolMockMap = {
  mcp_list_installed: {
    type: 'static',
    description: 'List all currently installed MCP servers and their available tools.',
    paramKeys: [],
    response: {
      servers: [
        { name: 'playwright', toolCount: 6, tools: ['mcp_playwright_browser_navigate', 'mcp_playwright_browser_snapshot', 'mcp_playwright_browser_click', 'mcp_playwright_browser_type', 'mcp_playwright_browser_take_screenshot', 'mcp_playwright_browser_close'] },
      ],
      totalServers: 1,
      totalTools: 6,
    },
  },
}

// ---------------------------------------------------------------------------
// Fixture: MCP Discovery — Search (MCP Case 2)
// ---------------------------------------------------------------------------

export const MCP_SEARCH_BASIC_MOCKS: ToolMockMap = {
  mcp_search: {
    type: 'pattern',
    description: 'Search for MCP servers by capability or keyword.',
    paramKeys: ['query', 'limit'],
    patterns: [
      {
        match: { query: 'postgres' },
        response: {
          query: 'postgres',
          results: [
            { name: 'Postgres MCP Server', qualifiedName: '@modelcontextprotocol/server-postgres', description: 'Query PostgreSQL databases with read-only access. Supports schema inspection and parameterized queries.', installCommand: 'npx -y @modelcontextprotocol/server-postgres', source: 'smithery' },
            { name: 'Neon Postgres', qualifiedName: '@neondatabase/mcp-server-neon', description: 'Manage Neon serverless Postgres — create databases, run SQL, manage branches.', installCommand: 'npx -y @neondatabase/mcp-server-neon', source: 'smithery' },
          ],
          message: 'Found 2 MCP server(s). Use mcp_install to add one.',
        },
      },
    ],
    default: { query: 'unknown', results: [], message: 'No MCP servers found. Try a different search term.' },
  },
  mcp_list_installed: {
    type: 'static',
    description: 'List all currently installed MCP servers and their available tools.',
    paramKeys: [],
    response: { servers: [], totalServers: 0, totalTools: 0 },
  },
}

// ---------------------------------------------------------------------------
// Fixture: MCP Discovery — Install and Use (MCP Case 3)
// ---------------------------------------------------------------------------

export const MCP_INSTALL_AND_USE_MOCKS: ToolMockMap = {
  mcp_search: {
    type: 'static',
    description: 'Search for MCP servers by capability or keyword.',
    paramKeys: ['query', 'limit'],
    response: {
      query: 'filesystem',
      results: [
        { name: 'Filesystem MCP Server', qualifiedName: '@modelcontextprotocol/server-filesystem', description: 'Secure file operations with configurable access controls.', installCommand: 'npx -y @modelcontextprotocol/server-filesystem /tmp', source: 'smithery' },
      ],
      message: 'Found 1 MCP server(s). Use mcp_install to add one.',
    },
  },
  mcp_install: {
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
  mcp_list_installed: {
    type: 'static',
    description: 'List all currently installed MCP servers and their available tools.',
    paramKeys: [],
    response: { servers: [], totalServers: 0, totalTools: 0 },
  },
}

// ---------------------------------------------------------------------------
// Fixture: MCP Discovery — Uninstall (MCP Case 4)
// ---------------------------------------------------------------------------

export const MCP_UNINSTALL_MOCKS: ToolMockMap = {
  mcp_list_installed: {
    type: 'static',
    description: 'List all currently installed MCP servers and their available tools.',
    paramKeys: [],
    response: {
      servers: [
        { name: 'slack', toolCount: 3, tools: ['mcp_slack_send_message', 'mcp_slack_list_channels', 'mcp_slack_read_channel'] },
        { name: 'postgres', toolCount: 2, tools: ['mcp_postgres_query', 'mcp_postgres_list_tables'] },
      ],
      totalServers: 2,
      totalTools: 5,
    },
  },
  mcp_uninstall: {
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
  mcp_search: {
    type: 'static',
    description: 'Search for MCP servers by capability or keyword.',
    paramKeys: ['query', 'limit'],
    response: {
      query: 'figma design',
      results: [
        { name: 'Figma MCP Server', qualifiedName: '@anthropic/mcp-server-figma', description: 'Access Figma files, components, and design tokens. List files, export assets, inspect design properties.', installCommand: 'npx -y @anthropic/mcp-server-figma', source: 'smithery' },
        { name: 'Figma Dev Mode', qualifiedName: '@figma/mcp-devmode', description: 'Read-only access to Figma dev mode — inspect components, spacing, and CSS.', installCommand: 'npx -y @figma/mcp-devmode', source: 'smithery' },
      ],
      message: 'Found 2 MCP server(s). Use mcp_install to add one.',
    },
  },
  mcp_install: {
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
  mcp_list_installed: {
    type: 'static',
    description: 'List all currently installed MCP servers and their available tools.',
    paramKeys: [],
    response: { servers: [], totalServers: 0, totalTools: 0 },
  },
}

// ---------------------------------------------------------------------------
// Fixture: MCP Discovery — Self-Extend Database (MCP Case 6)
// Discovery-only: no post-install postgres tools mocked. Agent must recognize
// it needs DB access and go through search → install with connection config.
// ---------------------------------------------------------------------------

export const MCP_SELF_EXTEND_DATABASE_MOCKS: ToolMockMap = {
  mcp_search: {
    type: 'static',
    description: 'Search for MCP servers by capability or keyword.',
    paramKeys: ['query', 'limit'],
    response: {
      query: 'postgres database',
      results: [
        { name: 'Postgres MCP Server', qualifiedName: '@modelcontextprotocol/server-postgres', description: 'Query PostgreSQL databases with read-only access. Supports schema inspection and parameterized queries.', installCommand: 'npx -y @modelcontextprotocol/server-postgres', source: 'smithery' },
      ],
      message: 'Found 1 MCP server(s). Use mcp_install to add one.',
    },
  },
  mcp_install: {
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
  mcp_list_installed: {
    type: 'static',
    description: 'List all currently installed MCP servers and their available tools.',
    paramKeys: [],
    response: { servers: [], totalServers: 0, totalTools: 0 },
  },
}

// ---------------------------------------------------------------------------
// Fixture: MCP Discovery — Multi-Server Orchestration (MCP Case 7)
// ---------------------------------------------------------------------------

export const MCP_MULTI_SERVER_MOCKS: ToolMockMap = {
  mcp_search: {
    type: 'pattern',
    description: 'Search for MCP servers by capability or keyword.',
    paramKeys: ['query', 'limit'],
    patterns: [
      {
        match: { query: 'github' },
        response: {
          query: 'github',
          results: [
            { name: 'GitHub MCP Server', qualifiedName: '@modelcontextprotocol/server-github', description: 'Access GitHub repos, issues, PRs, and actions.', installCommand: 'npx -y @modelcontextprotocol/server-github', source: 'smithery' },
          ],
          message: 'Found 1 MCP server(s). Use mcp_install to add one.',
        },
      },
      {
        match: { query: 'slack' },
        response: {
          query: 'slack',
          results: [
            { name: 'Slack MCP Server', qualifiedName: '@anthropic/mcp-server-slack', description: 'Send messages, read channels, manage Slack workspace.', installCommand: 'npx -y @anthropic/mcp-server-slack', source: 'smithery' },
          ],
          message: 'Found 1 MCP server(s). Use mcp_install to add one.',
        },
      },
    ],
    default: { query: 'unknown', results: [], message: 'No MCP servers found.' },
  },
  mcp_install: {
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
  mcp_list_installed: {
    type: 'static',
    description: 'List all currently installed MCP servers and their available tools.',
    paramKeys: [],
    response: { servers: [], totalServers: 0, totalTools: 0 },
  },
}

// ---------------------------------------------------------------------------
// Fixture: MCP Discovery — Discovery to Personality (MCP Case 8)
// ---------------------------------------------------------------------------

export const MCP_DISCOVERY_PERSONALITY_MOCKS: ToolMockMap = {
  mcp_search: {
    type: 'static',
    description: 'Search for MCP servers by capability or keyword.',
    paramKeys: ['query', 'limit'],
    response: {
      query: 'linear project management',
      results: [
        { name: 'Linear MCP Server', qualifiedName: '@linear/mcp-server', description: 'Manage Linear issues, projects, and cycles. Create, update, and search issues.', installCommand: 'npx -y @linear/mcp-server', source: 'smithery' },
      ],
      message: 'Found 1 MCP server(s). Use mcp_install to add one.',
    },
  },
  mcp_install: {
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
  mcp_list_installed: {
    type: 'static',
    description: 'List all currently installed MCP servers and their available tools.',
    paramKeys: [],
    response: { servers: [], totalServers: 0, totalTools: 0 },
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
  mcp_google_calendar_list_events: {
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
  web_fetch: {
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
  mcp_list_installed: {
    type: 'static',
    description: 'List installed MCP servers.',
    paramKeys: [],
    response: {
      servers: [
        { name: 'google-calendar', toolCount: 2, tools: ['mcp_google_calendar_list_events', 'mcp_google_calendar_get_event'] },
        { name: 'postgres', toolCount: 3, tools: ['mcp_postgres_query', 'mcp_postgres_list_tables', 'mcp_postgres_describe_table'] },
      ],
      totalServers: 2, totalTools: 5,
    },
  },
}

// ---------------------------------------------------------------------------
// Orchestration 3: Production Incident Investigation
// Services: Sentry + GitHub (deploys) + Datadog (metrics) + Slack
// ---------------------------------------------------------------------------

export const PRODUCTION_INCIDENT_MOCKS: ToolMockMap = {
  mcp_sentry_list_issues: {
    type: 'static',
    description: 'List error issues from Sentry.',
    paramKeys: ['project', 'query', 'sort'],
    response: [
      { id: 'SENTRY-2001', title: 'TypeError: Cannot read property "session" of null', count: 1843, userCount: 672, level: 'error', firstSeen: '2026-02-22T14:32:00Z', lastSeen: '2026-02-22T15:01:00Z', status: 'unresolved', tags: { url: '/api/v2/auth/verify', handler: 'authMiddleware.ts:42' } },
      { id: 'SENTRY-2002', title: 'HTTP 500: Internal Server Error on /api/v2/users/me', count: 956, userCount: 445, level: 'error', firstSeen: '2026-02-22T14:35:00Z', lastSeen: '2026-02-22T15:00:00Z', status: 'unresolved', tags: { url: '/api/v2/users/me', handler: 'userController.ts:18' } },
      { id: 'SENTRY-2003', title: 'TimeoutError: Redis connection timed out', count: 234, userCount: 98, level: 'warning', firstSeen: '2026-02-22T14:40:00Z', lastSeen: '2026-02-22T14:58:00Z', status: 'unresolved', tags: { service: 'session-store' } },
    ],
  },
  mcp_github_list_recent_deploys: {
    type: 'static',
    description: 'List recent deployments/merged PRs.',
    paramKeys: ['owner', 'repo', 'limit'],
    response: [
      { sha: 'a1b2c3d', message: 'Refactor auth middleware to use new session store', author: 'bob', mergedAt: '2026-02-22T14:15:00Z', pr: '#187', labels: ['refactor', 'auth'] },
      { sha: 'e4f5g6h', message: 'Update Redis client to v5.0', author: 'bob', mergedAt: '2026-02-22T14:10:00Z', pr: '#186', labels: ['dependencies'] },
      { sha: 'i7j8k9l', message: 'Add billing webhook endpoint', author: 'carol', mergedAt: '2026-02-22T11:00:00Z', pr: '#185', labels: ['feature'] },
    ],
  },
  mcp_datadog_query_metrics: {
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
  mcp_slack_send_message: {
    type: 'static',
    description: 'Send a message to a Slack channel.',
    paramKeys: ['channel', 'text'],
    response: { ok: true, channel: '#incidents', ts: '1740237060.000100' },
  },
  mcp_list_installed: {
    type: 'static',
    description: 'List installed MCP servers.',
    paramKeys: [],
    response: {
      servers: [
        { name: 'sentry', toolCount: 2, tools: ['mcp_sentry_list_issues', 'mcp_sentry_get_issue'] },
        { name: 'github', toolCount: 3, tools: ['mcp_github_list_recent_deploys', 'mcp_github_list_pull_requests', 'mcp_github_get_commit'] },
        { name: 'datadog', toolCount: 2, tools: ['mcp_datadog_query_metrics', 'mcp_datadog_list_monitors'] },
        { name: 'slack', toolCount: 2, tools: ['mcp_slack_send_message', 'mcp_slack_list_channels'] },
      ],
      totalServers: 4, totalTools: 9,
    },
  },
}

// ---------------------------------------------------------------------------
// Orchestration 4: Support Ticket Triage → Engineering Tasks
// Services: Zendesk + Linear + Slack
// ---------------------------------------------------------------------------

export const SUPPORT_TICKET_TRIAGE_MOCKS: ToolMockMap = {
  mcp_zendesk_list_tickets: {
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
  mcp_linear_create_issue: {
    type: 'static',
    description: 'Create a new issue in Linear.',
    paramKeys: ['title', 'description', 'priority', 'labels', 'teamId'],
    response: { id: 'ENG-301', url: 'https://linear.app/acme/issue/ENG-301', status: 'Triage', created: true },
  },
  mcp_slack_send_message: {
    type: 'static',
    description: 'Send a message to a Slack channel.',
    paramKeys: ['channel', 'text'],
    response: { ok: true, channel: '#engineering', ts: '1740240000.000200' },
  },
  mcp_list_installed: {
    type: 'static',
    description: 'List installed MCP servers.',
    paramKeys: [],
    response: {
      servers: [
        { name: 'zendesk', toolCount: 2, tools: ['mcp_zendesk_list_tickets', 'mcp_zendesk_get_ticket'] },
        { name: 'linear', toolCount: 3, tools: ['mcp_linear_create_issue', 'mcp_linear_list_issues', 'mcp_linear_update_issue'] },
        { name: 'slack', toolCount: 2, tools: ['mcp_slack_send_message', 'mcp_slack_list_channels'] },
      ],
      totalServers: 3, totalTools: 7,
    },
  },
}

// ---------------------------------------------------------------------------
// Orchestration 5: New Team Member Onboarding
// Services: GitHub + Slack + Linear
// ---------------------------------------------------------------------------

export const TEAM_ONBOARDING_MOCKS: ToolMockMap = {
  mcp_github_add_to_org: {
    type: 'static',
    description: 'Add a user to a GitHub organization and grant repo access.',
    paramKeys: ['org', 'username', 'role', 'repos'],
    response: { ok: true, user: 'sarahchen', org: 'acme-corp', role: 'member', repos_granted: ['acme-corp/backend', 'acme-corp/frontend', 'acme-corp/platform-infra', 'acme-corp/shared-libs'], invitation_sent: true },
  },
  mcp_slack_invite_user: {
    type: 'static',
    description: 'Invite a user to Slack workspace and add to channels.',
    paramKeys: ['email', 'channels'],
    response: { ok: true, user_id: 'U08SARAH', channels_added: ['#platform', '#engineering', '#general', '#new-hires', '#random'], invitation_sent: true },
  },
  mcp_slack_send_message: {
    type: 'static',
    description: 'Send a message to a Slack channel.',
    paramKeys: ['channel', 'text'],
    response: { ok: true, channel: '#platform', ts: '1740300000.000100' },
  },
  mcp_linear_create_issue: {
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
  mcp_list_installed: {
    type: 'static',
    description: 'List installed MCP servers.',
    paramKeys: [],
    response: {
      servers: [
        { name: 'github', toolCount: 3, tools: ['mcp_github_add_to_org', 'mcp_github_list_repos', 'mcp_github_create_issue'] },
        { name: 'slack', toolCount: 3, tools: ['mcp_slack_invite_user', 'mcp_slack_send_message', 'mcp_slack_list_channels'] },
        { name: 'linear', toolCount: 3, tools: ['mcp_linear_create_issue', 'mcp_linear_list_issues', 'mcp_linear_update_issue'] },
      ],
      totalServers: 3, totalTools: 9,
    },
  },
}

// ---------------------------------------------------------------------------
// Orchestration 6: Weekly Business Dashboard
// Services: Stripe + Postgres (usage) + GitHub (velocity)
// ---------------------------------------------------------------------------

export const BUSINESS_DASHBOARD_MOCKS: ToolMockMap = {
  mcp_stripe_get_balance: {
    type: 'static',
    description: 'Get Stripe account balance.',
    paramKeys: [],
    response: { available: [{ amount: 1250000, currency: 'usd' }], pending: [{ amount: 35000, currency: 'usd' }] },
  },
  mcp_stripe_list_payments: {
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
  mcp_github_list_pull_requests: {
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
  mcp_list_installed: {
    type: 'static',
    description: 'List installed MCP servers.',
    paramKeys: [],
    response: {
      servers: [
        { name: 'stripe', toolCount: 2, tools: ['mcp_stripe_get_balance', 'mcp_stripe_list_payments'] },
        { name: 'postgres', toolCount: 3, tools: ['mcp_postgres_query', 'mcp_postgres_list_tables', 'mcp_postgres_describe_table'] },
        { name: 'github', toolCount: 3, tools: ['mcp_github_list_pull_requests', 'mcp_github_list_recent_deploys', 'mcp_github_get_commit'] },
      ],
      totalServers: 3, totalTools: 8,
    },
  },
}

// ---------------------------------------------------------------------------
// Fixture: Airbnb Vacation Planner — MCP Discovery + Canvas Dashboard
// Full flow: search → install → use airbnb tool → build canvas with OPEN links
// ---------------------------------------------------------------------------

export const AIRBNB_VACATION_PLANNER_MOCKS: ToolMockMap = {
  mcp_search: {
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
          message: 'Found 1 MCP server(s). Use mcp_install to add one.',
        },
      },
    ],
    default: {
      query: 'travel',
      results: [
        { name: 'Airbnb MCP Server', qualifiedName: '@openbnb/mcp-server-airbnb', description: 'Search Airbnb listings, get pricing, availability, and property details.', installCommand: 'npx -y @openbnb/mcp-server-airbnb', source: 'catalog', category: 'travel', relevanceScore: 80 },
      ],
      message: 'Found 1 MCP server(s). Use mcp_install to add one.',
    },
  },
  mcp_install: {
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
      message: 'Installed "airbnb" with 2 tool(s). They are now available for use.',
    },
  },
  mcp_airbnb_airbnb_search: {
    type: 'static',
    description: 'Search for Airbnb listings by location, dates, guests, and filters.',
    paramKeys: ['location', 'checkin', 'checkout', 'adults', 'ignoreRobotstxt'],
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
    patterns: [
      {
        match: { listingId: '1001' },
        response: { id: '1001', name: 'Ubud Jungle Retreat — Private Pool Villa', description: 'Nestled in the lush jungles of Ubud, this private villa features an infinity pool, open-air living, and is a 10-minute walk from organic restaurants.', host: 'Made Wijaya', url: 'https://www.airbnb.com/rooms/1001', price: { amount: 85, currency: 'USD', period: 'night', total: 935 } },
      },
    ],
    default: { id: 'unknown', name: 'Listing', description: 'A listing in Ubud.', url: 'https://www.airbnb.com/rooms/unknown' },
  },
  mcp_list_installed: {
    type: 'static',
    description: 'List all currently installed MCP servers and their available tools.',
    paramKeys: [],
    response: { servers: [], totalServers: 0, totalTools: 0 },
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
