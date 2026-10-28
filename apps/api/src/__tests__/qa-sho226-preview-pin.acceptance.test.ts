// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The preview on screen is never the one the warm cap takes (SHO-226).
 *
 * Russell's report, desktop: "sometimes the localhost previews don't load" —
 * a preview left open went blank / connection-refused once agents had been
 * busy. Three things had to be true at once for that: agent wakes filled the
 * three warm-preview slots, nothing marked the preview being *viewed* as
 * anything but idle, and the canvas stopped looking the moment it was ready.
 *
 * The developer's suites cover each piece against a stub manager. This one
 * takes the card's criteria through the seams they cannot: the REAL
 * `runtimeRoutes` Hono handlers wired to the REAL `RuntimeManager` (only the
 * substrate choice — `resolve-pod-url` — is adapted onto `startProjectWorkspace`
 * exactly as the host resolver does), so the pin has to survive the HTTP
 * round-trip the canvas actually makes, and the response the client reads is
 * the response the manager produced.
 *
 * Covered here:
 *   1. three open previews + four agent wakes: nothing is evicted, the agents
 *      are in the background pool;
 *   3. an agent wake for an already-foreground preview leaves it foreground;
 *   4. `POST /preview/active` pins the key even at the MRU tail — and the same
 *      key IS the victim once the view TTL lapses (the control that proves the
 *      pin, not MRU order, is what saved it);
 *   5. the ping resets the worker's idle slot and never starts a runtime;
 *   6. server half of the canvas recovery: a runtime force-stopped under the
 *      canvas is reported `running:false` (so the client re-resolves), the next
 *      `/sandbox/url` brings it back, and the port in that response is the port
 *      the following ping reports — the comparison the client makes.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { RuntimeManager, projectWorkspaceRuntimeKey } from '../lib/runtime/manager'

process.env.SHOGO_SKIP_STALE_RUNTIME_CLEANUP = '1'

// ─── prisma mock (validateProject) ────────────────────────────────────────

const projectFindUnique = mock(async (_: any): Promise<any> => null)
mock.module('../lib/prisma', () => ({
  prisma: { project: { findUnique: projectFindUnique } },
  SubscriptionStatus: {
    active: 'active',
    past_due: 'past_due',
    canceled: 'canceled',
    incomplete: 'incomplete',
    incomplete_expired: 'incomplete_expired',
    trialing: 'trialing',
    unpaid: 'unpaid',
    paused: 'paused',
  },
  BillingInterval: { monthly: 'monthly', annual: 'annual' },
}))

// ─── substrate adapter: host mode, onto the manager under test ────────────
//
// The real resolver picks k8s / metal / host and then hands a host resolve to
// `startProjectWorkspace`. Desktop is always host, so stubbing only that choice
// keeps every line the card touches real — including the `background` flag the
// agent call sites now pass.

let manager: PrivateRM | null = null
const resolveProjectPodUrlMock = mock(async (projectId: string, opts: any = {}) => {
  const rm = manager
  if (!rm) throw new Error('no manager under test')
  const runtime = await rm.startProjectWorkspace(projectId, {
    workspaceId: 'w1',
    ...(opts.background ? { background: true } : {}),
  })
  return { mode: 'host' as const, url: runtime.url, runtime }
})
const actualPodUrl = await import('../lib/resolve-pod-url')
mock.module('../lib/resolve-pod-url', () => ({
  ...actualPodUrl,
  resolveProjectPodUrl: resolveProjectPodUrlMock,
}))

// ─── route under test (loaded AFTER the mocks) ────────────────────────────

const { runtimeRoutes } = await import('../routes/runtime')

// ─── manager harness ──────────────────────────────────────────────────────

function fakeProcess() {
  return {
    killed: false,
    exitCode: null as number | null,
    kill: mock(() => true),
    on: mock(() => undefined),
  }
}

type PrivateRM = RuntimeManager & {
  runtimes: Map<string, any>
  usedPorts: Set<number>
  agentManager: any
  agentManagedProjects: Set<string>
  workspacePreviewMru: string[]
  workspaceBackgroundMru: string[]
  previewViewedAt: Map<string, number>
  doStartMergedRuntime: any
  enforceWorkspacePreviewCap: () => Promise<void>
}

const IDLE = { turns: 0, tasks: 0, streams: 0, children: 0 }

/**
 * A manager whose embedded worker is stubbed only at the seams the LRU reads
 * (liveness, activity, touch) and whose spawn is replaced by a published
 * running record — the same shape the real start produces. Everything under
 * test (MRU bookkeeping, background tagging, the cap, the pin, the ping) is the
 * production code.
 */
