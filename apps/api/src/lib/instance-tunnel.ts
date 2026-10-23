// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Instance Tunnel Client (desktop adapter)
 *
 * Thin AGPL wrapper around `WorkerTunnel` from `@shogo-ai/worker`
 * (MIT). The transport, framing, heartbeat loop, on-demand WebSocket,
 * and reconnect/backoff logic all live in the worker package as a
 * single canonical implementation; this file only supplies the
 * desktop-specific resolver (per-project agent-runtime + apps/api
 * fallback) and the on-auth-revoked hook (`wipeCloudKey`).
 *
 * The module-level public API (`startInstanceTunnel`,
 * `stopInstanceTunnel`, `isTunnelConnected`, `TUNNEL_PROTOCOL_VERSION`,
 * `TunnelWebSocketHeaderSupportError`, `_testing`) is preserved verbatim
 * so server.ts, local-auth.ts, cloud-key-wipe.ts, and the existing
 * test suite don't need to change.
 *
 * History: this file used to be a 650-line module-global implementation
 * (`apps/api/src/lib/instance-tunnel.ts` pre-2026-05-14). It was lifted
 * into the worker package and re-licensed MIT (sole-corp authorship,
 * verified via git blame) to provide a single canonical home for the
 * tunnel; the desktop is now one of two consumers, the cli-worker is
 * the other. Behaviour is unchanged — only the call site moved.
 */

import { hostname as osHostname, platform, arch as osArch } from 'os'
import {
  WorkerTunnel,
  TunnelWebSocketHeaderSupportError as _TunnelWebSocketHeaderSupportError,
  TUNNEL_PROTOCOL_VERSION as _TUNNEL_PROTOCOL_VERSION,
  type RuntimeResolver,
} from '@shogo-ai/worker/tunnel'
import { startTunnelInWorker } from '@shogo-ai/worker/tunnel-host'
import { getRuntimeManager } from './runtime'
import { collectMachineSnapshot } from './machine-snapshot'
import { wipeCloudKey } from './cloud-key-wipe'
import { deriveProjectRuntimeToken } from './project-runtime-token'
import { getShogoCloudUrl } from './cloud-urls'
import { resolveLocalApiPort } from './local-api-port'
import { prisma } from './prisma'
import { listCloudWorkspaces } from '../services/cloud-workspaces'

// Re-export the worker's symbols so existing callers keep working.
export const TUNNEL_PROTOCOL_VERSION = _TUNNEL_PROTOCOL_VERSION
export const TunnelWebSocketHeaderSupportError = _TunnelWebSocketHeaderSupportError
export type TunnelWebSocketHeaderSupportError = _TunnelWebSocketHeaderSupportError

// ─── Desktop-specific resolver ──────────────────────────────────────────────

function splitPathAndQuery(pathWithQuery: string): { pathname: string; search: string } {
  const q = pathWithQuery.indexOf('?')
  if (q === -1) return { pathname: pathWithQuery, search: '' }
  return { pathname: pathWithQuery.slice(0, q), search: pathWithQuery.slice(q) }
}

/**
 * Desktop resolver:
 *
 *   - `/agent/*` → ensures the per-project agent-runtime is running
 *     via the desktop's existing `RuntimeManager`, then proxies to
 *     `http://localhost:${runtime.agentPort}`. Cold-start latency
 *     surfaces as request latency (matches the same RuntimeManager
 *     behaviour exposed at `/api/projects/:id/agent-proxy/*`).
 *   - Anything else → forwards to the local apps/api on `resolveLocalApiPort()`,
 *     which is what the desktop already serves.
 *
 * `deriveRuntimeToken` replaces the cloud's `x-runtime-token` with one this
 * desktop minted: the local runtime serving a project is a workspace runtime,
 * so its RUNTIME_AUTH_SECRET is the locally signed workspace token.
 */
const SNAPSHOT_TTL_MS = 20_000
let snapshotCache: { at: number; value: Record<string, unknown> } | null = null

