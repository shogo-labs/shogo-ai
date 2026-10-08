// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Sweep: every code path that resolves (and so may BOOT) a project runtime in
 * `server.ts` must be pinned to the workspace's home region, and no new path
 * can be added without being classified.
 *
 * Why a sweep: `runtime-route-region-pin-wiring.test.ts` checks eight handlers
 * that someone remembered. #1232 and #1233 were each "a route nobody
 * remembered" — sandbox/url, preview wake/render, files/terminal/database GETs
 * — and booted a second VM in the visitor's region whose starter source then
 * overwrote the project's backup. The next forgotten route would do the same.
 *
 * `server.ts` can't be imported in a unit test (it opens the database, Redis,
 * WebSockets), so this discovers its routes from source instead:
 *
 *   1. SOURCE SWEEP. Every handler/function unit that calls a runtime resolver
 *      is found automatically and must be one of:
 *        - under `/api/projects/:projectId/*` -> covered by the blanket
 *          `pinProjectRoutesToHomeRegion` middleware (asserted registered
 *          before the route, and not skipped);
 *        - under `/api/preview/:projectId/*`  -> calls `pinChatToHomeRegion`
 *          before its first resolver;
 *        - in `EXPLICIT_EXCEPTIONS` below, with the reason it is safe.
 *      An unclassified unit fails the test with instructions.
 *   2. FILE INVENTORY. Every other file under `apps/api/src` that calls a
 *      resolver must be listed in `RESOLVER_FILES` with how it is protected.
 *   3. BEHAVIOR. Every `/api/projects/:projectId/...` pattern discovered in
 *      `server.ts` is exercised against the real middleware on a non-home
 *      region over real HTTP: the edge must never reach a handler.
 *
 *   bun test apps/api/src/__tests__/runtime-route-home-region-sweep.test.ts
 */

