// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the agent-facing `publish` tool (createPublishTool in
 * gateway-tools.ts). Covers:
 *   - first-publish gating: no subdomain → needs_subdomain (no deploy)
 *   - first publish with a subdomain (normalised) → deploys + verifies
 *   - republish: omit subdomain → reuses the live one (republished: true)
 *   - structured failure mapping (subdomain_taken / invalid_subdomain / generic)
 *   - live-URL verification (2xx → verified, 5xx → verified:false note)
 *
 * The internal-api publish wrappers and global fetch are faked so no network /
 * build pipeline runs.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdirSync, realpathSync, writeFileSync } from 'fs'
import * as realInternalApi from '../internal-api'
import type { ToolContext } from '../gateway-tools'

// Canonical path: the share_file trust check compares real paths, and on
// macOS /tmp is a symlink to /private/tmp.
mkdirSync('/tmp/test-gateway-tools-publish', { recursive: true })
const TEST_DIR = realpathSync('/tmp/test-gateway-tools-publish')

let getPublishStateImpl: (projectId: string) => Promise<any>
let publishProjectImpl: (projectId: string, opts: any) => Promise<any>
let createSharedFileLinkImpl: (projectId: string, opts: any) => Promise<any>
let publishCalls: Array<{ projectId: string; opts: any }> = []
let sharedFileCalls: Array<{ projectId: string; opts: any }> = []
let workspaceSharedFileCalls: Array<{ workspaceId: string; opts: any }> = []

// Custom-domain wrappers (SHO-304) — mocked so no Cloudflare request is made.
let listCustomDomainsImpl: (projectId: string) => Promise<any>
let addCustomDomainImpl: (projectId: string, hostname: string) => Promise<any>
let verifyCustomDomainImpl: (projectId: string, domainId: string) => Promise<any>
let retriggerCustomDomainImpl: (projectId: string, domainId: string) => Promise<any>
let setPrimaryCustomDomainImpl: (projectId: string, domainId: string) => Promise<any>
let removeCustomDomainImpl: (projectId: string, domainId: string) => Promise<any>
let domainCalls: Array<{ fn: string; projectId: string; arg?: string }> = []

mock.module('../internal-api', () => ({
  ...realInternalApi,
  getPublishState: (projectId: string) => getPublishStateImpl(projectId),
  publishProject: (projectId: string, opts: any) => {
    publishCalls.push({ projectId, opts })
    return publishProjectImpl(projectId, opts)
  },
  listProjectCustomDomains: (projectId: string) => {
    domainCalls.push({ fn: 'list', projectId })
    return listCustomDomainsImpl(projectId)
  },
  addProjectCustomDomain: (projectId: string, hostname: string) => {
    domainCalls.push({ fn: 'add', projectId, arg: hostname })
    return addCustomDomainImpl(projectId, hostname)
  },
  verifyProjectCustomDomain: (projectId: string, domainId: string) => {
    domainCalls.push({ fn: 'verify', projectId, arg: domainId })
    return verifyCustomDomainImpl(projectId, domainId)
  },
  retriggerProjectCustomDomain: (projectId: string, domainId: string) => {
    domainCalls.push({ fn: 'retrigger', projectId, arg: domainId })
    return retriggerCustomDomainImpl(projectId, domainId)
  },
  setPrimaryProjectCustomDomain: (projectId: string, domainId: string) => {
    domainCalls.push({ fn: 'make_primary', projectId, arg: domainId })
    return setPrimaryCustomDomainImpl(projectId, domainId)
  },
  removeProjectCustomDomain: (projectId: string, domainId: string) => {
    domainCalls.push({ fn: 'remove', projectId, arg: domainId })
    return removeCustomDomainImpl(projectId, domainId)
  },
  createSharedFileLink: (projectId: string, opts: any) => {
    sharedFileCalls.push({ projectId, opts })
    return createSharedFileLinkImpl(projectId, opts)
  },
  createWorkspaceSharedFileLink: async (workspaceId: string, opts: any) => {
    workspaceSharedFileCalls.push({ workspaceId, opts })
    return {
      ok: true,
      status: 200,
      data: { url: 'https://api.example/api/f/workspace-token', expiresAt: '2026-10-03T00:00:00.000Z', path: opts.path },
    }
  },
}))

const { createTools } = await import('../gateway-tools')

function baseCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'p1',
    ...over,
  } as ToolContext
}