/**
 * Projects whose runtime this tunnel asked to start in the background, and when.
 * An `/agent/*` request for one of them is answered with `RUNTIME_STARTING` so
 * the client retries instead of showing an error.
 *
 * Time-based, not cleared when the start settles: the rejection is described on
 * a later tick than the request, so a start that settles quickly (or fails) would
 * otherwise be reported as NO_LOCAL_RUNTIME and the client would stop retrying.
 */
const startRequestedAt = new Map<string, number>()
const STARTING_WINDOW_MS = 60_000

const desktopResolver: RuntimeResolver = {
  async resolveLocalUrl(pathWithQuery, projectId) {
    const { pathname, search } = splitPathAndQuery(pathWithQuery)
    const path = pathname || '/'

    if (path.startsWith('/agent/') || path === '/agent') {
      try {
        const manager = getRuntimeManager()
        // Never start a runtime from here, and never fan out over every project.
        // `manager.start()` runs `lsof`/`ps` and can take seconds; awaiting it
        // inside a tunnel request froze the local API's event loop, which is in
        // the same process as this tunnel, so `/health` stopped answering and the
        // desktop supervisor killed the API mid-request (SHO-185).
        if (projectId) {
          const runtime = manager.status(projectId)
          if (runtime?.agentPort && runtime.status === 'running') {
            return `http://localhost:${runtime.agentPort}${path}${search}`
          }
          // Kick the start off and let the caller retry: the cloud answers
          // `runtime_starting`, the client retries with Retry-After.
          if (!runtime || runtime.status !== 'starting') {
            startRequestedAt.set(projectId, Date.now())
            void manager
              .start(projectId)
              .catch((err: any) => {
                console.warn(`[InstanceTunnel] Background start failed for ${projectId}: ${err?.message ?? err}`)
              })
          }
          return null
        }

        // No project named: use whichever runtime is already up rather than
        // starting all of them to find out.
        for (const pid of manager.getActiveProjects()) {
          const runtime = manager.status(pid)
          if (runtime?.agentPort && runtime.status === 'running') {
            return `http://localhost:${runtime.agentPort}${path}${search}`
          }
        }
      } catch (err: any) {
        console.warn(`[InstanceTunnel] resolveLocalUrl: ${err?.message ?? err}`)
      }
    }

    // Non-agent paths (and /agent/* fall-through when no runtime is
    // available) default to the local apps/api server. The historical
    // contract was "anything I receive on the tunnel I forward locally" —
    // this preserves that.
    return `http://localhost:${resolveLocalApiPort()}${path}${search}`
  },

  async deriveRuntimeToken(projectId) {
    try {
      return await deriveProjectRuntimeToken(projectId)
    } catch (err: any) {
      console.warn(`[InstanceTunnel] runtime token for ${projectId} unavailable: ${err?.message ?? err}`)
      return null
    }
  },

  getActiveProjects() {
    try {
      return getRuntimeManager().getActiveProjects()
    } catch {
      return []
    }
  },

  /**
   * Why `resolveLocalUrl` returned null. A project whose runtime this tunnel is
   * starting gets `RUNTIME_STARTING` (retryable) instead of the generic
   * `NO_LOCAL_RUNTIME`, so Studio can say "starting…" rather than show an error
   * while a cold runtime comes up (SHO-185).
   */
  describeRejection(pathWithQuery: string, projectId?: string) {
    const { pathname } = splitPathAndQuery(pathWithQuery)
    const path = pathname || '/'
    const requestedAt = projectId ? startRequestedAt.get(projectId) : undefined
    const starting = requestedAt !== undefined && Date.now() - requestedAt < STARTING_WINDOW_MS
    if (projectId && starting && (path.startsWith('/agent/') || path === '/agent')) {
      return {
        code: 'RUNTIME_STARTING',
        message: `runtime for project ${projectId} is starting`,
      }
    }
    return { code: 'NO_LOCAL_RUNTIME', message: `no local runtime available for path: ${path}` }
  },

  /**
   * Heartbeat metadata: the workspaces this machine owns, so the cloud can
   * list them (and keep showing the last-known list while offline) without
   * mirroring any of the machine's data.
   */
  async machineSnapshot() {
    // One read per cycle, not one per tunnel: the snapshot walks SQLite for
    // workspaces and activity, and a fan-out has several tunnels heartbeating.
    const now = Date.now()
    if (snapshotCache && now - snapshotCache.at < SNAPSHOT_TTL_MS) return snapshotCache.value
    try {
      const value = (await collectMachineSnapshot()) as unknown as Record<string, unknown>
      snapshotCache = { at: now, value }
      return value
    } catch (err: any) {
      console.warn(`[InstanceTunnel] machine snapshot unavailable: ${err?.message ?? err}`)
      return null
    }
  },

  status(projectId) {
    try {
      const s = getRuntimeManager().status(projectId)
      if (!s) return null
      return { status: s.status, agentPort: s.agentPort }
    } catch {
      return null
    }
  },
}

