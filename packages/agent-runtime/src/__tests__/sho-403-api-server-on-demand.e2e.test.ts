// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-403 — end-to-end acceptance for "the project API server starts when it's
 * needed and reports its real state".
 *
 * Unlike `preview-manager.ensure-api-server.test.ts` (which stubs the sidecar
 * with a hand-written `Bun.serve`), this file runs the **real SDK-generated
 * `server.tsx`** — `generateServer()` output, real Hono app, real custom
 * routes, real `/__shogo/health` + `/__shogo/routes` — behind a real socket,
 * and drives the real `PreviewManager` against it. Only the OS-level process
 * spawn/kill is stubbed (a test cannot own a `bun run server.tsx` child).
 *
 * Acceptance criteria covered:
 *   1. quiesce → on-demand start → `/api/<route>` answers 200
 *   2. cold boot (idle, never started) → first `/api/<route>` answers 200
 *   3. a deliberate stop is respected (503 `phase:'stopped'`), and a real
 *      `start()` clears it
 *   4. a `custom-routes.ts` edit in a MOUNTED project restarts that project,
 *      not the anchor
 *   5. routes come from the running server, custom routes included, and only
 *      the API surface is reported
 *   6. 20 concurrent callers spawn exactly one sidecar
 *   7. a broken server reports `crashed` + a non-empty `buildError`
 *   9. the skill-server shim is gone
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { generateServer } from '@shogo-ai/sdk/generators'
import { PreviewManager } from '../preview-manager'
import { createTools, type ToolContext } from '../gateway-tools'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

/**
 * Temp project dirs live INSIDE the package so `bun` resolves `hono` from the
 * repo's node_modules when the generated `server.tsx` is imported.
 */
const TMP_ROOT = join(import.meta.dir, '..', '..', '.tmp')

let dir: string
let servers: Array<{ stop: (force?: boolean) => void }> = []

beforeEach(() => {
  mkdirSync(TMP_ROOT, { recursive: true })
  dir = mkdtempSync(join(TMP_ROOT, 'sho403-e2e-'))
})

afterEach(() => {
  for (const s of servers) s.stop(true)
  servers = []
  rmSync(dir, { recursive: true, force: true })
})

afterAll(() => clearTrustForTests())

/**
 * Write a real project (generated `server.tsx` + CRUD routes + custom routes)
 * and serve it on a real port. Returns the port.
 */
async function startGeneratedServer(projectDir: string, customRoutes: string): Promise<number> {
  mkdirSync(join(projectDir, 'src', 'generated', 'routes'), { recursive: true })
  writeFileSync(
    join(projectDir, 'src', 'generated', 'routes', 'index.ts'),
    [
      "import { Hono } from 'hono'",
      'export function createAllRoutes(_prisma: unknown) {',
      '  const app = new Hono()',
      "  app.get('/users', (c) => c.json([{ id: 1 }]))",
      "  app.post('/users', (c) => c.json({ id: 2 }, 201))",
      "  app.get('/users/:id', (c) => c.json({ id: c.req.param('id') }))",
      '  return app',
      '}',
      '',
    ].join('\n'),
  )
  writeFileSync(join(projectDir, 'src', 'generated', 'db.ts'), 'export const prisma = {}\n')
  writeFileSync(join(projectDir, 'custom-routes.ts'), customRoutes)

  const source = generateServer({
    skipStatic: true,
    tools: false,
    bunServe: false,
    customRoutesPath: './custom-routes',
    routesPath: './src/generated/routes',
    dbPath: './src/generated/db',
  })
  const serverPath = join(projectDir, 'server.tsx')
  writeFileSync(serverPath, source)

  const mod = (await import(pathToFileURL(serverPath).href)) as {
    default: { fetch: (req: Request) => Response | Promise<Response> }
  }
  const server = Bun.serve({ port: 0, fetch: mod.default.fetch })
  servers.push(server)
  return server.port as number
}