function publishTool(ctx: ToolContext) {
  const t = createTools(ctx).find((x) => x.name === 'publish')
  if (!t) throw new Error('publish tool not found')
  return t
}

function shareFileTool(ctx: ToolContext) {
  const t = createTools(ctx).find((x) => x.name === 'share_file')
  if (!t) throw new Error('share_file tool not found')
  return t
}

async function run(ctx: ToolContext, params: Record<string, any> = {}) {
  const r = await publishTool(ctx).execute('cid', params)
  return r.details as any
}

async function runShareFile(ctx: ToolContext, params: Record<string, any>) {
  const r = await shareFileTool(ctx).execute('cid', params)
  return r.details as any
}

const STATE_UNPUBLISHED = {
  ok: true,
  status: 200,
  data: {
    published: false,
    subdomain: null,
    publishedAt: null,
    accessLevel: null,
    hasPassword: false,
    publishStatus: null,
  },
}

let fetchStatus = 200
let fetchThrows = false
const origFetch = globalThis.fetch

/** A serialized custom-domain row, shaped like the API's response. */
function SAMPLE_DOMAIN(hostname: string, over: Record<string, any> = {}) {
  return {
    id: 'd1',
    hostname,
    status: 'pending',
    stage: 'awaiting_dns',
    message: 'Add the DNS records shown to finish setup.',
    primary: true,
    canonicalHostname: hostname,
    groupId: undefined,
    canRetrigger: false,
    dns: { cname: 'missing', txt: 'missing', ok: false, txtFound: 0, txtExpected: 2 },
    instructions: [
      { type: 'CNAME', name: hostname, value: 'fallback.shogo.one', purpose: 'routing' },
      { type: 'TXT', name: `_acme-challenge.${hostname}`, value: 'dcv-token-1', purpose: 'ssl-validation' },
      { type: 'TXT', name: `_cf-custom-hostname.${hostname}`, value: 'own-token-1', purpose: 'ownership-verification' },
    ],
    ...over,
  }
}

beforeEach(() => {
  // These are unit tests: pin the runtime mode per test instead of inheriting
  // it, because a dev/QA agent checkout is itself a workspace runtime
  // (WORKSPACE_RUNTIME/WORKSPACE_ANCHOR_PROJECT_ID are set in its env).
  // `describe('workspace runtime project id')` sets them back per test.
  delete process.env.WORKSPACE_RUNTIME
  delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
  delete process.env.WORKSPACE_PROJECT_IDS
  delete process.env.WORKSPACE_ID
  publishCalls = []
  sharedFileCalls = []
  workspaceSharedFileCalls = []
  domainCalls = []
  getPublishStateImpl = async () => STATE_UNPUBLISHED
  listCustomDomainsImpl = async () => ({ ok: true, status: 200, data: { enabled: true, fallbackOrigin: 'fallback.shogo.one', domains: [] } })
  addCustomDomainImpl = async (_p, hostname) => ({
    ok: true,
    status: 201,
    data: { domains: [SAMPLE_DOMAIN(hostname)] },
  })
  verifyCustomDomainImpl = async () => ({
    ok: true,
    status: 200,
    data: { domains: [SAMPLE_DOMAIN('example.com', { status: 'active', stage: 'active' })] },
  })
  retriggerCustomDomainImpl = async () => ({
    ok: true,
    status: 200,
    data: { domains: [SAMPLE_DOMAIN('example.com')] },
  })
  setPrimaryCustomDomainImpl = async () => ({
    ok: true,
    status: 200,
    data: { domains: [SAMPLE_DOMAIN('example.com')] },
  })
  removeCustomDomainImpl = async () => ({ ok: true, status: 200, data: { success: true, removedIds: ['d1'] } })
  createSharedFileLinkImpl = async (_projectId, _opts) => ({
    ok: true,
    status: 200,
    data: {
      url: 'https://api.example/f/signed-token',
      expiresAt: '2026-10-03T00:00:00.000Z',
      path: 'report.pdf',
    },
  })
  publishProjectImpl = async (_p, o) => ({
    ok: true,
    status: 200,
    data: { url: `https://${o.subdomain}.shogo.one`, subdomain: o.subdomain },
  })
  fetchStatus = 200
  fetchThrows = false
  globalThis.fetch = (async () => {
    if (fetchThrows) throw new Error('net')
    return new Response('ok', { status: fetchStatus })
  }) as any
})