// ─── Module-level singletons (desktop expects this shape) ───────────────────

/** Key for the tunnel built from `SHOGO_API_KEY` — the one the app signs in with. */
const PRIMARY_TUNNEL = 'primary'

/**
 * One tunnel per cloud workspace the desktop holds a device key for.
 *
 * A machine belongs to a *person*, but the cloud files its `instances` row under
 * the workspace its key was issued in — so a desktop signed into three
 * workspaces would only ever appear in one of them. Each stored device key gets
 * its own tunnel, and the machine registers in every workspace it is signed into.
 * Keyed by workspace id (`PRIMARY_TUNNEL` for the primary key until that id is
 * known).
 */
const activeTunnels = new Map<string, TunnelHandle>()
const tunnelNames = new Map<string, string>()
/** The device key each fan-out tunnel was opened with, so a rotated key can restart it. */
const tunnelKeys = new Map<string, string>()
let activeTunnel: TunnelHandle | null = null

/**
 * What the rest of this module needs from a tunnel, whichever thread it runs on.
 */
interface TunnelHandle {
  start(): void
  stop(): void
  isConnected(): boolean
  readonly instanceId: string | null
}

/**
 * Put the tunnel on its own thread (SHO-185 §5).
 *
 * The socket answers the cloud's app-level pings from JavaScript, so while it
 * shared this process's event loop a `lsof`, a migration or a large write meant
 * no pong — and the cloud closed it (1006) with the person told their machine
 * was offline while it sat right there. The socket, its timers and its local
 * `fetch`es now live in a Bun `Worker`; this module keeps the resolvers it cannot
 * have (`desktopResolver`) and answers its questions over messages.
 *
 * If a worker cannot be spawned — a bundle without the entry file, a runtime
 * that refuses one — remote control falls back to the in-process tunnel instead
 * of disappearing.
 */
/**
 * Test seam: run the live tunnel in-process, the way it used to.
 *
 * The protocol suite drives the tunnel through a fake `WebSocket` and a fake
 * `fetch`, which cannot reach into a worker. Those tests are about the protocol,
 * and the threading has its own test (`tunnel-worker-block.test.ts`), so they
 * ask for the old shape explicitly instead of the product quietly keeping a knob
 * that could turn the fix off in production.
 */
let forceInProcessTunnel = false

class ThreadedTunnel implements TunnelHandle {
  private host: ReturnType<typeof startTunnelInWorker> | null = null
  private fallback: WorkerTunnel | null = null
  private instanceIdValue: string | null = null
  private connected = false
  private stopped = false

  constructor(private readonly options: ConstructorParameters<typeof WorkerTunnel>[0]) {}

