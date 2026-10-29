import { describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join, relative, resolve } from 'path'

const REQUIRED_LOCAL_ROUTES = [
  'GET /api/me',
  'POST /api/me/announcements/seen',
  'PUT /api/me/buddy',
  'GET /api/me/activity',
  'GET /api/me/getting-started',
  'POST /api/onboarding/complete',
  'GET /api/preview/:projectId/wake',
  'GET /api/preview/:projectId/open',
  'ALL /api/projects/:projectId/agent-proxy/*',
  'ALL /api/projects/:projectId/preview',
  'ALL /api/projects/:projectId/preview/*',
  'GET /api/projects/:projectId/preview/metro',
  'GET /api/projects/:projectId/terminal/sessions',
  'POST /api/projects/:projectId/terminal/sessions',
  'DELETE /api/projects/:projectId/terminal/sessions/:id',
  'GET /api/projects/:projectId/terminal/commands',
  'POST /api/projects/:projectId/diagnostics/terminal',
  'GET /api/projects/:projectId/heartbeat',
  'PATCH /api/projects/:projectId/heartbeat',
  'PUT /api/projects/:projectId/heartbeat/sync',
  'GET /api/projects/:projectId/thumbnail',
  'POST /api/projects/:projectId/thumbnail',
  'GET /api/projects/:projectId/thumbnail.png',
  'POST /api/projects/:projectId/thumbnail/capture',
  'POST /api/projects/:projectId/runtime/prewarm',
  // SHO-226: the visible canvas pings this so the preview on screen is never
  // the warm-preview LRU victim. Desktop is the surface that evicts.
  'POST /api/projects/:projectId/preview/active',
  'POST /api/generate-project-name',
  'GET /api/templates',
  'POST /api/workspaces/personal',
  'POST /api/workspaces',
  'PATCH /api/workspaces/:id',
  'DELETE /api/workspaces/:id',
  'GET /api/workspaces/:id/deletion-preview',
  'GET /api/workspaces/activity',
  'POST /api/workspaces/:id/leave',
  'GET /api/workspaces/:id/visible-models',
  'PUT /api/workspaces/:id/visible-models',
  'GET /api/workspaces/:workspaceId/schedules',
  'POST /api/workspaces/:workspaceId/schedules',
  'PATCH /api/workspaces/:workspaceId/schedules/:scheduleId',
  'DELETE /api/workspaces/:workspaceId/schedules/:scheduleId',
  'GET /api/types-proxy',
  // Settings-era Usage and the Analytics screen (Usage | Cost Optimizer) read
  // these on desktop; they 404'd when only server.ts (cloud) mounted them.
  'GET /api/workspaces/:workspaceId/analytics/usage-summary',
  'GET /api/workspaces/:workspaceId/analytics/usage-log',
  'GET /api/workspaces/:workspaceId/analytics/spend-timeseries',
  'GET /api/workspaces/:workspaceId/analytics/engagement',
  'GET /api/workspaces/:workspaceId/analytics/team-work',
  'GET /api/workspaces/:workspaceId/cost-analytics/agent-breakdown',
  'GET /api/workspaces/:workspaceId/cost-analytics/trends',
  'GET /api/me/analytics/usage-summary',
  // Project dropdown > Export / Import; these 404'd on desktop once the
  // route moved into the cloud-only island.
  'POST /api/projects/:projectId/export',
  'POST /api/projects/import',
  // Settings > Integrations is in LOCAL_NAV_ITEMS; these 404'd from 2.0.0.
  'GET /api/integrations/providers',
  'GET /api/integrations/connections',
  'POST /api/integrations/connect',
  'DELETE /api/integrations/connections/:id',
  // Social management (SHO-71): a desktop connects and publishes through the
  // cloud relay, so every user-facing social route must be mounted locally too.
  'GET /api/workspaces/:workspaceId/social/status',
  'GET /api/workspaces/:workspaceId/social/accounts',
  'POST /api/workspaces/:workspaceId/social/accounts/sync',
  'POST /api/workspaces/:workspaceId/social/connect',
  'POST /api/workspaces/:workspaceId/social/connect/complete',
  'DELETE /api/workspaces/:workspaceId/social/accounts/:accountId',
  'GET /api/workspaces/:workspaceId/social/posts',
  'POST /api/workspaces/:workspaceId/social/posts',
  'GET /api/workspaces/:workspaceId/social/posts/:postId',
  'PATCH /api/workspaces/:workspaceId/social/posts/:postId',
  'DELETE /api/workspaces/:workspaceId/social/posts/:postId',
  'GET /api/workspaces/:workspaceId/social/calendar',
  'GET /api/workspaces/:workspaceId/social/analytics',
  'GET /api/workspaces/:workspaceId/social/inbox',
  'GET /api/workspaces/:workspaceId/social/inbox/conversations/:conversationId',
  'POST /api/workspaces/:workspaceId/social/inbox/conversations/:conversationId/messages',
  'POST /api/workspaces/:workspaceId/social/inbox/conversations/:conversationId/read',
  'POST /api/workspaces/:workspaceId/social/inbox/sync',
  'GET /api/workspaces/:workspaceId/social/comments',
  'GET /api/workspaces/:workspaceId/social/comments/:commentId',
  'POST /api/workspaces/:workspaceId/social/comments/:commentId/reply',
  'POST /api/workspaces/:workspaceId/social/comments/:commentId/read',
  'GET /api/workspaces/:workspaceId/social/automations',
  'POST /api/workspaces/:workspaceId/social/automations',
  'GET /api/workspaces/:workspaceId/social/automations/:automationId',
  'PATCH /api/workspaces/:workspaceId/social/automations/:automationId',
  'DELETE /api/workspaces/:workspaceId/social/automations/:automationId',
  // The desktop half of webhook routing: a verified event for one of this
  // machine's local scopes is applied here, in its own DB.
  'POST /api/social/events',
  // Called by the local agent-runtime; "Trust folder" is dead without it.
  'GET /api/internal/projects/:projectId/trust',
  'GET /api/local/machine',
  'GET /api/local/remote-hosts',
  'POST /api/local/remote-hosts',
  'POST /api/local/remote-hosts/:id/connect',
  'GET /api/local/remote-hosts/:id/status',
  'GET /api/local/remote-hosts/:id/askpass',
  'POST /api/local/remote-hosts/:id/askpass',
  'GET /api/local/remote-hosts/:id/browse',
  'POST /api/local/projects/from-remote-folder',
  // Voice TTS: the hosted route lives in `routes/voice-media.ts`, which only
  // `server.ts` (cloud) mounted — desktop 404'd on TTS until it was added to
  // `createLocalApp()`. `music` comes along with it from the same router.
  'POST /api/voice/tts',
  'POST /api/voice/music',
  // SHO-73: the registry-dispatched media family, and the desktop-only voice
  // session routes, are all served locally — `voice-media.ts` owns the media
  // paths and `voice.ts` owns the rest, so neither may be dropped.
  'GET /api/voice/op/:opId',
  'POST /api/voice/op/:opId',
  'GET /api/voice/signed-url',
  'POST /api/voice/transcript/:chatSessionId',
  // The file viewer (SHO-70): a shared file opens in the app, so the metadata
  // and text routes it renders from must answer on desktop too — otherwise the
  // viewer is a blank screen on exactly the surface that has no browser tab.
  'GET /api/conversation-files/:attachmentId/meta',
  'GET /api/conversation-files/:attachmentId/text',
] as const

