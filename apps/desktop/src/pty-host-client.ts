// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PtyHostClient — main-process facade in front of the PtyHost
 * utilityProcess.
 *
 *   main.ts ─▶ PtyHostClient ─▶ utilityProcess ─▶ node-pty
 *
 * Responsibilities:
 *   - Fork the host bundle (`dist/pty-host.js`) on first use; lazy.
 *   - Match requests/responses by `reqId` and resolve Promises.
 *   - Republish lifecycle events as an EventEmitter so IPC handlers and
 *     the port broker can subscribe.
 *   - Auto-restart on host crash with exponential backoff.
 *
 * Data plane (live PTY output) does NOT go through this class. Phase 2's
 * `terminal-port-broker.ts` allocates a `MessageChannelMain`, hands one
 * port to the renderer (via `webContents.postMessage(channel, msg, [port])`)
 * and the other to the host (via `child.postMessage(msg, [port])`).
 */

import { EventEmitter } from 'node:events'
import path from 'node:path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import type {
  ControlEvent,
  ControlRequest,
  ControlResponse,
  SessionInfo,
  SnapshotSummary,
  SpawnOptions,
} from './pty-host/protocol'

const HOST_RESTART_BASE_MS = 500
const HOST_RESTART_MAX_MS = 10_000

export interface PtyHostClientEvents {
  /** Host's control-event stream — exit, reap, log, ready. */
  event: (ev: ControlEvent) => void
  /** Host crashed; this client is reconnecting. */
  'host:crash': (info: { code: number | null; restartInMs: number }) => void
  /** Host (re)booted cleanly. */
  'host:ready': (version: string) => void
  /** Heartbeat watchdog says pty-host is not responding. */
  'host:unresponsive': (info: { lastBeatAt: number }) => void
}

type PendingResolver = {
  resolve: (resp: ControlResponse) => void
  reject: (err: Error) => void
}