  start(): void {
    if (this.stopped || this.host || this.fallback) return
    if (forceInProcessTunnel) {
      this.startInProcess()
      return
    }
    let host: ReturnType<typeof startTunnelInWorker>
    try {
      host = startTunnelInWorker({
        apiKey: this.options.apiKey,
        cloudUrl: this.options.cloudUrl,
        name: this.options.name,
        kind: this.options.kind,
        wsUrlOverride: this.options.wsUrlOverride,
        resolver: this.options.resolver,
        onAuthRevoked: this.options.onAuthRevoked,
        onInstanceId: (instanceId) => {
          this.instanceIdValue = instanceId
        },
        onConnection: (connected) => {
          this.connected = connected
        },
        onWorkerError: (error) => this.demoteToInProcess(error),
      })
    } catch (err: any) {
      this.demoteToInProcess(err)
      return
    }

    this.host = host
    // Spawning a worker is not proof it came up: a packaging step that forgets
    // the entry file leaves `new Worker()` raising nothing until later, so
    // readiness is what decides the mode. Until then the machine has no tunnel
    // at all, which is exactly what the user saw.
    void host.ready().catch((err: any) => this.demoteToInProcess(err))
  }

  /**
   * Drop the worker and run the tunnel here instead.
   *
   * Remote control is worth losing the thread isolation for; it is not worth
   * losing altogether, so a worker that cannot start (or cannot come up) hands
   * the tunnel back to this process.
   */
  private demoteToInProcess(reason: unknown): void {
    if (this.stopped || this.fallback) return
    const host = this.host
    this.host = null
    this.connected = false
    this.instanceIdValue = null
    try {
      host?.stop()
    } catch {
      // nothing to do
    }
    console.warn(
      `[InstanceTunnel] no worker available (${
        (reason as any)?.message ?? reason
      }); running the tunnel in-process`,
    )
    this.startInProcess()
  }

  private startInProcess(): void {
    if (this.stopped || this.fallback) return
    this.fallback = new WorkerTunnel(this.options)
    this.fallback.start()
  }

  stop(): void {
    this.stopped = true
    try {
      this.host?.stop()
    } catch {
      // nothing to do
    }
    try {
      this.fallback?.stop()
    } catch {
      // nothing to do
    }
    this.host = null
    this.fallback = null
  }

  isConnected(): boolean {
    return this.host ? this.connected : (this.fallback?.isConnected() ?? false)
  }

  get instanceId(): string | null {
    return this.host ? this.instanceIdValue : (this.fallback?.instanceId ?? null)
  }

  /** The in-process tunnel, when that is the mode — so `_testing` can reach it. */
  get inProcess(): WorkerTunnel | null {
    return this.fallback
  }
}

/**
 * A plain in-process tunnel, for the protocol tests only.
 *
 * The live tunnel now runs on its own thread (§5), where `sendHeartbeat`,
 * `buildWsUrl` and the reconnect counters are not reachable — and they are what
 * `_testing` exists to poke. Those tests are about the tunnel's protocol, not
 * about which thread it is on, so they keep a raw `WorkerTunnel`.
 */
let testingTunnel: WorkerTunnel | null = null
function getTestingTunnel(): WorkerTunnel {
  // In in-process mode the live tunnel *is* a WorkerTunnel, and `_testing` has to
  // reach that exact object: the protocol tests start the tunnel and then drive
  // its heartbeat, so a second, separate instance would answer nothing.
  if (forceInProcessTunnel && activeTunnel instanceof ThreadedTunnel) {
    const inner = activeTunnel.inProcess
    if (inner) return inner
  }
  if (testingTunnel) return testingTunnel
  testingTunnel = new WorkerTunnel({
    apiKey: process.env.SHOGO_API_KEY ?? '',
    cloudUrl: getShogoCloudUrl(),
    name: process.env.SHOGO_INSTANCE_NAME || osHostname(),
    kind: 'desktop',
    resolver: desktopResolver,
    onAuthRevoked: (reason) => {
      void wipeCloudKey(`instance tunnel ${reason}`)
    },
  })
  return testingTunnel
}

function createTunnel(apiKey: string): TunnelHandle {
  return new ThreadedTunnel({
    apiKey,
    cloudUrl: getShogoCloudUrl(),
    name: process.env.SHOGO_INSTANCE_NAME || osHostname(),
    kind: 'desktop',
    resolver: desktopResolver,
    onAuthRevoked: (reason) => {
      void wipeCloudKey(`instance tunnel ${reason}`)
    },
  })
}