import { afterAll, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { Hono } from 'hono'

const SRC = join(import.meta.dir, '..')
const serverSrc = readFileSync(join(SRC, 'server.ts'), 'utf8')

// --- discovery ------------------------------------------------------------------

const RESOLVER =
  /resolveProjectPodUrl\(|getProjectPodUrl\(|resolveWorkspaceRuntimeUrl\(|new MetalSubstrate\(\)|getMetalPublishedUrl\(|getMetalProjectUrl\(/

function stripComments(code: string): string {
  return code
    // Block comments start a line; an inline `/*` is part of a route string like '/files/*'.
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '')
}

interface Unit {
  /** First line of the unit, trimmed. */
  head: string
  body: string
  offset: number
}

/** Split a source file into top-level units (a unit starts at a column-0 statement). */
function units(source: string): Unit[] {
  const code = stripComments(source)
  const starts: number[] = []
  const re = /^(?:app\.|const |let |async function |function |export |class |process\.|if \(|void |await )/gm
  for (let m = re.exec(code); m; m = re.exec(code)) starts.push(m.index)
  return starts.map((offset, i) => {
    const body = code.slice(offset, starts[i + 1] ?? code.length)
    return { head: body.split('\n', 1)[0].trim(), body, offset }
  })
}

interface Route {
  method: string
  path: string
}

const ROUTE_REG = /^app\.(get|post|put|patch|delete|all|options)\(\s*(['"`])([^'"`]+)\2/

function routeOf(u: Unit): Route | null {
  const m = ROUTE_REG.exec(u.body)
  return m ? { method: m[1], path: m[3] } : null
}

/** Routes registered with a named handler: `app.get('/x', fooHandler)`. */
function routesForHandler(name: string): Route[] {
  const out: Route[] = []
  const re = new RegExp(`^app\\.(get|post|put|patch|delete|all|options)\\(\\s*(['"\`])([^'"\`]+)\\2\\s*,\\s*${name}\\s*\\)`, 'gm')
  for (const m of serverSrc.matchAll(re)) out.push({ method: m[1], path: m[3] })
  return out
}

function unitRoutes(u: Unit): Route[] {
  const direct = routeOf(u)
  if (direct) return [direct]
  const named = /^const (\w+) = async/.exec(u.body)
  return named ? routesForHandler(named[1]) : []
}

function unitLabel(u: Unit): string {
  const r = routeOf(u)
  if (r) return `${r.method.toUpperCase()} ${r.path}`
  const fn = /^(?:const|let) (\w+)|^(?:async )?function (\w+)/.exec(u.body)
  if (fn) return fn[1] ?? fn[2]
  return u.head.slice(0, 80)
}

const resolvingUnits = units(serverSrc).filter((u) => RESOLVER.test(u.body))

// --- classification -------------------------------------------------------------

const PROJECT_PREFIX = '/api/projects/:projectId/'
const PREVIEW_PREFIX = '/api/preview/:projectId/'

/**
 * Units that resolve a runtime but are NOT region-pinned by the route layer,
 * with why that is safe. Adding an entry is a deliberate decision: say what
 * stops this path from booting a runtime outside the home region.
 *
 * Keyed by `unitLabel()`.
 */
const EXPLICIT_EXCEPTIONS: Record<string, string> = {
  publishedApiHandler:
    'published:{id} runtime. Since #1241 a published VM boots from the project source and never exports or ' +
    "uploads source, .git or project-data, so a copy in another region cannot overwrite the home runtime's state.",
  resolveRuntimeBaseUrl:
    'Helper for the terminal REST routes (under /api/projects/:projectId/terminal, blanket pin) and the pre-Hono ' +
    'terminal WebSocket bridge, which cannot be proxied and is backstopped by assertRuntimeInHomeRegion in ' +
    'resolveWorkspaceRuntimeUrl.',
  resolveAgentRuntimeUrl:
    'Helper for POST/DELETE /api/projects/:projectId/agent/tool-mocks (blanket pin); demo mode only, which is ' +
    'off whenever isKubernetes() is true.',
  'export default {':
    'Pre-Hono WebSocket bridges (port tunnel, terminal): they cannot be proxied, so they rely on the ' +
    'assertRuntimeInHomeRegion backstop inside resolveProjectPodUrl -> resolveWorkspaceRuntimeUrl.',
  "if (process.env.SHOGO_LOCAL_MODE === 'true' && !isKubernetes()) {":
    'Local/desktop startup prewarm. Local mode has no regions.',
}

const blanketAt = serverSrc.indexOf(
  "app.use('/api/projects/:projectId/*', pinProjectRoutesToHomeRegion(",
)

describe('server.ts runtime-resolving code is pinned to the home region', () => {
  test('the sweep found the resolving units (guards against the parser silently matching nothing)', () => {
    expect(resolvingUnits.length).toBeGreaterThan(25)
    expect(resolvingUnits.some((u) => unitLabel(u) === 'GET /api/projects/:projectId/sandbox/url')).toBe(true)
  })

  test('the blanket project pin is registered, with the reserved-path skip', () => {
    expect(blanketAt).toBeGreaterThan(-1)
    expect(serverSrc.slice(blanketAt, blanketAt + 200)).toContain('skip: isProjectReservedTopLevelPath')
  })

  const unclassified: string[] = []
  for (const u of resolvingUnits) {
    const label = unitLabel(u)
    const routes = unitRoutes(u)
    const projectRoutes = routes.filter((r) => r.path.startsWith(PROJECT_PREFIX))
    const previewRoutes = routes.filter((r) => r.path.startsWith(PREVIEW_PREFIX))
    const otherRoutes = routes.filter((r) => !r.path.startsWith(PROJECT_PREFIX) && !r.path.startsWith(PREVIEW_PREFIX))

    if (EXPLICIT_EXCEPTIONS[label]) continue

    if (routes.length > 0 && otherRoutes.length === 0 && previewRoutes.length === 0) {
      test(`${label}: covered by the blanket /api/projects/:projectId/* pin`, () => {
        expect(blanketAt).toBeGreaterThan(-1)
        // Middleware only wraps routes registered after it.
        expect(blanketAt).toBeLessThan(u.offset)
        for (const r of projectRoutes) {
          expect(r.path).not.toBe('/api/projects/import')
        }
      })
      continue
    }

    if (routes.length > 0 && otherRoutes.length === 0 && projectRoutes.length === 0) {
      test(`${label}: pins to the home region before resolving the runtime`, () => {
        const pinAt = u.body.indexOf('pinChatToHomeRegion(')
        const resolveAt = u.body.search(RESOLVER)
        expect(pinAt).toBeGreaterThan(-1)
        expect(pinAt).toBeLessThan(resolveAt)
      })
      continue
    }

    unclassified.push(label)
  }

  test('no resolving unit is unclassified', () => {
    expect(
      unclassified,
      `These server.ts units resolve a project runtime but are neither under ${PROJECT_PREFIX}* ` +
        `(blanket pin) nor ${PREVIEW_PREFIX}* with a pinChatToHomeRegion() call. A request that lands ` +
        'outside the workspace home region would boot a second VM there (see #1232, #1233). ' +
        'Pin it, or add it to EXPLICIT_EXCEPTIONS with the reason it is safe:\n  ' +
        unclassified.join('\n  '),
    ).toEqual([])
  })

  test('every EXPLICIT_EXCEPTIONS entry still names a resolving unit', () => {
    const labels = new Set(resolvingUnits.map(unitLabel))
    const stale = Object.keys(EXPLICIT_EXCEPTIONS).filter((k) => !labels.has(k))
    expect(stale).toEqual([])
  })
})

// --- file inventory -------------------------------------------------------------

/**
 * Every other file under apps/api/src that calls a runtime resolver, and what
 * keeps it from booting a runtime outside the home region. `server.ts` is
 * handled by the sweep above.
 *
 *   route-pin   mounted under /api/projects/:projectId/*, so the blanket pin
 *               in server.ts applies before the handler runs
 *   guard       resolves through resolveWorkspaceRuntimeUrl, whose cloud branch
 *               calls assertRuntimeInHomeRegion (refuses outside the home region)
 *   resolver    IS the resolver/substrate layer the above sit on top of
 *   local-only  runs only in local/desktop mode (no regions)
 *   cron        background caller, partitioned per region or backstopped by the guard
 */
const RESOLVER_FILES: Record<string, string> = {
  'lib/admin-runtime-recycle.ts': 'guard: admin recycle resolves via the resolver layer',
  'lib/heartbeat-scheduler.ts': 'cron: partitioned by workspace home region (#1233) + guard backstop',
  'lib/knative-project-manager.ts': 'resolver: getProjectPodUrl/resolveProjectPodUrl definitions',
  'lib/metal-rewarm.ts': 'cron: rollout re-warm resolves via resolveWorkspaceRuntimeUrl (guard)',
  'lib/project-port-mutations.ts': 'route-pin: called from /api/projects/:projectId/ports routes',
  'lib/resolve-pod-url.ts': 'resolver: resolveProjectPodUrl definition',
  'lib/resolve-workspace-runtime-url.ts': 'resolver: contains the home-region guard',
  'lib/voice-context.ts': 'guard: resolves via the resolver layer',
  'lib/metal-warm-pool-controller.ts': 'resolver: places runtimes on metal hosts (one host per key, see the placement invariant test)',
  'lib/substrate/metal-substrate.ts': 'resolver: substrate wrapper over the metal controller',
  'lib/substrate/router.ts': 'resolver: picks the substrate',
  'routes/internal-runtime-routes.ts': 'guard: internal runtime routes resolve via resolveWorkspaceRuntimeUrl',
  'routes/local-agent-proxy.ts': 'local-only',
  'routes/local-preview.ts': 'local-only',
  'routes/local-projects.ts': 'local-only',
  'routes/local-terminal.ts': 'local-only',
  'routes/project-chat.ts': 'route-pin: pinChatToHomeRegion at the top of every chat forwarder',
  'routes/project-export-import.ts': 'route-pin: mounted under /api/projects/:projectId/',
  'routes/publish.ts': 'route-pin: publish routes under /api/projects/:projectId/ (#1237 proxies bodies to home)',
  'routes/runtime.ts': 'route-pin: runtime routes under /api/projects/:projectId/runtime',
  'routes/slack-agent.ts': 'guard: background resolve via resolveWorkspaceRuntimeUrl',
  'routes/workspace-chat.ts': 'guard: workspace chat resolves via resolveWorkspaceRuntimeUrl',
  'services/agent-call.service.ts': 'guard: agent-to-agent calls resolve via the resolver layer',
  'services/github-workspace.ts': 'guard: resolves via the resolver layer',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'generated' || name === 'node_modules') continue
      walk(p, out)
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

describe('files that resolve a project runtime are inventoried', () => {
  const callers = walk(SRC)
    .map((p) => relative(SRC, p))
    .filter((rel) => rel !== 'server.ts')
    .filter((rel) => RESOLVER.test(stripComments(readFileSync(join(SRC, rel), 'utf8'))))
    .sort()

  test('no file resolves a runtime without being classified', () => {
    const unknown = callers.filter((f) => !RESOLVER_FILES[f])
    expect(
      unknown,
      'These files call a runtime resolver but are not in RESOLVER_FILES. Decide how each is kept from ' +
        'booting a runtime outside the workspace home region (route pin, resolveWorkspaceRuntimeUrl guard, ' +
        'local-only, ...) and add it with that reason:\n  ' +
        unknown.join('\n  '),
    ).toEqual([])
  })

  test('the inventory has no stale entries', () => {
    const stale = Object.keys(RESOLVER_FILES).filter((f) => !callers.includes(f))
    expect(stale).toEqual([])
  })
})

// --- behavior -------------------------------------------------------------------

const HOME_REGION = 'home-1'
const EDGE_REGION = 'edge-1'

const homeSeen: string[] = []
const homeApp = new Hono()
homeApp.all('/api/projects/:projectId/*', (c) => {
  homeSeen.push(`${c.req.method} ${new URL(c.req.url).pathname}`)
  return c.text('SERVED_BY_HOME')
})
const homeServer = Bun.serve({ port: 0, fetch: homeApp.fetch })

process.env.REGION_ID = EDGE_REGION
process.env.REGION_PEERS = JSON.stringify([
  { id: HOME_REGION, label: 'Home', url: `http://127.0.0.1:${homeServer.port}` },
])
process.env.HOST_HEADER_FOR_PEERS = 'studio.shogo.ai'
delete process.env.CHAT_REGION_PIN

mock.module('../lib/prisma', () => ({
  prisma: {
    project: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) =>
        id === 'p_home' ? { workspaceId: 'ws_home' } : null,
    },
    workspace: {
      findUnique: async () => ({ homeRegion: HOME_REGION }),
    },
  },
}))

const { pinProjectRoutesToHomeRegion } = await import('../lib/chat-region-pin')
const { isProjectReservedTopLevelPath } = await import('../middleware/auth')

/** Every `/api/projects/:projectId/...` registration in server.ts (any handler shape). */
const projectRoutes: Route[] = []
for (const m of serverSrc.matchAll(
  /^app\.(get|post|put|patch|delete|all|options)\(\s*(['"`])(\/api\/projects\/:projectId\/[^'"`]*)\2/gm,
)) {
  projectRoutes.push({ method: m[1], path: m[3] })
}

const edgeReached: string[] = []
const edgeApp = new Hono()
edgeApp.use(
  '/api/projects/:projectId/*',
  pinProjectRoutesToHomeRegion({ skip: isProjectReservedTopLevelPath }),
)
// Stand-in for every real handler: reaching it means a runtime would have been resolved here.
edgeApp.all('/api/projects/:projectId/*', (c) => {
  edgeReached.push(`${c.req.method} ${new URL(c.req.url).pathname}`)
  return c.text('SERVED_BY_EDGE')
})
const edgeServer = Bun.serve({ port: 0, fetch: edgeApp.fetch })

afterAll(() => {
  homeServer.stop(true)
  edgeServer.stop(true)
})

function concretePath(pattern: string): string {
  return pattern
    .replace(':projectId', 'p_home')
    .replace(/:(\w+)/g, 'x1')
    .replace(/\*/g, 'a/b')
}

describe('every /api/projects/:projectId/* route in server.ts is served by the home region', () => {
  test('the sweep discovered the project routes', () => {
    expect(projectRoutes.length).toBeGreaterThan(60)
  })

  const seen = new Set<string>()
  for (const r of projectRoutes) {
    const methods = r.method === 'all' ? ['GET', 'POST'] : [r.method.toUpperCase()]
    for (const method of methods) {
      const path = concretePath(r.path)
      const key = `${method} ${path}`
      if (seen.has(key)) continue
      seen.add(key)
      test(`${method} ${r.path}`, async () => {
        homeSeen.length = 0
        edgeReached.length = 0
        const init: RequestInit = { method }
        if (method !== 'GET' && method !== 'OPTIONS') init.body = '{}'
        const res = await fetch(`http://127.0.0.1:${edgeServer.port}${path}`, init)
        expect(await res.text()).toBe('SERVED_BY_HOME')
        expect(edgeReached).toEqual([])
        expect(homeSeen).toEqual([`${method} ${path}`])
      })
    }
  }
})