export class PtyHostClient extends EventEmitter {
  private child: UtilityProcess | null = null
  private nextReqId = 1
  private pending = new Map<number, PendingResolver>()
  private restartAttempt = 0
  private disposed = false
  private bootingPromise: Promise<void> | null = null
  private lastBeatAt = Date.now()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  override on<K extends keyof PtyHostClientEvents>(event: K, listener: PtyHostClientEvents[K]): this
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener)
  }

  // ─── lifecycle ────────────────────────────────────────────────────────

  async ensureReady(): Promise<void> {
    if (this.child) return
    if (this.bootingPromise) return this.bootingPromise
    this.bootingPromise = this.boot().finally(() => { this.bootingPromise = null })
    return this.bootingPromise
  }

  private async boot(): Promise<void> {
    const entry = path.join(app.getAppPath(), 'dist', 'pty-host.js')
    const snapshotDir = path.join(app.getPath('userData'), 'terminal-snapshots')
    const child = utilityProcess.fork(entry, [], {
      // Inherit env minus anything sensitive the host has no business reading.
      env: {
        ...process.env as Record<string, string>,
        SHOGO_TERMINAL_SNAPSHOT_DIR: snapshotDir,
      },
      serviceName: 'shogo-pty-host',
      stdio: 'inherit',
    })
    this.child = child

    return new Promise<void>((resolve, reject) => {
      let resolved = false

      const onMessage = (msg: unknown) => {
        if (!msg || typeof msg !== 'object') return
        const m = msg as ControlResponse | ControlEvent
        if ('reqId' in m && typeof m.reqId === 'number') {
          const slot = this.pending.get(m.reqId)
          if (!slot) return
          this.pending.delete(m.reqId)
          if (m.kind === 'err') slot.reject(new Error(`${m.code}: ${m.message}`))
          else slot.resolve(m)
          return
        }
        // Control event (no reqId).
        const ev = m as ControlEvent
        if (ev.kind === 'host:ready') {
          this.restartAttempt = 0
          this.lastBeatAt = Date.now()
          this.emit('host:ready', ev.version)
          if (!resolved) { resolved = true; resolve() }
        }
        if (ev.kind === 'host:beat') this.lastBeatAt = ev.t
        this.emit('event', ev)
      }

      child.on('message', onMessage)
      this.startHeartbeatWatchdog()

      child.on('exit', (code) => {
        // Reject pending requests so callers get an error rather than hanging.
        for (const [, slot] of this.pending) slot.reject(new Error('pty-host exited'))
        this.pending.clear()
        this.child = null
        if (this.disposed) return
        this.restartAttempt += 1
        const backoff = Math.min(
          HOST_RESTART_MAX_MS,
          HOST_RESTART_BASE_MS * 2 ** (this.restartAttempt - 1),
        )
        this.emit('host:crash', { code, restartInMs: backoff })
        setTimeout(() => {
          if (this.disposed) return
          this.ensureReady().catch((err) => {
            this.emit('event', {
              kind: 'host:log',
              level: 'error',
              message: `pty-host restart failed: ${err instanceof Error ? err.message : String(err)}`,
            } satisfies ControlEvent)
          })
        }, backoff)
        if (!resolved) { resolved = true; reject(new Error(`pty-host exited before host:ready (code=${code})`)) }
      })
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    if (this.child) {
      try { this.child.kill() } catch { /* may already be dead */ }
      this.child = null
    }
    for (const [, slot] of this.pending) slot.reject(new Error('pty-host disposed'))
    this.pending.clear()
    this.removeAllListeners()
  }

  async restart(): Promise<void> {
    if (this.child) {
      try { this.child.kill() } catch {}
      this.child = null
    }
    await this.ensureReady()
  }

  private startHeartbeatWatchdog(): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      if (this.disposed || !this.child) return
      const age = Date.now() - this.lastBeatAt
      if (age <= 6_000) return
      const ev: ControlEvent = { kind: 'host:unresponsive', lastBeatAt: this.lastBeatAt }
      this.emit('host:unresponsive', { lastBeatAt: this.lastBeatAt })
      this.emit('event', ev)
    }, 2_000)
  }

  // ─── control plane ────────────────────────────────────────────────────

  /**
   * Internal — send a request, return the typed response Promise. Boots
   * the host if not running. Optionally transfers a MessagePort to the
   * host (used by attachWithPort).
   */
  private async request<R extends ControlResponse>(
    build: (reqId: number) => ControlRequest,
    transfer?: unknown[],
  ): Promise<R> {
    await this.ensureReady()
    const child = this.child
    if (!child) throw new Error('pty-host not running')
    const reqId = this.nextReqId++
    const req = build(reqId)
    return new Promise<R>((resolve, reject) => {
      this.pending.set(reqId, {
        resolve: (resp) => resolve(resp as R),
        reject,
      })
      if (transfer && transfer.length > 0) {
        // Electron's UtilityProcess.postMessage accepts a transfer array
        // of MessagePortMain instances. Cast through unknown because
        // TypeScript's union for postMessage transfer is narrower than
        // what Electron actually accepts at runtime.
        ;(child.postMessage as (m: unknown, t?: unknown[]) => void)(req, transfer)
      } else {
        child.postMessage(req)
      }
    })
  }

  async spawn(opts: SpawnOptions): Promise<SessionInfo> {
    const r = await this.request<{ kind: 'spawn:ok'; reqId: number; session: SessionInfo }>(
      (reqId) => ({ kind: 'spawn', reqId, opts }),
    )
    return r.session
  }

  async write(id: string, text: string): Promise<void> {
    await this.request((reqId) => ({ kind: 'write', reqId, id, text }))
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    await this.request((reqId) => ({ kind: 'resize', reqId, id, cols, rows }))
  }

  async signal(id: string, sig: 'INT' | 'TERM' | 'KILL'): Promise<void> {
    await this.request((reqId) => ({ kind: 'signal', reqId, id, sig }))
  }

  async kill(id: string): Promise<void> {
    await this.request((reqId) => ({ kind: 'kill', reqId, id }))
  }

  async list(): Promise<SessionInfo[]> {
    const r = await this.request<{ kind: 'list:ok'; reqId: number; sessions: SessionInfo[] }>(
      (reqId) => ({ kind: 'list', reqId }),
    )
    return r.sessions
  }

  /**
   * Legacy / no-port attach — reserves a channelId without binding a
   * MessagePort. Kept for the Phase 1 test surface.
   */
  async attach(id: string, sinceSeq: number): Promise<{ channelId: string; latestSeq: number }> {
    const r = await this.request<{
      kind: 'attach:ok'
      reqId: number
      id: string
      channelId: string
      latestSeq: number
    }>((reqId) => ({ kind: 'attach', reqId, id, sinceSeq }))
    return { channelId: r.channelId, latestSeq: r.latestSeq }
  }

  /**
   * Phase 2 attach with data-plane port handoff.
   *
   * Allocates a `MessageChannelMain` on the caller's behalf (the broker
   * does the actual allocation and supplies `hostPort`). The host receives
   * the port via the same control message used by `attach`, binds a
   * subscriber to the session's data fanout, ships any pending replay
   * (sinceSeq → latestSeq) through the port, and starts streaming live
   * DATA / EXIT / TRUNC frames.
   *
   * The corresponding renderer-side port is delivered separately by the
   * broker via `webContents.postMessage(PTY_PORT_CHANNEL, ...)`.
   */
  async attachWithPort(
    id: string,
    sinceSeq: number,
    hostPort: unknown,
  ): Promise<{ channelId: string; latestSeq: number }> {
    const r = await this.request<{
      kind: 'attach:ok'
      reqId: number
      id: string
      channelId: string
      latestSeq: number
    }>(
      (reqId) => ({ kind: 'attach', reqId, id, sinceSeq }),
      [hostPort],
    )
    return { channelId: r.channelId, latestSeq: r.latestSeq }
  }

  async detach(id: string, channelId: string): Promise<void> {
    await this.request((reqId) => ({ kind: 'detach', reqId, id, channelId }))
  }

  async listSnapshots(workspaceHash: string): Promise<SnapshotSummary[]> {
    const r = await this.request<{ kind: 'snapshots:list:ok'; reqId: number; snapshots: SnapshotSummary[] }>(
      (reqId) => ({ kind: 'snapshots:list', reqId, workspaceHash }),
    )
    return r.snapshots
  }

  async restoreSession(workspaceHash: string, id: string): Promise<SessionInfo> {
    const r = await this.request<{ kind: 'snapshots:restore:ok'; reqId: number; session: SessionInfo }>(
      (reqId) => ({ kind: 'snapshots:restore', reqId, workspaceHash, id }),
    )
    return r.session
  }

  async discardSnapshot(workspaceHash: string, id: string): Promise<void> {
    await this.request((reqId) => ({ kind: 'snapshots:discard', reqId, workspaceHash, id }))
  }

  async flushSnapshots(): Promise<void> {
    await this.request((reqId) => ({ kind: 'snapshots:flush', reqId }))
  }
}

/**
 * Module-scoped singleton. Most callers should use this rather than
 * instantiating their own — there is only one PtyHost per Electron
 * process.
 */
let _singleton: PtyHostClient | null = null
export function getPtyHostClient(): PtyHostClient {
  if (!_singleton) _singleton = new PtyHostClient()
  return _singleton
}

export async function disposePtyHostClient(): Promise<void> {
  if (_singleton) {
    await _singleton.dispose()
    _singleton = null
  }
}
