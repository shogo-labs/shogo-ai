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
 * Data plane (live PTY output) does NOT go through this class. The port
 * broker (`terminal-port-broker.ts`) allocates a `MessageChannelMain`,
 * hands one port to the renderer (via `webContents.postMessage(channel,
 * msg, [port])`) and the other to the host (via `child.postMessage(msg,
 * [port])`).
 */

import { EventEmitter } from 'node:events'
import path from 'node:path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import type {
  ControlEvent,
  ControlRequest,
  ControlResponse,
  SessionInfo,
  SpawnOptions,
} from './pty-host/protocol'

const HOST_RESTART_BASE_MS = 500
const HOST_RESTART_MAX_MS = 10_000

export interface PtyHostClientEvents {
  /** Host's control-event stream — exit, log, ready. */
  event: (ev: ControlEvent) => void
  /** Host crashed; this client is reconnecting. */
  'host:crash': (info: { code: number | null; restartInMs: number }) => void
  /** Host (re)booted cleanly. */
  'host:ready': (version: string) => void
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
    const child = utilityProcess.fork(entry, [], {
      env: { ...process.env as Record<string, string> },
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
        const ev = m as ControlEvent
        if (ev.kind === 'host:ready') {
          this.restartAttempt = 0
          this.emit('host:ready', ev.version)
          if (!resolved) { resolved = true; resolve() }
        }
        this.emit('event', ev)
      }

      child.on('message', onMessage)

      child.on('exit', (code) => {
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
    if (this.child) {
      try { this.child.kill() } catch { /* may already be dead */ }
      this.child = null
    }
    for (const [, slot] of this.pending) slot.reject(new Error('pty-host disposed'))
    this.pending.clear()
    this.removeAllListeners()
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
   * Attach with data-plane port handoff. Allocates a `MessageChannelMain`
   * on the caller's behalf (the broker does the allocation and supplies
   * `hostPort`). The host receives the port via the same control message
   * used by `attach`, binds a subscriber to the session's data fanout,
   * ships any pending replay (sinceSeq → latestSeq) through the port,
   * and starts streaming live DATA / EXIT / TRUNC frames.
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