function mk(over: Record<string, any> = {}) {
  return new PreviewManager({
    workspaceDir: dir,
    runtimePort: 38971,
    publicUrl: 'https://preview.example/abc',
    localMode: false,
    ...over,
  }) as any
}

/** Make `apiServerPort` report a bound, listening sidecar. */
function bind(pm: any, port: number) {
  pm.apiServerProcess = { killed: false, kill: () => {} }
  pm.apiListening = true
  pm.apiPort = port
}

/** The OS-level kill steps a test cannot own (they also drop the port). */
function stubProcessKills(pm: any) {
  pm.killApiServer = async () => {
    pm.apiServerProcess = null
    pm.apiListening = false
  }
  pm.forceKillPort = async () => {}
  pm.waitForPortRelease = async () => {}
}

/** Mirror of `server.ts`'s `resolveApiProxyTarget` + `/api/*` handler. */
async function proxyApi(pm: any, path: string, timeoutMs = 5000) {
  const result = await pm.ensureApiServer({ timeoutMs })
  const port = result.port ?? pm.apiServerPort
  if (port == null) {
    return {
      status: result.phase === 'none' ? 404 : 503,
      body: {
        error: result.phase === 'none' ? 'No API server for this project' : 'API server not ready',
        phase: result.phase,
        ...(result.buildError ? { buildError: result.buildError } : {}),
      },
    }
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`)
  return { status: res.status, body: await res.json().catch(() => null) }
}

describe('SHO-403 e2e — the generated server reports its own health and routes', () => {
  it('serves /__shogo/health and lists only the API surface from /__shogo/routes', async () => {
    const port = await startGeneratedServer(
      dir,
      "import { Hono } from 'hono'\nconst app = new Hono()\napp.get('/leads', (c) => c.json([]))\nexport default app\n",
    )

    const health = await fetch(`http://127.0.0.1:${port}/__shogo/health`)
    expect(health.status).toBe(200)
    expect((await health.json()).ok).toBe(true)

    const routesResp = await fetch(`http://127.0.0.1:${port}/__shogo/routes`)
    const { routes } = (await routesResp.json()) as { routes: Array<{ method: string; path: string }> }
    const paths = routes.map((r) => r.path)
    // CRUD + custom routes are listed…
    expect(paths).toContain('/api/users')
    expect(paths).toContain('/api/leads')
    // …and the non-API routes are not (they would be reported as /api/health
    // and /api/* by `server_sync`, which is what agents act on).
    expect(paths).not.toContain('/health')
    expect(paths).not.toContain('/*')
    expect(paths.every((p) => p.startsWith('/api/'))).toBe(true)
  })

  it('fetchActiveRoutes asks the running server and reports routesSource "server"', async () => {
    const port = await startGeneratedServer(
      dir,
      "import { Hono } from 'hono'\nconst app = new Hono()\napp.get('/leads', (c) => c.json([]))\nexport default app\n",
    )
    const pm = mk()
    bind(pm, port)

    const result = await pm.fetchActiveRoutes()
    expect(result.routesSource).toBe('server')
    expect(result.routes).toContain('users')
    expect(result.routes).toContain('leads')
    expect(result.routes).not.toContain('health')
    expect(result.routes).not.toContain('*')
  })
})