function newManager(): PrivateRM {
  const rm = new RuntimeManager({ healthCheckInterval: 50 }) as PrivateRM
  const startedAt = Date.now() - 10 * 60_000
  rm.agentManager = {
    touch: mock(() => {}),
    stop: mock(async () => {}),
    refreshActivity: mock(async () => {}),
    status: (key: string) => {
      const rt = rm.runtimes.get(key)
      if (!rt) return undefined
      return {
        projectId: key,
        status: rt.status,
        agentPort: rt.agentPort,
        startedAt: rt.startedAt,
        lastUsedAt: rt.startedAt,
        restarts: 0,
      }
    },
    activityDecision: () => ({
      busy: false,
      dead: false,
      reason: 'idle',
      counts: IDLE,
    }),
  }
  let nextPort = 38000
  ;(rm as any).getProjectInfo = mock(async () => ({}))
  rm.doStartMergedRuntime = mock(async (spec: any) => {
    const port = nextPort++
    const runtime = {
      id: spec.key,
      port,
      agentPort: port + 1000,
      status: 'running',
      url: `http://localhost:${port}`,
      // Settled, not freshly spawned: a runtime inside its startup grace is
      // never an eviction victim (SHO-143).
      startedAt,
      process: null,
      agentProcess: fakeProcess(),
    }
    rm.runtimes.set(spec.key, runtime)
    rm.agentManagedProjects.add(spec.key)
    rm.usedPorts.add(port)
    return runtime
  })
  return rm
}

/** What the real manager does when it stops a runtime, minus the process work. */
function stubStop(rm: PrivateRM): string[] {
  const stopped: string[] = []
  ;(rm as any).stop = mock(async (key: string) => {
    stopped.push(key)
    const rt = rm.runtimes.get(key)
    if (rt) rt.status = 'stopped'
  })
  return stopped
}

function makeApp(rm: PrivateRM) {
  const app = new Hono()
  app.route('/api', runtimeRoutes({ runtimeManager: rm as any }))
  return app
}

const key = (projectId: string) => projectWorkspaceRuntimeKey(projectId)

/** The UI open: `/sandbox/url`, which is also what marks the preview active. */
async function openPreview(app: Hono, projectId: string) {
  const res = await app.request(`/api/projects/${projectId}/sandbox/url`)
  expect(res.status).toBe(200)
  return (await res.json()) as {
    canvasBaseUrl: string
    agentUrl: string
    status: string
    ready: boolean
  }
}

/** The visible canvas's ping. */
async function ping(app: Hono, projectId: string) {
  const res = await app.request(`/api/projects/${projectId}/preview/active`, { method: 'POST' })
  expect(res.status).toBe(200)
  return (await res.json()) as {
    ok: boolean
    running: boolean
    agentPort: number | null
    status: string | null
  }
}

const SAVED_ENV = {
  KUBERNETES_SERVICE_HOST: process.env.KUBERNETES_SERVICE_HOST,
  SHOGO_LOCAL_MODE: process.env.SHOGO_LOCAL_MODE,
}

beforeEach(() => {
  projectFindUnique.mockReset()
  projectFindUnique.mockImplementation(async (args: any) => ({
    id: args?.where?.id ?? 'p1',
    name: 'Hello',
    workspaceId: 'ws-1',
  }))
  resolveProjectPodUrlMock.mockClear()
  // Desktop / local is the surface that evicts, and local mode outranks a k8s
  // service host (the desktop-in-k8s-dev case).
  delete process.env.KUBERNETES_SERVICE_HOST
  process.env.SHOGO_LOCAL_MODE = 'true'
})

afterEach(() => {
  if (SAVED_ENV.KUBERNETES_SERVICE_HOST === undefined) delete process.env.KUBERNETES_SERVICE_HOST
  else process.env.KUBERNETES_SERVICE_HOST = SAVED_ENV.KUBERNETES_SERVICE_HOST
  if (SAVED_ENV.SHOGO_LOCAL_MODE === undefined) delete process.env.SHOGO_LOCAL_MODE
  else process.env.SHOGO_LOCAL_MODE = SAVED_ENV.SHOGO_LOCAL_MODE
})

// ─── AC1 / AC3: agent work never takes a warm-preview slot ────────────────

