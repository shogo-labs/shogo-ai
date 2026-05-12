// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Bun-WebSocket handlers for PTY sessions. The actual upgrade lives in
 * server.ts (because Bun.serve owns the upgrade decision); we expose
 * pure handler functions here so they're trivially unit-testable
 * without spinning a real socket.
 *
 * Per-WebSocket state lives in `ws.data: WsData` — that's where Bun
 * stashes the upgrade-time payload from `server.upgrade(req, { data })`.
 */

import {
  ClientFrameType,
  decodeClientFrame,
  encodeServerData,
  encodeServerExit,
  encodeServerTrunc,
} from './pty-protocol'
import type { PtySessionManager, ReapReason } from './pty-session-manager'

/** Minimal WS surface so tests can fake it without pulling in Bun types. */
export interface MinimalWs<TData = WsData> {
  data: TData
  send(payload: Uint8Array): number | void
  close(code?: number, reason?: string): void
}

export interface WsData {
  /** Which PtySessionManager owns this session. The fetch handler decides
   * (e.g. by projectId) and stamps it into the upgrade-time `data`. */
  manager: PtySessionManager
  sessionId: string
  /** Resume from this seq on attach (0 = full scrollback). */
  since: number
  /** Set true when we've already detached so close() doesn't double-detach. */
  detached?: boolean
  /** Per-connection cleanup; set in open(), called from close(). */
  cleanup?: () => void
}

export interface PtyWsHandlers {
  open(ws: MinimalWs): void
  message(ws: MinimalWs, msg: ArrayBufferView | ArrayBuffer | string): void
  close(ws: MinimalWs, code?: number, reason?: string): void
  /** Tear down manager subscriptions; call on server shutdown. */
  dispose(): void
}

/**
 * Create the handler triplet. Each WS carries its own PtySessionManager
 * reference (set at upgrade time), so a single handler set can serve
 * many managers — e.g. the local-dev API process serves one manager per
 * project, while a runtime pod uses just one. We track manager →
 * Set<ws> so a server-side reap closes every attached WS, and we
 * subscribe to onReap lazily the first time we see a manager.
 */
export function createPtyWsHandlers(): PtyWsHandlers {
  // manager → sessionId → set of attached WSes
  const wsByManager = new Map<PtySessionManager, Map<string, Set<MinimalWs>>>()
  // managers we've already wired to onReap (so we don't subscribe twice)
  const reapUnsubs = new Map<PtySessionManager, () => void>()

  function ensureReapSub(manager: PtySessionManager): void {
    if (reapUnsubs.has(manager)) return
    const unsub = manager.onReap((sessionId, reason) => {
      const inner = wsByManager.get(manager)
      const set = inner?.get(sessionId)
      if (!set) return
      const code = reason === 'shutdown' ? 1001 : 1000
      const wsList = [...set]
      inner!.delete(sessionId)
      for (const ws of wsList) {
        // Mark detached so close() doesn't try to detach a session the
        // manager already disposed of.
        ws.data.detached = true
      }
      // Defer the actual ws.close: the same exit-listener cascade that
      // triggers this reap also calls ws.send(EXIT) through the per-WS
      // exit hook installed in open(). Bun queues sends, but if we close
      // on the same synchronous tick the send is dropped on the floor.
      // Letting the microtask drain first lets the EXIT frame actually
      // reach the client.
      queueMicrotask(() => {
        for (const ws of wsList) {
          try { ws.close(code, `pty:${reason}`) } catch {}
        }
      })
    })
    reapUnsubs.set(manager, unsub)
  }

  function track(manager: PtySessionManager, sessionId: string, ws: MinimalWs): void {
    let inner = wsByManager.get(manager)
    if (!inner) { inner = new Map(); wsByManager.set(manager, inner) }
    let set = inner.get(sessionId)
    if (!set) { set = new Set(); inner.set(sessionId, set) }
    set.add(ws)
  }

  function untrack(manager: PtySessionManager, sessionId: string, ws: MinimalWs): void {
    const inner = wsByManager.get(manager)
    if (!inner) return
    const set = inner.get(sessionId)
    if (!set) return
    set.delete(ws)
    if (set.size === 0) inner.delete(sessionId)
  }

  function open(ws: MinimalWs): void {
    const { manager, sessionId, since } = ws.data
    ensureReapSub(manager)
    const session = manager.attach(sessionId)
    if (!session) {
      // The session disappeared (reaped, killed, or never existed) between
      // upgrade and open. Tell the client and bail.
      try { ws.send(encodeServerExit(null, 'no-session')) } catch {}
      try { ws.close(4404, 'no-session') } catch {}
      ws.data.detached = true
      return
    }
    track(manager, sessionId, ws)

    // Replay scrollback first, then subscribe to live data. The order matters:
    // if we subscribed first, the live callback could fire between the
    // replaySince() snapshot and the subscribe registration, dropping bytes.
    // Doing replay → subscribe in this order is safe because PtySession
    // serializes replay against incoming data within the same task.
    const replay = session.replaySince(since)
    if (replay.truncated) {
      try { ws.send(encodeServerTrunc()) } catch {}
    }
    if (replay.bytes.byteLength > 0) {
      try { ws.send(encodeServerData(replay.latestSeq, replay.bytes)) } catch {}
    }

    const unsubData = session.onData(({ seq, bytes }) => {
      try { ws.send(encodeServerData(seq, bytes)) } catch {}
    })
    const unsubExit = session.onExit((info) => {
      try { ws.send(encodeServerExit(info.code, info.signal)) } catch {}
      // Don't close here — leave that to the reap → onReap → close path so
      // the close reason is consistent ("pty:exited").
    })
    ws.data.cleanup = () => { unsubData(); unsubExit() }
  }

  function message(ws: MinimalWs, msg: ArrayBufferView | ArrayBuffer | string): void {
    if (typeof msg === 'string') {
      // Protocol is binary-only; ignore stray text frames.
      return
    }
    const buf = msg instanceof ArrayBuffer
      ? new Uint8Array(msg)
      : new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength)
    const frame = decodeClientFrame(buf)
    if (!frame) return
    const session = ws.data.manager.get(ws.data.sessionId)
    if (!session) return
    switch (frame.type) {
      case ClientFrameType.DATA:
        if (frame.bytes.byteLength > 0) session.write(frame.bytes)
        break
      case ClientFrameType.RESIZE:
        // Clamp here so a malicious client can't allocate a giant terminal
        // buffer in the kernel. PtySession also clamps internally.
        session.resize(
          Math.min(Math.max(frame.cols, 1), 1000),
          Math.min(Math.max(frame.rows, 1), 1000),
        )
        break
      case ClientFrameType.SIGNAL:
        session.signal(frame.signal)
        break
    }
  }

  function close(ws: MinimalWs): void {
    try { ws.data.cleanup?.() } catch {}
    if (ws.data.detached) return
    ws.data.detached = true
    untrack(ws.data.manager, ws.data.sessionId, ws)
    ws.data.manager.detach(ws.data.sessionId)
  }

  function dispose(): void {
    for (const unsub of reapUnsubs.values()) {
      try { unsub() } catch {}
    }
    reapUnsubs.clear()
    wsByManager.clear()
  }

  return { open, message, close, dispose }
}

/** Re-exported for callers that want the typed reap reason. */
export type { ReapReason }