describe('SHO-403 e2e — on-demand start', () => {
  it('AC1: a quiesced sidecar is restarted by the next request and answers 200', async () => {
    const port = await startGeneratedServer(
      dir,
      "import { Hono } from 'hono'\nconst app = new Hono()\napp.get('/leads', (c) => c.json([]))\nexport default app\n",
    )
    const pm = mk()
    pm.hasApiServer = true
    pm.apiPhase = 'healthy'
    bind(pm, port)
    stubProcessKills(pm)

    // What a VM memory snapshot does: stop the sidecar, leave `stopped`.
    expect(await pm.quiesceApiServer()).toBe(true)
    expect(pm.apiServerPhase).toBe('stopped')
    expect(pm.apiServerPort).toBeNull()

    // The next request (or the turn-start ensure) brings it back.
    pm.startApiServer = async () => {
      bind(pm, port)
      pm.apiPhase = 'healthy'
    }
    const res = await proxyApi(pm, '/api/users')
    expect(res.status).toBe(200)
    expect(pm.apiServerPhase).toBe('healthy')
  })

  it('AC2: a cold runtime (idle, never started) answers the first /api request with 200', async () => {
    const port = await startGeneratedServer(
      dir,
      "import { Hono } from 'hono'\nconst app = new Hono()\napp.get('/leads', (c) => c.json([]))\nexport default app\n",
    )
    const pm = mk()
    pm.hasApiServer = true
    pm.apiPhase = 'idle'
    pm.started = false
    // The real cold-boot lifecycle needs a package.json + install; the point
    // here is that the proxy WAITS for it instead of 503-ing.
    pm.start = async () => {
      bind(pm, port)
      pm.apiPhase = 'healthy'
      return { mode: 'test', port, timings: {} }
    }

    const res = await proxyApi(pm, '/api/users')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([{ id: 1 }])
  })

  it('AC3: a deliberate stop answers 503 phase "stopped" and is not undone', async () => {
    const pm = mk()
    pm.hasApiServer = true
    pm.apiPhase = 'healthy'
    bind(pm, 1)
    stubProcessKills(pm)
    let restarts = 0
    pm.restartApiServerOnly = async () => { restarts++ }

    pm.markStoppedByUser()
    pm.stop()

    const res = await proxyApi(pm, '/api/users')
    expect(res.status).toBe(503)
    expect(res.body.phase).toBe('stopped')
    expect(restarts).toBe(0)
  })

  it('AC3: a real start() clears the deliberate stop', async () => {
    const pm = mk()
    pm.markStoppedByUser()
    expect(pm.isStoppedByUser).toBe(true)

    // An empty dir has no package.json, so the lifecycle returns early — but
    // only after clearing the flag, which is the contract `/preview/start` needs.
    await pm.start()
    expect(pm.isStoppedByUser).toBe(false)
  })

  it('AC6: 20 concurrent requests spawn exactly one sidecar and all answer 200', async () => {
    const port = await startGeneratedServer(
      dir,
      "import { Hono } from 'hono'\nconst app = new Hono()\napp.get('/leads', (c) => c.json([]))\nexport default app\n",
    )
    const pm = mk()
    pm.hasApiServer = true
    pm.apiPhase = 'idle'
    pm.started = true
    let spawns = 0
    pm.startApiServer = async () => {
      spawns++
      await new Promise((r) => setTimeout(r, 25))
      bind(pm, port)
      pm.apiPhase = 'healthy'
    }

    const results = await Promise.all(Array.from({ length: 20 }, () => proxyApi(pm, '/api/users')))
    expect(spawns).toBe(1)
    expect(results.every((r) => r.status === 200)).toBe(true)
  })

  it('AC7: a broken server reports crashed + a non-empty buildError, without looping', async () => {
    const pm = mk()
    pm.hasApiServer = true
    pm.apiPhase = 'idle'
    pm.started = true
    pm.startApiServer = async () => {
      pm.apiPhase = 'crashed'
      pm.lastApiStderr = "error: Cannot find module './custom-routes'"
    }

    const started = Date.now()
    const res = await proxyApi(pm, '/api/users', 5000)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(res.status).toBe(503)
    expect(res.body.phase).toBe('crashed')
    expect(res.body.buildError).toContain('Cannot find module')
  })
})