describe('SHO-226 AC1 — agent wakes leave the open previews alone', () => {
  test('three previews opened through /sandbox/url survive four agent wakes', async () => {
    const rm = newManager()
    manager = rm
    const stopped = stubStop(rm)
    const app = makeApp(rm)

    for (const id of ['p1', 'p2', 'p3']) await openPreview(app, id)
    const previews = ['p1', 'p2', 'p3'].map(key)
    expect(rm.workspacePreviewMru).toEqual([key('p3'), key('p2'), key('p1')])

    // A team-chat / board / `project_call` wake: `agent-call.service` resolves
    // the callee with `background: true`.
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      await resolveProjectPodUrlMock(id, { logTag: 'AgentCall', background: true })
    }

    expect(stopped).toEqual([])
    expect(rm.workspacePreviewMru).toEqual([key('p3'), key('p2'), key('p1')])
    for (const id of ['p1', 'p2', 'p3']) {
      expect(rm.runtimes.get(key(id))?.status).toBe('running')
      expect(rm.runtimes.get(key(id))?.background).toBeFalsy()
    }
    for (const id of ['a1', 'a2', 'a3', 'a4']) {
      expect(rm.runtimes.get(key(id))?.background).toBe(true)
      expect(rm.workspaceBackgroundMru).toContain(key(id))
      expect(rm.workspacePreviewMru).not.toContain(key(id))
      // Never counted against the warm-preview cap either.
      expect(previews).not.toContain(key(id))
    }
  })

  test('AC3 — waking a project that is already on screen leaves it foreground', async () => {
    const rm = newManager()
    manager = rm
    const stopped = stubStop(rm)
    const app = makeApp(rm)

    await openPreview(app, 'p1')
    expect(rm.workspacePreviewMru).toEqual([key('p1')])

    await resolveProjectPodUrlMock('p1', { logTag: 'AgentCall', background: true })

    expect(rm.runtimes.get(key('p1'))?.background).toBeFalsy()
    expect(rm.workspacePreviewMru).toEqual([key('p1')])
    expect(rm.workspaceBackgroundMru).not.toContain(key('p1'))
    expect(stopped).toEqual([])
  })
})

// ─── AC4 / AC5: the ping pins what is on screen ───────────────────────────

describe('SHO-226 AC4 — the pinged preview is never the LRU victim', () => {
  test('pinned at the MRU tail, it survives the open that would have evicted it', async () => {
    const rm = newManager()
    manager = rm
    const stopped = stubStop(rm)
    const app = makeApp(rm)

    for (const id of ['p1', 'p2', 'p3']) await openPreview(app, id)
    // Make p1 the oldest open — the position the cap takes. MRU is
    // most-recent-first, so this is exactly "the preview the user came back to
    // after three others".
    rm.workspacePreviewMru = [key('p3'), key('p2'), key('p1')]

    const pinged = await ping(app, 'p1')
    expect(pinged).toEqual({
      ok: true,
      running: true,
      agentPort: rm.runtimes.get(key('p1'))!.agentPort,
      // Round 2: the lifecycle state rides along so the client can tell
      // "still coming up" from "was here and is gone".
      status: 'running',
    })
    expect(rm.previewViewedAt.has(key('p1'))).toBe(true)
    // The ping is also a UI signal, so it refreshes the MRU. Put p1 back at the
    // tail: the point is that the *pin*, not MRU order, is what protects it.
    rm.workspacePreviewMru = [key('p3'), key('p2'), key('p1')]

    // A fourth open is what runs the cap.
    await openPreview(app, 'p4')

    expect(stopped).toEqual([])
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      expect(rm.runtimes.get(key(id))?.status).toBe('running')
    }
    expect(rm.workspacePreviewMru).toContain(key('p1'))
  })

  test('the same tail key IS the victim once the view TTL lapses — the pin is what saved it', async () => {
    const prevTtl = process.env.PREVIEW_VIEW_TTL_MS
    process.env.PREVIEW_VIEW_TTL_MS = '1'
    let rm: PrivateRM
    try {
      rm = newManager()
    } finally {
      if (prevTtl === undefined) delete process.env.PREVIEW_VIEW_TTL_MS
      else process.env.PREVIEW_VIEW_TTL_MS = prevTtl
    }
    manager = rm
    const stopped = stubStop(rm)
    const app = makeApp(rm)

    for (const id of ['p1', 'p2', 'p3']) await openPreview(app, id)
    rm.workspacePreviewMru = [key('p3'), key('p2'), key('p1')]
    await ping(app, 'p1')
    rm.workspacePreviewMru = [key('p3'), key('p2'), key('p1')]

    // No ping for longer than the window: the preview is evictable again.
    await new Promise((resolve) => setTimeout(resolve, 15))
    await openPreview(app, 'p4')

    expect(stopped).toEqual([key('p1')])
  })
})

