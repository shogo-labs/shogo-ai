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
import { getRuntimeManager } from './runtime'
import { wipeCloudKey } from './cloud-key-wipe'
import { deriveRuntimeToken } from './runtime-token'
import { getShogoCloudUrl } from './cloud-urls'

// Re-export the worker's symbols so existing callers keep working.
export const TUNNEL_PROTOCOL_VERSION = _TUNNEL_PROTOCOL_VERSION
export const TunnelWebSocketHeaderSupportError = _TunnelWebSocketHeaderSupportError
export type TunnelWebSocketHeaderSupportError = _TunnelWebSocketHeaderSupportError

// ─── Desktop-specific resolver ──────────────────────────────────────────────

function getApiPort(): number {
  return parseInt(process.env.PORT || process.env.API_PORT || '8002', 10)
}

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
 *   - Anything else → forwards to the local apps/api on `getApiPort()`,
 *     which is what the desktop already serves.
 *
 * `deriveRuntimeToken` is the AGPL v1-self-identifying derivation
 * (`rt_v1_<projectId>_<hmac>`) — desktop runtimes were minted with
 * this scheme and the API server's verifier expects it.
 */
const desktopResolver: RuntimeResolver = {
  async resolveLocalUrl(pathWithQuery, projectId) {
    const { pathname, search } = splitPathAndQuery(pathWithQuery)
    const path = pathname || '/'

    if (path.startsWith('/agent/') || path === '/agent') {
      try {
        const manager = getRuntimeManager()
        const candidates = projectId ? [projectId] : manager.getActiveProjects()
        for (const pid of candidates) {
          try {
            let runtime = manager.status(pid)
            if (!runtime?.agentPort || runtime.status !== 'running') {
              runtime = await manager.start(pid)
            }
            if (runtime?.agentPort && runtime.status === 'running') {
              return `http://localhost:${runtime.agentPort}${path}${search}`
            }
          } catch (err: any) {
            console.warn(`[InstanceTunnel] Agent URL resolve failed for ${pid}: ${err?.message ?? err}`)
            if (projectId) break
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
    return `http://localhost:${getApiPort()}${path}${search}`
  },

  deriveRuntimeToken(projectId) {
    return deriveRuntimeToken(projectId)
  },

  getActiveProjects() {
    try {
      return getRuntimeManager().getActiveProjects()
    } catch {
      return []
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

// ─── Module-level singleton (desktop expects this shape) ────────────────────

let activeTunnel: WorkerTunnel | null = null

function getOrCreateTunnel(): WorkerTunnel {
  if (activeTunnel) return activeTunnel
  const apiKey = process.env.SHOGO_API_KEY ?? ''
  const cloudUrl = getShogoCloudUrl()
  const name = process.env.SHOGO_INSTANCE_NAME || osHostname()
  activeTunnel = new WorkerTunnel({
    apiKey,
    cloudUrl,
    name,
    kind: 'desktop',
    resolver: desktopResolver,
    onAuthRevoked: (reason) => {
      void wipeCloudKey(`instance tunnel ${reason}`)
    },
  })
  return activeTunnel
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
  if (activeTunnel) {
    try { activeTunnel.stop() } catch { /* already stopped */ }
    activeTunnel = null
  }
  console.log('[InstanceTunnel] Starting heartbeat polling to Shogo Cloud...')
  getOrCreateTunnel().start()
}

export function stopInstanceTunnel(): void {
  if (!activeTunnel) return
  try { activeTunnel.stop() } catch { /* nothing to do */ }
  activeTunnel = null
  console.log('[InstanceTunnel] Tunnel stopped')
}

export function isTunnelConnected(): boolean {
  return activeTunnel?.isConnected() ?? false
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
  get tunnel(): WorkerTunnel { return getOrCreateTunnel() },

  // Constants — re-exposed at the same paths the legacy module used.
  get DEFAULT_POLL_INTERVAL_S() { return getOrCreateTunnel()._testing().DEFAULT_POLL_INTERVAL_S },
  get BACKOFF_BASE_MS() { return getOrCreateTunnel()._testing().BACKOFF_BASE_MS },
  get BACKOFF_MAX_MS() { return getOrCreateTunnel()._testing().BACKOFF_MAX_MS },
  get TUNNEL_PROTOCOL_VERSION() { return getOrCreateTunnel()._testing().TUNNEL_PROTOCOL_VERSION },

  // Methods — bound to the active tunnel. `getCloudUrl()` is the one
  // exception: tests delete SHOGO_CLOUD_URL between imports and expect
  // the next read to default to the studio URL. Routing through the
  // shared `getShogoCloudUrl()` (which re-reads `process.env`) instead
  // of the tunnel's construction-time cached value preserves that
  // contract.
  sendHeartbeat: () => getOrCreateTunnel()._testing().sendHeartbeat(),
  heartbeatLoop: () => getOrCreateTunnel()._testing().heartbeatLoop(),
  connectWs: () => getOrCreateTunnel()._testing().connectWs(),
  cleanupWs: () => getOrCreateTunnel()._testing().cleanupWs(),
  getCloudUrl: () => getShogoCloudUrl(),
  getWsBaseUrl: () => getOrCreateTunnel()._testing().getWsBaseUrl(),
  buildWsUrl: () => getOrCreateTunnel()._testing().buildWsUrl(),
  getReconnectDelay: () => getOrCreateTunnel()._testing().getReconnectDelayMs(),

  // The two helpers below historically accepted an injected runtime so
  // tests could simulate non-Bun environments. Forward through to the
  // worker tunnel's same-named helpers.
  supportsWebSocketConstructorHeaders: (runtime?: any) =>
    getOrCreateTunnel()._testing().supportsWebSocketConstructorHeaders(runtime),
  createTunnelWebSocket: (url: string, init: { headers: Record<string, string> }, runtime?: any) =>
    getOrCreateTunnel()._testing().createTunnelWebSocket(url, init, runtime),

  // Mutable accessors — the legacy module exposed `currentPollInterval`,
  // `wsReconnectAttempt`, `serverPublishedWsUrl` as get/set. Tests use
  // these to inject state. We forward to the underlying tunnel; setters
  // on the WorkerTunnel are intentionally not exposed (the field lifecycle
  // is now manager-internal), so we keep get-only here. The single test
  // that mutates `serverPublishedWsUrl = null` is satisfied by the
  // `resetForTests()` escape hatch below.
  get currentPollInterval() { return getOrCreateTunnel()._testing().currentPollInterval },
  set currentPollInterval(v: number) { getOrCreateTunnel()._testing().currentPollInterval = v },
  get wsReconnectAttempt() { return getOrCreateTunnel()._testing().wsReconnectAttempt },
  set wsReconnectAttempt(v: number) { getOrCreateTunnel()._testing().wsReconnectAttempt = v },
  get ws() { return getOrCreateTunnel()._testing().ws },
  get stopped() { return getOrCreateTunnel()._testing().stopped },
  get serverPublishedWsUrl() { return getOrCreateTunnel()._testing().serverPublishedWsUrl },
  set serverPublishedWsUrl(v: string | null) { getOrCreateTunnel()._testing().serverPublishedWsUrl = v },

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