describe('SHO-403 e2e — tools act on the edited project', () => {
  function makeCtx(overrides: Partial<ToolContext>): ToolContext {
    return {
      workspaceDir: dir,
      channels: new Map(),
      config: {
        heartbeatInterval: 1800,
        heartbeatEnabled: false,
        quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
        channels: [],
        model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      } as any,
      projectId: 'anchor',
      ...overrides,
    }
  }

  function fakeProject(id: string, projectDir: string) {
    const calls = { restarts: 0, syncs: 0, ensures: 0 }
    const pm: any = {
      projectId: id,
      projectDir,
      apiServerPhase: 'healthy',
      apiServerUrl: `http://localhost:0/${id}`,
      getActiveRoutes: () => ['users'],
      getSchemaModels: () => ['User'],
      fetchActiveRoutes: async () => ({ routes: ['users', 'leads'], routesSource: 'server' }),
      sync: async () => { calls.syncs++; return { ok: true, phase: 'healthy' } },
      restartApiServerOnly: async () => { calls.restarts++ },
      ensureApiServer: async () => {
        calls.ensures++
        return {
          phase: 'healthy',
          port: 1,
          reloadedAt: 1,
          routes: ['users', 'leads'],
          routesSource: 'server',
          buildError: null,
        }
      },
    }
    return { pm, calls }
  }

  it('AC4: a custom-routes.ts edit in a mounted project restarts THAT project, not the anchor', async () => {
    trustWorkspaceForTests(dir)
    const projB = join(dir, 'proj-b')
    mkdirSync(projB, { recursive: true })

    const anchor = fakeProject('anchor', dir)
    const mounted = fakeProject('proj-b', projB)
    const seen: Array<string | undefined> = []
    const ctx = makeCtx({
      resolveApiServer: (ref?: string) => {
        seen.push(ref)
        // The real host resolves from the edited path; the anchor is the
        // fallback only when nothing matches.
        return ref && ref.includes('proj-b') ? mounted.pm : anchor.pm
      },
    })

    const tool = createTools(ctx).find((t) => t.name === 'write_file')!
    const result = await tool.execute('call-1', {
      path: 'proj-b/custom-routes.ts',
      content: "import { Hono } from 'hono'\nconst app = new Hono()\napp.get('/leads', (c) => c.json([]))\nexport default app\n",
    })
    const details = result.details as any

    // The resolver was asked about the EDITED FILE, not the anchor.
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]).toContain('proj-b')
    expect(seen[0]).toContain('custom-routes.ts')

    expect(mounted.calls.restarts).toBe(1)
    expect(mounted.calls.ensures).toBe(1)
    expect(anchor.calls.restarts).toBe(0)
    expect(anchor.calls.ensures).toBe(0)

    // The edit result already reports the restarted project's real routes.
    expect(details.apiServer.project).toBe('proj-b')
    expect(details.apiServer.serverRestarted).toBe(true)
    expect(details.apiServer.routes).toContain('/api/leads')
    expect(details.apiServer.routesSource).toBe('server')
  })

  it('AC4: a prisma/schema.prisma edit in a mounted project syncs THAT project', async () => {
    trustWorkspaceForTests(dir)
    const projB = join(dir, 'proj-b')
    mkdirSync(join(projB, 'prisma'), { recursive: true })

    const anchor = fakeProject('anchor', dir)
    const mounted = fakeProject('proj-b', projB)
    const seen: Array<string | undefined> = []
    const ctx = makeCtx({
      resolveApiServer: (ref?: string) => {
        seen.push(ref)
        return ref && ref.includes('proj-b') ? mounted.pm : anchor.pm
      },
    })

    const tool = createTools(ctx).find((t) => t.name === 'write_file')!
    const result = await tool.execute('call-1', {
      path: 'proj-b/prisma/schema.prisma',
      content: 'model Lead {\n  id String @id\n}\n',
    })
    const details = result.details as any

    expect(seen[0]).toContain('proj-b')
    expect(seen[0]).toContain('schema.prisma')
    expect(mounted.calls.syncs).toBe(1)
    expect(anchor.calls.syncs).toBe(0)
    expect(details.apiServer.project).toBe('proj-b')
  })
})

describe('SHO-403 e2e — the shim is gone', () => {
  it('AC9: skill-server-manager.ts no longer exists', () => {
    expect(existsSync(join(import.meta.dir, '..', 'skill-server-manager.ts'))).toBe(false)
    expect(existsSync(join(import.meta.dir, 'skill-server-manager.test.ts'))).toBe(false)
  })
})