describe('SHO-226 round 2 — a cold start is not a lost runtime', () => {
  /**
   * The regression three E2E jobs caught in round 1: a runtime that is merely
   * warming up answers `running:false`, and the canvas re-resolved
   * `/sandbox/url` under the user — which re-enters the loading gate and made
   * the composer and "+ new chat" unreachable (machine-workspaces-live:280,
   * project-chat-url:250). The API has to say `starting` so the client can tell
   * a cold boot from a runtime that died.
   */
  test('a starting runtime answers running:false with status starting, and is not restarted', async () => {
    const rm = newManager()
    manager = rm
    stubStop(rm)
    const app = makeApp(rm)

    const seeded = await rm.startProjectWorkspace('p1', { workspaceId: 'w1' })
    const spawnsBefore = rm.doStartMergedRuntime.mock.calls.length
    // The agent process is up on a port but has not finished booting — the
    // state a machine workspace / a cold start sits in for tens of seconds.
    rm.runtimes.get(key('p1'))!.status = 'starting'

    const body = await ping(app, 'p1')

    expect(body).toEqual({
      ok: true,
      running: false,
      agentPort: seeded.agentPort,
      status: 'starting',
    })
    expect(rm.runtimes.get(key('p1'))!.status).toBe('starting')
    expect(rm.doStartMergedRuntime.mock.calls.length).toBe(spawnsBefore)
  })
})

describe('SHO-226 AC5 — the ping is a pin, never a start', () => {
  test('it resets the worker idle slot and does not spawn anything', async () => {
    const rm = newManager()
    manager = rm
    stubStop(rm)
    const app = makeApp(rm)

    await openPreview(app, 'p1')
    const spawnsBefore = rm.doStartMergedRuntime.mock.calls.length
    rm.agentManager.touch.mockClear()

    const body = await ping(app, 'p1')

    expect(body).toEqual({
      ok: true,
      running: true,
      agentPort: rm.runtimes.get(key('p1'))!.agentPort,
      status: 'running',
    })
    // The idle reaper's own signal: a pinged runtime is not idle.
    expect(rm.agentManager.touch).toHaveBeenCalledWith(key('p1'))
    expect(rm.doStartMergedRuntime.mock.calls.length).toBe(spawnsBefore)
  })

  test('a stopped runtime answers running:false and stays stopped', async () => {
    const rm = newManager()
    manager = rm
    stubStop(rm)
    const app = makeApp(rm)

    await openPreview(app, 'p1')
    await (rm as any).stop(key('p1'), 'test')

    const body = await ping(app, 'p1')

    // `running` is the signal the client acts on first, so the stale port the
    // route echoes back for a dead runtime can never be mistaken for a live one.
    expect(body.ok).toBe(true)
    expect(body.running).toBe(false)
    // Round 2: `stopped` is the positive evidence the canvas needs — a canvas
    // that never saw this runtime live still recovers on it.
    expect(body.status).toBe('stopped')
    expect(rm.runtimes.get(key('p1'))?.status).toBe('stopped')
    expect(rm.doStartMergedRuntime.mock.calls.length).toBe(1)
  })
})

// ─── AC6 (server half): the canvas can tell, and can come back ────────────

describe('SHO-226 AC6 — the recovery contract the canvas relies on', () => {
  test('runtime force-stopped under the canvas: ping says gone, the next open comes back on a live port', async () => {
    const rm = newManager()
    manager = rm
    stubStop(rm)
    const app = makeApp(rm)

    const first = await openPreview(app, 'p1')
    const before = await ping(app, 'p1')
    expect(before.running).toBe(true)

    // The client compares the ping's agentPort against the port the iframe is
    // on, parsed from `canvasBaseUrl` (`http://localhost:<agentPort>/p/<id>`).
    expect(new URL(first.canvasBaseUrl).port).toBe(String(before.agentPort))

    // Evicted / killed under the user — the failure this card is about.
    await (rm as any).stop(key('p1'), 'preview-lru')
    const gone = await ping(app, 'p1')
    expect(gone.ok).toBe(true)
    expect(gone.running).toBe(false)
    expect(gone.status).toBe('stopped')

    // `retryAgentUrl()` → `/sandbox/url` again: the runtime is restarted and the
    // response carries the port the iframe must now load.
    const second = await openPreview(app, 'p1')
    const after = await ping(app, 'p1')
    expect(after.running).toBe(true)
    expect(after.agentPort).not.toBeNull()
    expect(new URL(second.canvasBaseUrl).port).toBe(String(after.agentPort))
    // A respawn is a new port, which is exactly what makes the old iframe dead.
    expect(after.agentPort).not.toBe(before.agentPort)
  })
})