test('share_file validates and returns a signed download link', async () => {
  writeFileSync(`${TEST_DIR}/report.pdf`, 'pdf bytes')
  const result = await runShareFile(baseCtx(), { path: 'report.pdf', expires_in_days: 3 })
  expect(result).toMatchObject({
    ok: true,
    url: 'https://api.example/f/signed-token',
    filename: 'report.pdf',
    path: 'report.pdf',
    size: 9,
  })
})

// Production: assistants handed out filebin.net links in sessions that never
// called share_file; those uploads leave the platform and expire unpredictably.
test('share_file description rules out third-party file hosts', () => {
  const description = shareFileTool(baseCtx()).description
  expect(description).toMatch(/filebin/i)
  expect(description).toMatch(/never upload/i)
})

test('share_file rejects paths outside the workspace', async () => {
  const result = await runShareFile(baseCtx(), { path: '../secret.txt' })
  expect(result.error).toContain('relative workspace path')
})

describe('workspace runtime project id', () => {
  const prev = {
    WORKSPACE_RUNTIME: process.env.WORKSPACE_RUNTIME,
    WORKSPACE_ANCHOR_PROJECT_ID: process.env.WORKSPACE_ANCHOR_PROJECT_ID,
    WORKSPACE_PROJECT_IDS: process.env.WORKSPACE_PROJECT_IDS,
    WORKSPACE_ID: process.env.WORKSPACE_ID,
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  function workspaceEnv(over: Record<string, string | undefined>) {
    process.env.WORKSPACE_RUNTIME = 'true'
    delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
    delete process.env.WORKSPACE_PROJECT_IDS
    delete process.env.WORKSPACE_ID
    for (const [key, value] of Object.entries(over)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  test('publish uses the anchor when PROJECT_ID is the workspace runtime key', async () => {
    workspaceEnv({ WORKSPACE_ANCHOR_PROJECT_ID: 'anchor-1' })
    const details = await run(baseCtx({ projectId: 'ws:abc' }), { subdomain: 'site' })
    expect(details.ok).toBe(true)
    expect(publishCalls[0].projectId).toBe('anchor-1')
  })

  test('publish uses the only attached project when there is no anchor', async () => {
    workspaceEnv({ WORKSPACE_PROJECT_IDS: 'only-1' })
    const details = await run(baseCtx({ projectId: 'ws:abc' }), { subdomain: 'site' })
    expect(details.ok).toBe(true)
    expect(publishCalls[0].projectId).toBe('only-1')
  })

  test('publish asks for project_id instead of calling the API with a workspace key', async () => {
    workspaceEnv({ WORKSPACE_PROJECT_IDS: 'p1,p2' })
    const details = await run(baseCtx({ projectId: 'ws:abc' }), { subdomain: 'site' })
    expect(details.error).toMatch(/pass project_id/i)
    expect(publishCalls).toHaveLength(0)
  })

  test('an explicit project_id wins over the workspace key', async () => {
    workspaceEnv({ WORKSPACE_ANCHOR_PROJECT_ID: 'anchor-1', WORKSPACE_PROJECT_IDS: 'only-1' })
    await run(baseCtx({ projectId: 'ws:abc' }), { subdomain: 'site', project_id: 'chosen-1' })
    expect(publishCalls[0].projectId).toBe('chosen-1')
  })

  test('share_file uses the anchor and never sends the workspace key', async () => {
    workspaceEnv({ WORKSPACE_ANCHOR_PROJECT_ID: 'anchor-1', WORKSPACE_PROJECT_IDS: 'anchor-1' })
    mkdirSync(`${TEST_DIR}/anchor-1`, { recursive: true })
    writeFileSync(`${TEST_DIR}/anchor-1/report.pdf`, 'pdf bytes')
    const result = await runShareFile(baseCtx({ projectId: 'ws:abc' }), { path: 'anchor-1/report.pdf' })
    expect(result.ok).toBe(true)
    expect(sharedFileCalls[0].projectId).toBe('anchor-1')
    // Signed relative to the project root: a project-scoped download reads
    // from there, not from the merged workspace root (SHO-67).
    expect(sharedFileCalls[0].opts.path).toBe('report.pdf')
    expect(workspaceSharedFileCalls).toHaveLength(0)
  })

  // Production: 86 share_file calls in a week failed with "No project
  // selected" in workspace-agent chats whose runtime had no single project.
  // The file was on disk in this runtime, so a workspace-scoped link serves it.
  test('share_file links a workspace file when the runtime has no project', async () => {
    workspaceEnv({ WORKSPACE_ID: 'ws-1' })
    writeFileSync(`${TEST_DIR}/report.pdf`, 'pdf bytes')
    const result = await runShareFile(baseCtx({ projectId: 'ws:ws-1' }), { path: 'report.pdf', expires_in_days: 2 })
    expect(result).toMatchObject({ ok: true, url: 'https://api.example/api/f/workspace-token', filename: 'report.pdf' })
    expect(sharedFileCalls).toHaveLength(0)
    expect(workspaceSharedFileCalls).toEqual([{ workspaceId: 'ws-1', opts: { path: 'report.pdf', expiresInDays: 2 } }])
  })

  test('share_file links a workspace file when several projects are attached', async () => {
    workspaceEnv({ WORKSPACE_PROJECT_IDS: 'p1,p2', WORKSPACE_ID: 'ws-1' })
    writeFileSync(`${TEST_DIR}/report.pdf`, 'pdf bytes')
    const result = await runShareFile(baseCtx({ projectId: 'ws:ws-1' }), { path: 'report.pdf' })
    expect(result.ok).toBe(true)
    expect(sharedFileCalls).toHaveLength(0)
    expect(workspaceSharedFileCalls[0].workspaceId).toBe('ws-1')
  })

  test('share_file still reports a missing project when there is no workspace either', async () => {
    workspaceEnv({ WORKSPACE_RUNTIME: undefined })
    writeFileSync(`${TEST_DIR}/report.pdf`, 'pdf bytes')
    const result = await runShareFile(baseCtx({ projectId: undefined }), { path: 'report.pdf' })
    expect(result.error).toMatch(/pass project_id/i)
    expect(sharedFileCalls).toHaveLength(0)
    expect(workspaceSharedFileCalls).toHaveLength(0)
  })
})

afterEach(() => {
  globalThis.fetch = origFetch
})

describe('publish tool', () => {
  test('returns an error when there is no project context', async () => {
    const details = await run(baseCtx({ projectId: undefined as any }))
    expect(details.error).toMatch(/no project context/i)
    expect(publishCalls).toHaveLength(0)
  })

  test('first publish without a subdomain asks for confirmation (no deploy)', async () => {
    const details = await run(baseCtx(), {})
    expect(details.needs_subdomain).toBe(true)
    expect(details.hint).toMatch(/confirm the subdomain/i)
    expect(publishCalls).toHaveLength(0)
  })

  test('first publish normalises the subdomain, deploys, verifies, and returns the live URL', async () => {
    const details = await run(baseCtx(), {
      subdomain: '  My-Site  ',
      access_level: 'password',
      password: 'hunter2',
      site_title: 'My Site',
      site_description: 'desc',
    })
    expect(publishCalls).toHaveLength(1)
    expect(publishCalls[0]).toEqual({
      projectId: 'p1',
      opts: {
        subdomain: 'my-site',
        accessLevel: 'password',
        password: 'hunter2',
        siteTitle: 'My Site',
        siteDescription: 'desc',
      },
    })
    expect(details).toMatchObject({
      ok: true,
      published: true,
      url: 'https://my-site.shogo.one',
      subdomain: 'my-site',
      republished: false,
      verified: true,
    })
    expect(details.note).toMatch(/live at https:\/\/my-site\.shogo\.one/i)
  })

  test('republish reuses the existing subdomain when none is supplied', async () => {
    getPublishStateImpl = async () => ({
      ...STATE_UNPUBLISHED,
      data: { ...STATE_UNPUBLISHED.data, published: true, subdomain: 'existing-site' },
    })
    const details = await run(baseCtx(), {})
    expect(publishCalls).toHaveLength(1)
    expect(publishCalls[0].opts.subdomain).toBe('existing-site')
    expect(details.republished).toBe(true)
    expect(details.url).toBe('https://existing-site.shogo.one')
  })

  test('maps subdomain_taken to an actionable error and does not claim success', async () => {
    publishProjectImpl = async () => ({ ok: false, status: 409, code: 'subdomain_taken' })
    const details = await run(baseCtx(), { subdomain: 'taken' })
    expect(details.ok).toBeUndefined()
    expect(details.code).toBe('subdomain_taken')
    expect(details.error).toMatch(/already in use/i)
  })

  test('maps invalid_subdomain to an actionable error', async () => {
    publishProjectImpl = async () => ({
      ok: false,
      status: 400,
      code: 'invalid_subdomain',
      error: 'too short',
    })
    const details = await run(baseCtx(), { subdomain: 'x' })
    expect(details.code).toBe('invalid_subdomain')
    expect(details.error).toMatch(/not a valid subdomain/i)
  })

  test('passes through a generic failure (code + status)', async () => {
    publishProjectImpl = async () => ({
      ok: false,
      status: 402,
      code: 'plan_required',
      error: 'Upgrade required',
    })
    const details = await run(baseCtx(), { subdomain: 'foo' })
    expect(details).toMatchObject({ error: 'Upgrade required', code: 'plan_required', status: 402 })
  })

  test('maps cloud_signin_required to a sign-in instruction, not a failure', async () => {
    publishProjectImpl = async () => ({
      ok: false,
      status: 503,
      code: 'cloud_signin_required',
      error: 'Sign in to Shogo Cloud to publish.',
    })
    const details = await run(baseCtx(), { subdomain: 'my-site' })
    expect(details.code).toBe('cloud_signin_required')
    expect(details.error).toMatch(/settings/i)
    expect(details.error).toMatch(/nothing was deployed/i)
  })

  test('maps server_backed_requires_cloud_project to "sync then publish in the cloud"', async () => {
    publishProjectImpl = async () => ({
      ok: false,
      status: 400,
      code: 'server_backed_requires_cloud_project',
      error: 'This app has a server.',
    })
    const details = await run(baseCtx(), { subdomain: 'my-site' })
    expect(details.code).toBe('server_backed_requires_cloud_project')
    expect(details.error).toMatch(/sync the project to shogo cloud/i)
    expect(details.error).toMatch(/do not retry/i)
  })

  test('maps publish_route_missing to "update Shogo", not another subdomain attempt', async () => {
    publishProjectImpl = async () => ({
      ok: false,
      status: 404,
      code: 'publish_route_missing',
      error: 'This API has no publish route (version mismatch).',
    })
    const details = await run(baseCtx(), { subdomain: 'my-site' })
    expect(details.code).toBe('publish_route_missing')
    expect(details.error).toMatch(/version mismatch/i)
    expect(details.error).toMatch(/do not retry with a different subdomain/i)
  })

  test('reports verified:false (with a propagation note) when the live URL is not yet serving', async () => {
    fetchStatus = 503
    const details = await run(baseCtx(), { subdomain: 'cold' })
    expect(details.ok).toBe(true)
    expect(details.verified).toBe(false)
    expect(details.note).toMatch(/did not respond to a verification fetch/i)
  }, 15000)

  test('treats a gated (401/403) live site as verified — published but access-controlled', async () => {
    fetchStatus = 401
    const details = await run(baseCtx(), { subdomain: 'private-site' })
    expect(details.verified).toBe(true)
  })
})

describe('publish verification checks the page assets load', () => {
  const PAGE = `<!doctype html><html><head>
    <link rel="stylesheet" href="/assets/index-abc.css">
    <link rel="modulepreload" href="./assets/vendor-1.js">
    <link rel="icon" href="/favicon.ico">
    <script type="module" src="/assets/index-abc.js"></script>
    <script src="https://cdn.example.com/lib.js"></script>
  </head><body><div id="root"></div></body></html>`

  function serveSite(assets: Record<string, { status?: number; type?: string }>) {
    const requested: string[] = []
    globalThis.fetch = (async (input: any) => {
      const url = String(input)
      requested.push(url)
      if (url === 'https://site.shogo.one' || url === 'https://site.shogo.one/') {
        return new Response(PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
      const asset = assets[new URL(url).pathname]
      if (!asset) return new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })
      return new Response('x', { status: asset.status ?? 200, headers: { 'content-type': asset.type ?? 'text/javascript' } })
    }) as any
    return requested
  }

  test('verified when every same-origin script and stylesheet loads; ignores icons and other origins', async () => {
    const requested = serveSite({
      '/assets/index-abc.css': { type: 'text/css' },
      '/assets/vendor-1.js': {},
      '/assets/index-abc.js': {},
    })
    const details = await run(baseCtx(), { subdomain: 'site' })
    expect(details.verified).toBe(true)
    expect(details.brokenAssets).toBeUndefined()
    expect(requested.some((u) => u.includes('cdn.example.com'))).toBe(false)
    expect(requested.some((u) => u.endsWith('/favicon.ico'))).toBe(false)
  })

  test('reports a blank-page publish when the bundle 404s or falls back to index.html', async () => {
    serveSite({
      '/assets/index-abc.css': { type: 'text/css' },
      '/assets/vendor-1.js': { status: 404 },
      // index-abc.js is missing, so the SPA fallback serves HTML for it
    })
    const details = await run(baseCtx(), { subdomain: 'site' })
    expect(details.ok).toBe(true)
    expect(details.verified).toBe(false)
    expect(details.brokenAssets).toHaveLength(2)
    expect(details.brokenAssets).toEqual(expect.arrayContaining([
      { url: 'https://site.shogo.one/assets/vendor-1.js', problem: 'HTTP 404' },
      { url: 'https://site.shogo.one/assets/index-abc.js', problem: 'served HTML instead of the asset' },
    ]))
    expect(details.note).toMatch(/render BLANK/)
    expect(details.note).toMatch(/Do NOT tell the user the site is working/)
    expect(details.note).not.toMatch(/hard refresh|clear (your )?cache/i)
  }, 15000)
})

// ---------------------------------------------------------------------------
// Repro for two of the "latest issues" production pain points (AI Insights
// digest, 2026-09-15..21): "hard refresh" advice appearing daily (148
// assistant messages in the last 7 days on prod, per a read-only
// `chat_messages` count) and a Pro-plan paywall surprise AFTER the agent
// has already attempted to deploy (40 sessions/7d on prod where a Pro-plan
// mention lands in the same assistant message as "publish" — i.e.
// reactively, post-attempt, not disclosed upfront).
//
// The tool's own copy is the root cause for both: the description never
// tells the agent about the Pro-plan gate before it tries to deploy, and
// the success `note` explicitly tells the user to "refresh once" — advice
// that stopped being necessary once `serveDistResponse`/canvas-bridge.js
// self-heal stale bundles (see static-asset-cache.test.ts /
// canvas-bridge-stale-asset-recovery.test.ts) and that actively
// contradicts the self-healing behavior.
// ---------------------------------------------------------------------------
describe('publish tool copy (Pro-plan disclosure + no hard-refresh advice)', () => {
  test('the tool description discloses the Pro-plan requirement upfront, before any deploy attempt', () => {
    const description = publishTool(baseCtx()).description
    expect(description).toMatch(/\bpro\b.*\bplan\b/i)
    // Must be actionable pre-attempt guidance, not just present anywhere —
    // tie it to telling the user before/first, not merely mentioning "Pro".
    expect(description).toMatch(/before|first publish|upfront|may (be on|need)/i)
  })

  test('a successful publish response never tells the user to (hard) refresh or clear their cache', async () => {
    const details = await run(baseCtx(), { subdomain: 'foo' })
    const note = String(details.note ?? '')
    expect(note).not.toMatch(/hard refresh|ctrl\+shift\+r|cmd\+shift\+r|clear (your )?cache|refresh once|refresh after/i)
  })

  test('a "did not respond to verification fetch" response never tells the user to (hard) refresh or clear their cache', async () => {
    fetchStatus = 503
    const details = await run(baseCtx(), { subdomain: 'cold' })
    const note = String(details.note ?? '')
    expect(note).not.toMatch(/hard refresh|ctrl\+shift\+r|cmd\+shift\+r|clear (your )?cache|refresh once|refresh after/i)
  }, 15000)
})

// ---------------------------------------------------------------------------
// Custom domains (SHO-304): the `publish` tool's `domain_action`.
//
// Production: an agent asked to point playsamsara.com at a Shogo app stood up a
// Cloudflare Pages project, because nothing told it Shogo serves custom domains
// and it had no way to read the DNS records. These cover every action, that a
// domain action NEVER publishes, and the error mapping the agent acts on.
// ---------------------------------------------------------------------------
describe('publish domain_action — custom domains', () => {
  test('list returns every record with a found flag and does NOT publish', async () => {
    listCustomDomainsImpl = async () => ({
      ok: true,
      status: 200,
      data: { enabled: true, fallbackOrigin: 'fallback.shogo.one', domains: [SAMPLE_DOMAIN('example.com')] },
    })
    const details = await run(baseCtx(), { domain_action: 'list' })

    expect(details.ok).toBe(true)
    expect(details.action).toBe('list')
    expect(details.fallbackOrigin).toBe('fallback.shogo.one')
    const domain = details.domains[0]
    expect(domain.hostname).toBe('example.com')
    expect(domain.status).toBe('pending')
    expect(domain.records).toHaveLength(3)
    expect(domain.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'CNAME', name: 'example.com', value: 'fallback.shogo.one', purpose: 'routing', found: false }),
        expect.objectContaining({ type: 'TXT', name: '_acme-challenge.example.com', value: 'dcv-token-1', purpose: 'ssl-validation' }),
        expect.objectContaining({ type: 'TXT', name: '_cf-custom-hostname.example.com', value: 'own-token-1', purpose: 'ownership-verification' }),
      ]),
    )
    expect(details.settings).toMatch(/Settings/)
    expect(details.docs).toBe('https://docs.shogo.ai/features/custom-domains')
    // The whole point: managing a domain must never trigger a deploy.
    expect(publishCalls).toHaveLength(0)
  })

  test('add registers the apex + www group and returns records verbatim, never publishing', async () => {
    let seenHostname = ''
    addCustomDomainImpl = async (_p, hostname) => {
      seenHostname = hostname
      return {
        ok: true,
        status: 201,
        data: {
          domains: [
            SAMPLE_DOMAIN('example.com', { groupId: 'g1', primary: false, canonicalHostname: 'www.example.com' }),
            SAMPLE_DOMAIN('www.example.com', { id: 'd2', groupId: 'g1', primary: true }),
          ],
        },
      }
    }
    const details = await run(baseCtx(), { domain_action: 'add', domain: 'Example.COM' })

    expect(seenHostname).toBe('example.com')
    expect(details.ok).toBe(true)
    expect(details.domains).toHaveLength(2)
    expect(details.domains[0].records[0]).toMatchObject({ type: 'CNAME', value: 'fallback.shogo.one' })
    expect(details.domains[0].redirectsTo).toBe('www.example.com')
    expect(details.apexNote).toMatch(/CNAME flattening/)
    expect(publishCalls).toHaveLength(0)
  })

  test('add without a domain asks for one and calls nothing', async () => {
    const details = await run(baseCtx(), { domain_action: 'add' })
    expect(details.ok).toBe(false)
    expect(details.error).toMatch(/Pass `domain`/)
    expect(domainCalls).toHaveLength(0)
    expect(publishCalls).toHaveLength(0)
  })

  test('verify returns active and says the domain serves immediately', async () => {
    listCustomDomainsImpl = async () => ({
      ok: true, status: 200,
      data: { enabled: true, domains: [SAMPLE_DOMAIN('example.com')] },
    })
    const details = await run(baseCtx(), { domain_action: 'verify', domain: 'example.com' })
    expect(domainCalls.map((c) => c.fn)).toEqual(['list', 'verify'])
    expect(domainCalls[1].arg).toBe('d1')
    expect(details.verified).toBe(true)
    expect(details.retriggered).toBe(false)
    expect(details.domains[0].status).toBe('active')
    expect(details.note).toMatch(/live and serving/i)
    expect(publishCalls).toHaveLength(0)
  })

  test('verify retriggers a stalled domain the gate allows, and says so', async () => {
    listCustomDomainsImpl = async () => ({
      ok: true, status: 200,
      data: { enabled: true, domains: [SAMPLE_DOMAIN('example.com', { status: 'verifying', stage: 'stalled' })] },
    })
    verifyCustomDomainImpl = async () => ({
      ok: true, status: 200,
      data: { domains: [SAMPLE_DOMAIN('example.com', { status: 'verifying', stage: 'stalled', canRetrigger: true })] },
    })
    const details = await run(baseCtx(), { domain_action: 'verify', domain: 'example.com' })
    expect(domainCalls.map((c) => c.fn)).toEqual(['list', 'verify', 'retrigger'])
    expect(details.retriggered).toBe(true)
    expect(details.note).toMatch(/re-triggered/i)
  })

  test('verify passes the gate message through instead of a generic error', async () => {
    listCustomDomainsImpl = async () => ({
      ok: true, status: 200,
      data: { enabled: true, domains: [SAMPLE_DOMAIN('example.com')] },
    })
    verifyCustomDomainImpl = async () => ({
      ok: false, status: 409, code: 'dns_not_ready',
      error: "Your DNS records aren't all in place yet.",
    })
    const details = await run(baseCtx(), { domain_action: 'verify', domain: 'example.com' })
    expect(details.ok).toBe(false)
    expect(details.code).toBe('dns_not_ready')
    expect(details.error).toMatch(/not all in place/i)
  })

  test('make_primary switches the canonical hostname', async () => {
    listCustomDomainsImpl = async () => ({
      ok: true, status: 200,
      data: { enabled: true, domains: [SAMPLE_DOMAIN('example.com', { groupId: 'g1', primary: false })] },
    })
    const details = await run(baseCtx(), { domain_action: 'make_primary', domain: 'example.com' })
    expect(domainCalls.map((c) => c.fn)).toEqual(['list', 'make_primary'])
    expect(details.ok).toBe(true)
    expect(details.note).toMatch(/canonical address/)
    expect(publishCalls).toHaveLength(0)
  })

  test('remove detaches the domain when it is asked for', async () => {
    listCustomDomainsImpl = async () => ({
      ok: true, status: 200,
      data: { enabled: true, domains: [SAMPLE_DOMAIN('example.com')] },
    })
    const details = await run(baseCtx(), { domain_action: 'remove', domain: 'example.com' })
    expect(domainCalls.map((c) => c.fn)).toEqual(['list', 'remove'])
    expect(details.ok).toBe(true)
    expect(details.removed).toEqual(['d1'])
    expect(publishCalls).toHaveLength(0)
  })

  test('not_published tells the agent to publish first', async () => {
    listCustomDomainsImpl = async () => ({
      ok: false, status: 404, code: 'not_published', error: 'This project has not been published yet.',
    })
    const details = await run(baseCtx(), { domain_action: 'list' })
    expect(details.ok).toBe(false)
    expect(details.code).toBe('not_published')
    expect(details.error).toMatch(/publish it to a subdomain first/i)
    expect(publishCalls).toHaveLength(0)
  })

  test('not_enabled is reported as such', async () => {
    listCustomDomainsImpl = async () => ({ ok: true, status: 200, data: { enabled: false, domains: [] } })
    const details = await run(baseCtx(), { domain_action: 'list' })
    expect(details.ok).toBe(false)
    expect(details.code).toBe('not_enabled')
  })

  test('maps invalid_hostname / hostname_taken / cloud_signin_required', async () => {
    addCustomDomainImpl = async () => ({ ok: false, status: 400, code: 'invalid_hostname', error: 'Enter a valid domain.' })
    let details = await run(baseCtx(), { domain_action: 'add', domain: 'not a domain' })
    expect(details.code).toBe('invalid_hostname')
    expect(details.error).toMatch(/example\.com or app\.example\.com/)

    addCustomDomainImpl = async () => ({ ok: false, status: 409, code: 'hostname_taken', error: 'This domain is already in use' })
    details = await run(baseCtx(), { domain_action: 'add', domain: 'taken.com' })
    expect(details.code).toBe('hostname_taken')
    expect(details.error).toMatch(/do not retry/i)

    addCustomDomainImpl = async () => ({ ok: false, status: 401, code: 'cloud_signin_required', error: 'Sign in to Shogo Cloud.' })
    details = await run(baseCtx(), { domain_action: 'add', domain: 'example.com' })
    expect(details.code).toBe('cloud_signin_required')
    expect(details.error).toMatch(/connect Shogo Cloud/i)
  })

  test('an unknown hostname for verify reports domain_not_found with the current list', async () => {
    listCustomDomainsImpl = async () => ({
      ok: true, status: 200,
      data: { enabled: true, domains: [SAMPLE_DOMAIN('example.com')] },
    })
    const details = await run(baseCtx(), { domain_action: 'verify', domain: 'nope.test' })
    expect(details.code).toBe('domain_not_found')
    expect(details.domains[0].hostname).toBe('example.com')
    expect(domainCalls.map((c) => c.fn)).toEqual(['list'])
  })

  test('a successful publish reports existing custom domains', async () => {
    listCustomDomainsImpl = async () => ({
      ok: true, status: 200,
      data: {
        enabled: true,
        domains: [SAMPLE_DOMAIN('example.com', { status: 'active', stage: 'active' })],
      },
    })
    const details = await run(baseCtx(), { subdomain: 'my-site' })
    expect(details.ok).toBe(true)
    expect(details.customDomains).toEqual([
      { hostname: 'example.com', status: 'active', primary: true, redirectsTo: null },
    ])
    expect(details.customDomainHint).toBeNull()
  })

  test('a publish with no custom domains hints at domain_action: "add"', async () => {
    const details = await run(baseCtx(), { subdomain: 'my-site' })
    expect(details.customDomains).toEqual([])
    expect(details.customDomainHint).toMatch(/domain_action: "add"/)
  })

  test('the description tells the agent never to stand up another host', () => {
    const description = publishTool(baseCtx()).description
    expect(description).toMatch(/Custom domain/i)
    expect(description).toMatch(/NEVER stand up another host/i)
  })
})
