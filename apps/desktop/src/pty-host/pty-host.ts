// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PtyHost — Electron `utilityProcess` entry point.
 *
 * Runs in a sandboxed Node child spawned by main via
 * `utilityProcess.fork()`. Owns the `Map<sessionId, PtySession>` and
 * routes control messages from main; the live data channel runs
 * separately over MessagePorts.
 *
 * This file must be bundled as a STANDALONE js file at
 * `apps/desktop/dist/pty-host.js` because `utilityProcess.fork()` takes
 * a path. See `scripts/bundle-pty-host.mjs`.
 *
 * Why a separate process at all:
 *   - crash isolation: native-module faults in node-pty don't take the
 *     renderer or main with them
 *   - parity with VS Code's PtyHost — survives renderer reload
 *   - keeps main.ts's hot path free of PTY bookkeeping
 */

import { randomUUID } from 'node:crypto'
import {
  decodeClientFrame,
  encodeServerData,
  encodeServerExit,
  encodeServerTrunc,
  ClientFrameType,
} from '@shogo/pty-core'
import { PtySession, type DataSubscriber } from './pty-session'
import {
  PTY_PORT_CHANNEL,
  type ControlEvent,
  type ControlRequest,
  type ControlResponse,
} from './protocol'

/**
 * Minimal shape we use from Electron's MessagePortMain. Typed loosely so
 * we don't drag Electron's main-process types into this utility-process
 * bundle.
 */
interface HostPort {
  postMessage(msg: ArrayBuffer | Uint8Array): void
  on(event: 'message', listener: (e: { data: ArrayBuffer | Uint8Array }) => void): void
  on(event: 'close', listener: () => void): void
  start(): void
  close(): void
}

// `parentPort` is provided by Electron's utilityProcess host. Typed loosely
// because we don't want to drag Electron's main-process types into the
// utility bundle.
interface UtilityParentPort {
  postMessage(msg: unknown, transferList?: unknown[]): void
  on(event: 'message', listener: (msg: unknown) => void): void
  on(event: 'close', listener: () => void): void
  removeAllListeners(event?: string): void
}

interface UtilityProcess {
  parentPort: UtilityParentPort
}

declare const process: NodeJS.Process & UtilityProcess

const HOST_VERSION = '1.0.0'
const TEXT_DEC = new TextDecoder()

const sessions = new Map<string, PtySession>()

function send(msg: ControlResponse | ControlEvent, transfer?: unknown[]): void {
  if (transfer && transfer.length > 0) process.parentPort.postMessage(msg, transfer)
  else process.parentPort.postMessage(msg)
}

function reply(_reqId: number, ok: ControlResponse): void {
  send(ok)
}

function fail(reqId: number, code: string, message: string): void {
  send({ kind: 'err', reqId, code, message })
}

function handleSpawn(req: Extract<ControlRequest, { kind: 'spawn' }>): void {
  try {
    const id = randomUUID()
    const sess = new PtySession(id, req.opts)
    sessions.set(id, sess)

    // Watch for natural exit so we can broadcast a control event AND drop
    // the session from the map.
    const pollHandle = setInterval(() => {
      if (!sess.isExited()) return
      clearInterval(pollHandle)
      sessions.delete(id)
      send({
        kind: 'session:exit',
        id,
        code: null,
        signal: null,
        reason: 'pty:exited',
      } satisfies ControlEvent)
    }, 250)
    pollHandle.unref?.()

    reply(req.reqId, { kind: 'spawn:ok', reqId: req.reqId, session: sess.info() })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    fail(req.reqId, 'spawn:failed', message)
  }
}

function handleWrite(req: Extract<ControlRequest, { kind: 'write' }>): void {
  const sess = sessions.get(req.id)
  if (!sess) { fail(req.reqId, 'no-session', `unknown session ${req.id}`); return }
  sess.write(req.text)
  reply(req.reqId, { kind: 'ok', reqId: req.reqId })
}

function handleResize(req: Extract<ControlRequest, { kind: 'resize' }>): void {
  const sess = sessions.get(req.id)
  if (!sess) { fail(req.reqId, 'no-session', `unknown session ${req.id}`); return }
  sess.resize(req.cols, req.rows)
  reply(req.reqId, { kind: 'ok', reqId: req.reqId })
}

function handleSignal(req: Extract<ControlRequest, { kind: 'signal' }>): void {
  const sess = sessions.get(req.id)
  if (!sess) { fail(req.reqId, 'no-session', `unknown session ${req.id}`); return }
  sess.signal(req.sig)
  reply(req.reqId, { kind: 'ok', reqId: req.reqId })
}

function handleKill(req: Extract<ControlRequest, { kind: 'kill' }>): void {
  const sess = sessions.get(req.id)
  if (!sess) { fail(req.reqId, 'no-session', `unknown session ${req.id}`); return }
  sess.kill('pty:killed')
  sessions.delete(req.id)
  reply(req.reqId, { kind: 'ok', reqId: req.reqId })
}