/** Runtime → API paths that intentionally only exist in the cloud API. */
const CLOUD_ONLY_RUNTIME_PATHS = new Set([
  // Cross-project previews (SHO-125): another project is served by its own pod
  // on metal, and desktop has no metal substrate — `isMetalRuntime()` is false
  // there, so `preview_project` takes the local `/p/<id>/preview/start` path
  // and never builds this URL.
  '/api/internal/workspaces/:param/sessions/:param/projects/:param/preview',
])

const AGENT_RUNTIME_SRC = resolve(import.meta.dir, '../../../../../packages/agent-runtime/src')

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'evals' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(full)
    else if (entry.name.endsWith('.ts')) yield full
  }
}

/**
 * Every `/api/internal/...` path the agent-runtime builds, with template
 * expressions (`${encodeURIComponent(id!)}`) collapsed to `:param` and query
 * strings dropped.
 */
function runtimeInternalPaths(): Map<string, string> {
  const found = new Map<string, string>()
  for (const file of sourceFiles(AGENT_RUNTIME_SRC)) {
    const src = readFileSync(file, 'utf-8')
    let from = 0
    while ((from = src.indexOf('/api/internal/', from)) !== -1) {
      let path = ''
      let i = from
      while (i < src.length) {
        if (src.startsWith('${', i)) {
          let depth = 0
          for (; i < src.length; i++) {
            if (src[i] === '{') depth++
            else if (src[i] === '}' && --depth === 0) break
          }
          i++
          path += ':param'
          continue
        }
        if (/[\s`'"?]/.test(src[i]!)) break
        path += src[i]
        i++
      }
      // The generic workspace passthrough (`…/${id}${path}`) has no static
      // path of its own; the callers are checked by `agentBoardsPaths` below.
      const passthrough = src.slice(from, i).includes('${path}')
      from = i
      if (path.includes('...') || passthrough) continue
      path = path.replace(/:[A-Za-z]+/g, ':param').replace(/(\/[^/:]+):param$/, '$1').replace(/\/$/, '')
      found.set(path, relative(AGENT_RUNTIME_SRC, file))
    }
  }
  return found
}

/**
 * `agentBoardsRequest(ws, METHOD, '/agent-…', …)` builds its URL from the
 * literal path each caller passes, so the scan above can't see those routes.
 * Resolve every call's path under the workspace prefix and require that every
 * call has a literal path, so none can slip past the check.
 */
function agentBoardsPaths(): { found: Map<string, string>; calls: number; unresolved: string[] } {
  const found = new Map<string, string>()
  const unresolved: string[] = []
  let calls = 0
  let literals = 0
  const callRe = /(?<!function )agentBoardsRequest(?:<[^>]*>)?\(/g
  const literalRe = /agentBoardsRequest(?:<[^>]*>)?\(\s*[^,]+,\s*'[A-Z]+',\s*(['`])(\/[^'`]*)\1/g
  for (const file of sourceFiles(AGENT_RUNTIME_SRC)) {
    const src = readFileSync(file, 'utf-8')
    calls += [...src.matchAll(callRe)].length
    for (const m of src.matchAll(literalRe)) {
      literals++
      const path = m[2]!.replace(/\$\{[^}]*\}/g, ':param')
      found.set(`/api/internal/workspaces/:param${path}`, relative(AGENT_RUNTIME_SRC, file))
    }
  }
  if (literals < calls) unresolved.push(`${calls - literals} agentBoardsRequest call(s) without a literal path`)
  return { found, calls, unresolved }
}

function normalizeRoutePath(path: string): string {
  return path.replace(/:[A-Za-z]+/g, ':param')
}

async function composeLocalApp() {
  process.env.SHOGO_LOCAL_MODE = 'true'
  process.env.SHOGO_SKIP_STALE_RUNTIME_CLEANUP = '1'
  mock.module('@shogo-ai/sdk/cli/pkg', () => ({
    pkg: { version: '0.0.0', name: '@shogo-ai/sdk' },
    PlatformPackageManager: class {},
    NodeMissingError: class NodeMissingError extends Error {
      constructor(m: string) {
        super(m)
        this.name = 'NodeMissingError'
      }
    },
    isNodeAvailableOnUnix: () => Promise.resolve(false),
    isNodeAvailableOnWindows: () => Promise.resolve(false),
    _resetUnixNodeCache: () => {},
    resolveBinInvocation: (command: string) => command,
  }))
  const { createLocalApp } = await import('../create-local-app')
  return createLocalApp().app
}

describe('local API route parity', () => {
  test('desktop-required routes are mounted in the local composer', async () => {
    const app = await composeLocalApp()
    const routes = new Set(app.routes.map((route) => `${route.method} ${route.path}`))

    for (const route of REQUIRED_LOCAL_ROUTES) {
      expect(routes.has(route), `missing local route: ${route}`).toBe(true)
    }
  })

  test('no /api/voice path is mounted twice', async () => {
    // SHO-73: desktop mounts `voiceRoutes()` *and* `voiceMediaRoutes()`.
    // `voiceRoutes()` used to register its own `/voice/music`, so that one path
    // was in the table twice (harmlessly, but it hid which module owned it).
    // The wildcard auth middlewares are expected to repeat — one per router.
    const app = await composeLocalApp()
    const seen = new Map<string, number>()
    for (const route of app.routes) {
      if (route.method === 'ALL' || !route.path.startsWith('/api/voice/')) continue
      const key = `${route.method} ${route.path}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    expect(seen.size).toBeGreaterThan(5)
    expect([...seen].filter(([, count]) => count > 1)).toEqual([])
  })

  test('every internal path the agent-runtime calls is served by the local composer', async () => {
    const app = await composeLocalApp()
    const served = new Set(app.routes.map((route) => normalizeRoutePath(route.path)))
    const boards = agentBoardsPaths()
    expect(boards.unresolved, 'agentBoardsRequest calls must use literal paths').toEqual([])
    const called = new Map([...runtimeInternalPaths(), ...boards.found])
    expect(called.size).toBeGreaterThan(10)

    const missing = [...called]
      .filter(([path]) => !CLOUD_ONLY_RUNTIME_PATHS.has(path) && !served.has(path))
      .map(([path, file]) => `${path} (called from ${file})`)
    expect(missing, 'agent-runtime calls these /api/internal paths but desktop 404s them').toEqual([])
  })
})