function getOrCreateTunnel(): TunnelHandle {
  if (activeTunnel) return activeTunnel
  activeTunnel = createTunnel(process.env.SHOGO_API_KEY ?? '')
  activeTunnels.set(PRIMARY_TUNNEL, activeTunnel)
  tunnelNames.set(PRIMARY_TUNNEL, process.env.SHOGO_INSTANCE_NAME || osHostname())
  tunnelKeys.set(PRIMARY_TUNNEL, process.env.SHOGO_API_KEY ?? '')
  return activeTunnel
}

/** The workspace the primary key was issued in, from `SHOGO_KEY_INFO`. */
async function primaryWorkspaceId(): Promise<string | null> {
  try {
    const row = await (prisma as any).localConfig?.findUnique?.({ where: { key: 'SHOGO_KEY_INFO' } })
    const id = row?.value ? JSON.parse(row.value)?.workspace?.id : null
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

/**
 * Start a tunnel for every other workspace the desktop is signed into.
 *
 * `SHOGO_CLOUD_WORKSPACES` holds one device key per workspace (written at
 * sign-in and refreshed by `syncCloudWorkspaces`). A stored key identical to the
 * primary is skipped — that workspace's tunnel is already running, and two
 * tunnels with the same key would race for the same `(workspaceId, hostname)`
 * row. With `enabled: false` (a pasted key, a headless worker) exactly one tunnel
 * runs, which is the pre-fan-out behaviour.
 */
async function startWorkspaceTunnels(): Promise<void> {
  try {
    const { workspaces, enabled } = await listCloudWorkspaces()
    if (!enabled || !workspaces.length) return
    const primaryKey = process.env.SHOGO_API_KEY ?? ''
    const primaryId = await primaryWorkspaceId()
    for (const workspace of workspaces) {
      const key = workspace.key
      if (!key || key === primaryKey) continue
      if (primaryId && workspace.id === primaryId) continue
      if (activeTunnels.has(workspace.id)) continue
      try {
        const tunnel = createTunnel(key)
        tunnel.start()
        activeTunnels.set(workspace.id, tunnel)
        tunnelNames.set(workspace.id, workspace.name || process.env.SHOGO_INSTANCE_NAME || osHostname())
        tunnelKeys.set(workspace.id, key)
        console.log(`[InstanceTunnel] Also registered in "${workspace.name}"`)
      } catch (err: any) {
        console.warn(`[InstanceTunnel] tunnel for ${workspace.id} failed to start: ${err?.message ?? err}`)
      }
    }
  } catch (err: any) {
    console.warn(`[InstanceTunnel] per-workspace tunnels unavailable: ${err?.message ?? err}`)
  }
}

// ─── Public API (preserved verbatim from the pre-refactor module) ───────────

export function startInstanceTunnel(): void {
  if (!process.env.SHOGO_API_KEY) {
    console.log('[InstanceTunnel] No SHOGO_API_KEY set, skipping tunnel')
    return
  }
  // Force a fresh instance so a previous stop()'d tunnel + a new
  // SHOGO_API_KEY env value are reflected on restart. Matches the
  // legacy module-singleton lifecycle.
  stopQuietly()
  console.log('[InstanceTunnel] Starting heartbeat polling to Shogo Cloud...')
  getOrCreateTunnel().start()
  // Fan out to the user's other workspaces; the read is async, the primary
  // tunnel is already up by then.
  void startWorkspaceTunnels()
}

/**
 * Bring the fan-out in line with the stored key set.
 *
 * `syncCloudWorkspaces()` runs every ten minutes and can both gain a workspace
 * (one joined from another device) and lose one (left, or revoked). Without this
 * a mid-session join would only register at the next app start, and a left
 * workspace would keep a heartbeat flowing until then. The primary tunnel is
 * never touched: its key is the one this process was launched with.
 */
export async function syncWorkspaceTunnels(): Promise<void> {
  if (!process.env.SHOGO_API_KEY) return
  let stored: Awaited<ReturnType<typeof listCloudWorkspaces>>
  try {
    stored = await listCloudWorkspaces()
  } catch {
    return
  }
  const keep = new Set<string>([PRIMARY_TUNNEL])
  if (stored.enabled) {
    for (const workspace of stored.workspaces) keep.add(workspace.id)
  }

  // A workspace that was left, or whose key was rotated: stop it here so the
  // start below can re-open it with the current key.
  for (const [id, tunnel] of [...activeTunnels]) {
    if (id === PRIMARY_TUNNEL) continue
    const workspace = stored.workspaces.find((w) => w.id === id)
    const stale = !keep.has(id) || (workspace && tunnelKeys.get(id) !== workspace.key)
    if (!stale) continue
    try {
      tunnel.stop()
    } catch {
      /* nothing to do */
    }
    activeTunnels.delete(id)
    tunnelKeys.delete(id)
    const name = tunnelNames.get(id)
    tunnelNames.delete(id)
    if (name) console.log(`[InstanceTunnel] Unregistered from "${name}"`)
  }

  await startWorkspaceTunnels()
}

export function stopInstanceTunnel(): void {
  if (!activeTunnels.size && !activeTunnel) return
  for (const tunnel of activeTunnels.values()) {
    try { tunnel.stop() } catch { /* nothing to do */ }
  }
  activeTunnels.clear()
  tunnelNames.clear()
  tunnelKeys.clear()
  activeTunnel = null
  console.log('[InstanceTunnel] Tunnel stopped')
}

/** Restart without logging a stop for tunnels that were never started. */
function stopQuietly(): void {
  for (const tunnel of activeTunnels.values()) {
    try { tunnel.stop() } catch { /* nothing to do */ }
  }
  activeTunnels.clear()
  tunnelNames.clear()
  tunnelKeys.clear()
  activeTunnel = null
}

/**
 * The cloud `instances` row id for this machine, from the primary tunnel's last
 * heartbeat. Null until the cloud has answered one — the machine copy waits for
 * it rather than inventing an identity (SHO-185).
 */
export function getInstanceId(): string | null {
  if (activeTunnel) return activeTunnel.instanceId
  return activeTunnels.values().next().value?.instanceId ?? null
}

export function isTunnelConnected(): boolean {
  if (activeTunnel?.isConnected()) return true
  for (const tunnel of activeTunnels.values()) {
    if (tunnel.isConnected()) return true
  }
  return false
}

/**
 * Which cloud workspaces this machine is currently registered in, for
 * Settings → Cloud Registration. `connecting` means the tunnel is up or
 * starting but has not completed its first heartbeat yet — never report
 * `connected` before the cloud has acknowledged one.
 */
export function getInstanceTunnelStatus(): Array<{
  id: string
  name: string
  state: 'connected' | 'connecting'
}> {
  return [...activeTunnels.entries()].map(([id, tunnel]) => ({
    id,
    name: tunnelNames.get(id) ?? id,
    state: tunnel.isConnected() ? 'connected' : 'connecting',
  }))
}

// ─── Test surface ───────────────────────────────────────────────────────────
/**
 * Preserves the legacy `_testing` shape the existing test suite uses
 * (`sendHeartbeat`, `heartbeatLoop`, `getCloudUrl`, `buildWsUrl`,
 * `getWsBaseUrl`, `supportsWebSocketConstructorHeaders`,
 * `createTunnelWebSocket`, `serverPublishedWsUrl` get/set, etc.).
 *
 * Lazily constructs the underlying WorkerTunnel on first access so
 * tests that mutate `process.env.SHOGO_CLOUD_URL` between imports
 * still see the updated value (the legacy module-global behaviour).
 */
export const _testing = {
  get tunnel(): WorkerTunnel { return getTestingTunnel() },

  // Constants — re-exposed at the same paths the legacy module used.
  get DEFAULT_POLL_INTERVAL_S() { return getTestingTunnel()._testing().DEFAULT_POLL_INTERVAL_S },
  get BACKOFF_BASE_MS() { return getTestingTunnel()._testing().BACKOFF_BASE_MS },
  get BACKOFF_MAX_MS() { return getTestingTunnel()._testing().BACKOFF_MAX_MS },
  get TUNNEL_PROTOCOL_VERSION() { return getTestingTunnel()._testing().TUNNEL_PROTOCOL_VERSION },

  // Methods — bound to the active tunnel. `getCloudUrl()` is the one
  // exception: tests delete SHOGO_CLOUD_URL between imports and expect
  // the next read to default to the studio URL. Routing through the
  // shared `getShogoCloudUrl()` (which re-reads `process.env`) instead
  // of the tunnel's construction-time cached value preserves that
  // contract.
  sendHeartbeat: () => getTestingTunnel()._testing().sendHeartbeat(),
  heartbeatLoop: () => getTestingTunnel()._testing().heartbeatLoop(),
  connectWs: () => getTestingTunnel()._testing().connectWs(),
  cleanupWs: () => getTestingTunnel()._testing().cleanupWs(),
  getCloudUrl: () => getShogoCloudUrl(),
  getWsBaseUrl: () => getTestingTunnel()._testing().getWsBaseUrl(),
  buildWsUrl: () => getTestingTunnel()._testing().buildWsUrl(),
  getReconnectDelay: () => getTestingTunnel()._testing().getReconnectDelayMs(),

  // The two helpers below historically accepted an injected runtime so
  // tests could simulate non-Bun environments. Forward through to the
  // worker tunnel's same-named helpers.
  supportsWebSocketConstructorHeaders: (runtime?: any) =>
    getTestingTunnel()._testing().supportsWebSocketConstructorHeaders(runtime),
  createTunnelWebSocket: (url: string, init: { headers: Record<string, string> }, runtime?: any) =>
    getTestingTunnel()._testing().createTunnelWebSocket(url, init, runtime),

  // Mutable accessors — the legacy module exposed `currentPollInterval`,
  // `wsReconnectAttempt`, `serverPublishedWsUrl` as get/set. Tests use
  // these to inject state. We forward to the underlying tunnel; setters
  // on the WorkerTunnel are intentionally not exposed (the field lifecycle
  // is now manager-internal), so we keep get-only here. The single test
  // that mutates `serverPublishedWsUrl = null` is satisfied by the
  // `resetForTests()` escape hatch below.
  get currentPollInterval() { return getTestingTunnel()._testing().currentPollInterval },
  set currentPollInterval(v: number) { getTestingTunnel()._testing().currentPollInterval = v },
  get wsReconnectAttempt() { return getTestingTunnel()._testing().wsReconnectAttempt },
  set wsReconnectAttempt(v: number) { getTestingTunnel()._testing().wsReconnectAttempt = v },
  get ws() { return getTestingTunnel()._testing().ws },
  get stopped() { return getTestingTunnel()._testing().stopped },
  get serverPublishedWsUrl() { return getTestingTunnel()._testing().serverPublishedWsUrl },
  set serverPublishedWsUrl(v: string | null) { getTestingTunnel()._testing().serverPublishedWsUrl = v },

  /** Run the live tunnel on this thread — see `forceInProcessTunnel`. */
  forceInProcess(): void {
    forceInProcessTunnel = true
  },

  /** Fully discard the underlying tunnel — for tests that want a clean slate. */
  resetForTests(): void {
    if (activeTunnel) {
      try { activeTunnel.stop() } catch { /* nothing */ }
      activeTunnel = null
    }
  },
}

// Suppress unused-import warning for SDKs that exclude osArch / platform
// from this file when they're consumed transitively. They were only
// needed by the legacy module-global implementation; kept available
// here for any AGPL caller that wants to add desktop-only metadata to
// the resolver.
void platform
void osArch