function handleList(req: Extract<ControlRequest, { kind: 'list' }>): void {
  const list = Array.from(sessions.values()).map((s) => s.info())
  reply(req.reqId, { kind: 'list:ok', reqId: req.reqId, sessions: list })
}

/**
 * `attach` — bind a data port (when supplied) to the session's data
 * fanout. When a port is included:
 *   1. Replay scrollback strictly BEFORE subscribing live (so the
 *      replay-then-subscribe invariant holds).
 *   2. Subscribe a {channelId, port-writing} subscriber to the session.
 *   3. Decode inbound frames on the port → write/resize/signal on the
 *      session.
 *   4. On port close, unsubscribe.
 */
function handleAttach(
  req: Extract<ControlRequest, { kind: 'attach' }>,
  port: HostPort | null,
): void {
  const sess = sessions.get(req.id)
  if (!sess) { fail(req.reqId, 'no-session', `unknown session ${req.id}`); return }
  const channelId = randomUUID()

  if (port) {
    // Replay first.
    const { bytes, latestSeq, truncated } = sess.replaySince(req.sinceSeq)
    if (truncated) {
      port.postMessage(encodeServerTrunc())
    }
    if (bytes.length > 0) {
      port.postMessage(encodeServerData(latestSeq, bytes))
    }

    // Now wire live subscription + inbound frame handler.
    const subscriber: DataSubscriber = {
      channelId,
      onData(seq, b) {
        try { port.postMessage(encodeServerData(seq, b)) } catch { /* port closed */ }
      },
      onExit(code, signal, _reason) {
        try { port.postMessage(encodeServerExit(code, signal)) } catch { /* port closed */ }
        try { port.close() } catch { /* swallow */ }
      },
    }
    sess.subscribe(subscriber)

    port.on('message', (e: { data: ArrayBuffer | Uint8Array }) => {
      const buf = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : e.data
      const frame = decodeClientFrame(buf)
      if (!frame) return
      switch (frame.type) {
        case ClientFrameType.DATA:
          sess.write(TEXT_DEC.decode(frame.bytes))
          break
        case ClientFrameType.RESIZE:
          sess.resize(frame.cols, frame.rows)
          break
        case ClientFrameType.SIGNAL:
          sess.signal(frame.signal)
          break
        case ClientFrameType.ACK:
          // No-op for now; ACK is reserved for future flow control.
          break
      }
    })
    port.on('close', () => { sess.unsubscribe(channelId) })
    port.start()
  }

  reply(req.reqId, {
    kind: 'attach:ok',
    reqId: req.reqId,
    id: req.id,
    channelId,
    latestSeq: sess.latestSeq(),
  })
}

function handleDetach(req: Extract<ControlRequest, { kind: 'detach' }>): void {
  const sess = sessions.get(req.id)
  if (sess) sess.unsubscribe(req.channelId)
  reply(req.reqId, { kind: 'ok', reqId: req.reqId })
}

function dispatch(msg: unknown, port: HostPort | null = null): void {
  if (!msg || typeof msg !== 'object') return
  const m = msg as ControlRequest
  switch (m.kind) {
    case 'spawn':  handleSpawn(m); break
    case 'write':  handleWrite(m); break
    case 'resize': handleResize(m); break
    case 'signal': handleSignal(m); break
    case 'kill':   handleKill(m); break
    case 'list':   handleList(m); break
    case 'attach': handleAttach(m, port); break
    case 'detach': handleDetach(m); break
    default: {
      send({
        kind: 'host:log',
        level: 'warn',
        message: `unknown control msg: ${JSON.stringify(msg).slice(0, 120)}`,
      } satisfies ControlEvent)
    }
  }
}

// ─── boot ────────────────────────────────────────────────────────────────

const isUtilityProcess = typeof (process as Partial<UtilityProcess>).parentPort !== 'undefined'

if (isUtilityProcess) {
  process.parentPort.on('message', (m: unknown) => {
    // `utilityProcess` wraps user payloads under `{ data: <payload> }`.
    // Transferred MessagePortMain instances arrive on `.ports` alongside.
    const wrapper = m as { data?: unknown; ports?: HostPort[] }
    const inner = wrapper?.data
    const port = wrapper?.ports && wrapper.ports.length > 0 ? wrapper.ports[0] : null
    dispatch(inner !== undefined ? inner : m, port)
  })
  process.parentPort.on('close', () => {
    for (const s of sessions.values()) s.kill('pty:shutdown')
    sessions.clear()
  })
  send({ kind: 'host:ready', version: HOST_VERSION } satisfies ControlEvent)
}

export { PTY_PORT_CHANNEL }
