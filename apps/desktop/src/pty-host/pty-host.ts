// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PtyHost — Electron `utilityProcess` entry point.
 *
 * Runs in a sandboxed Node child spawned by main via
 * `utilityProcess.fork()`. Owns the `Map<sessionId, PtySession>` and
 * routes control messages from main; the live data channel runs
 * separately over MessagePorts (see Phase 2).
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
import fs from 'node:fs/promises'
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
import { applyShellIntegration, type ShellIntegrationPlan } from './shell-integration'
import { SnapshotStore, type FsAdapter, type SessionSnapshot } from './persistence'

/**
 * Minimal shape we use from Electron's MessagePortMain. Typed loosely so
 * we don't drag Electron's main-process types into this utility-process
 * bundle.
 */
interface HostPort {
  postMessage(msg: ArrayBuffer | Uint8Array, transfer?: unknown[]): void
  on(event: 'message', listener: (e: { data: ArrayBuffer | Uint8Array }) => void): void
  on(event: 'close', listener: () => void): void
  start(): void
  close(): void
}

/**
 * Electron's `MessagePortMain` → renderer `MessagePort` boundary does NOT
 * reliably structured-clone typed-array views. A `Uint8Array` posted from
 * the utility process arrives in the renderer as `MessageEvent { data:
 * undefined }`. The fix: always send an ArrayBuffer (the underlying
 * storage), and include it in the transfer list so it's a zero-copy move
 * rather than a clone.
 *
 * Mirrors what the renderer preload's `wrapPort.postMessage` does for the
 * inbound direction. See:
 *   apps/desktop/src/preload-terminal.ts: wrapPort.postMessage
 */
function postFrame(port: HostPort, frame: Uint8Array): void {
  const ab = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer
  port.postMessage(ab, [ab])
}

const channelAcks = new Map<string, number>()

// `parentPort` is provided by Electron's utilityProcess host. Typed loosely
// because we don't want to drag Electron's main-process types into the
// utility bundle.
//
// utilityProcess's host adds these to `process` itself, not to a module
// export — see the Electron docs. We grab a typed reference once.
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

const HOST_VERSION = '0.0.1-phase1'
const TEXT_DEC = new TextDecoder()

const sessions = new Map<string, PtySession>()
/**
 * Per-session shell-integration cleanup callbacks. Keyed by session id.
 * Populated when applyShellIntegration() materialised temp files; called
 * when the session exits (natural or kill). Idempotent inside the
 * shell-integration plan, so a duplicate fire is safe.
 */
const integrationCleanups = new Map<string, () => void>()

const snapshotDir = process.env.SHOGO_TERMINAL_SNAPSHOT_DIR
const snapshotStore = snapshotDir
  ? new SnapshotStore({
      dir: snapshotDir,
      fs: {
        writeFile: fs.writeFile,
        readFile: fs.readFile as unknown as FsAdapter['readFile'],
        readdir: fs.readdir as unknown as FsAdapter['readdir'],
        mkdir: fs.mkdir as unknown as FsAdapter['mkdir'],
        rename: fs.rename,
        unlink: fs.unlink,
        async exists(p: string) {
          try { await fs.access(p); return true } catch { return false }
        },
      },
    })
  : null

function send(msg: ControlResponse | ControlEvent, transfer?: unknown[]): void {
  if (transfer && transfer.length > 0) process.parentPort.postMessage(msg, transfer)
  else process.parentPort.postMessage(msg)
}

function reply(reqId: number, ok: ControlResponse): void {
  send(ok)
}

function fail(reqId: number, code: string, message: string): void {
  send({ kind: 'err', reqId, code, message })
}

function handleSpawn(req: Extract<ControlRequest, { kind: 'spawn' }>): void {
  try {
    const id = randomUUID()
    // Inject shell-integration BEFORE spawning. Plan transforms args+env
    // (e.g. --rcfile, ZDOTDIR) and gives us a cleanup() for temp files.
    // Failures here are non-fatal — we fall back to a passthrough plan
    // so the user still gets a working terminal even if integration
    // file writes failed (out-of-disk, sandboxed tmpdir, etc.).
    let plan: ShellIntegrationPlan
    try {
      plan = applyShellIntegration(req.opts)
    } catch {
      plan = {
        kind: 'unknown',
        status: 'unsupported-shell',
        spawn: req.opts,
        artifacts: [],
        cleanup: () => undefined,
      }
    }
    if (plan.artifacts.length > 0) integrationCleanups.set(id, plan.cleanup)

    const sess = new PtySession(id, plan.spawn)
    sessions.set(id, sess)
    scheduleSnapshot(id)

    // Watch for natural exit so we can broadcast a control event AND drop
    // the session from the map. node-pty's onExit already fanned out the
    // exit to attached subscribers — this is the lifecycle signal to main.
    const watchExit = () => {
      if (!sess.isExited()) return
      sessions.delete(id)
      runIntegrationCleanup(id)
      const info = sess.info()
      send({
        kind: 'session:exit',
        id,
        code: null, // PtySession swallows the value internally; future work
        signal: null,
        reason: 'pty:exited',
      } satisfies ControlEvent)
    }
    // Poll briefly — node-pty's onExit is async relative to spawn(). Cheaper
    // than wiring another event in the session class for a Phase 1 host.
    const pollHandle = setInterval(() => {
      if (sess.isExited()) {
        clearInterval(pollHandle)
        watchExit()
      }
    }, 250)
    pollHandle.unref?.()

    reply(req.reqId, { kind: 'spawn:ok', reqId: req.reqId, session: sess.info() })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    fail(req.reqId, 'spawn:failed', message)
  }
}

function snapshotOf(id: string): Omit<SessionSnapshot, 'version' | 'writtenAt'> | null {
  const sess = sessions.get(id)
  if (!sess || !snapshotStore) return null
  const info = sess.info()
  const replay = sess.replaySince(0)
  const headless = sess.serializeHeadless()
  return {
    id,
    workspaceHash: sess.opts.workspaceHash ?? 'default',
    cwd: info.cwd,
    shell: info.shell,
    profileId: sess.opts.profileId,
    lastSeq: replay.latestSeq,
    ring: headless ?? TEXT_DEC.decode(replay.bytes),
  }
}

function scheduleSnapshot(id: string): void {
  if (!snapshotStore) return
  const snap = snapshotOf(id)
  if (snap) snapshotStore.update(snap)
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
  runIntegrationCleanup(req.id)
  reply(req.reqId, { kind: 'ok', reqId: req.reqId })
}

function runIntegrationCleanup(id: string): void {
  const cb = integrationCleanups.get(id)
  if (!cb) return
  integrationCleanups.delete(id)
  try { cb() } catch { /* best-effort */ }
}

function handleList(req: Extract<ControlRequest, { kind: 'list' }>): void {
  const list = Array.from(sessions.values()).map((s) => s.info())
  reply(req.reqId, { kind: 'list:ok', reqId: req.reqId, sessions: list })
}

/**
 * `attach` — bind a data port (when supplied) to the session's data
 * fanout. When a port is included:
 *   1. Replay scrollback strictly BEFORE subscribing live (so the
 *      replay-then-subscribe invariant holds — same as agent-runtime).
 *   2. Subscribe a {channelId, port-writing} subscriber to the session.
 *   3. Decode inbound frames on the port → write/resize/signal/kill on
 *      the session.
 *   4. On port close, unsubscribe.
 *
 * When no port is supplied (Phase 1 test path), only reserve a logical
 * channelId and return latestSeq. Useful for unit tests that don't
 * care about the data plane.
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
      postFrame(port, encodeServerTrunc())
    }
    if (bytes.length > 0) {
      // Replay arrives as one DATA frame keyed at latestSeq.
      postFrame(port, encodeServerData(latestSeq, bytes))
    }

    // Now wire live subscription + inbound frame handler.
    const subscriber: DataSubscriber = {
      channelId,
      onData(seq, b) {
        try { postFrame(port, encodeServerData(seq, b)) } catch { /* port closed */ }
        scheduleSnapshot(req.id)
      },
      onExit(code, signal, _reason) {
        scheduleSnapshot(req.id)
        try { postFrame(port, encodeServerExit(code, signal)) } catch { /* port closed */ }
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
          sess.write(new TextDecoder().decode(frame.bytes))
          break
        case ClientFrameType.RESIZE:
          sess.resize(frame.cols, frame.rows)
          break
        case ClientFrameType.SIGNAL:
          sess.signal(frame.signal)
          break
        case ClientFrameType.ACK:
          channelAcks.set(channelId, frame.seq)
          break
      }
    })
    port.on('close', () => { sess.unsubscribe(channelId); channelAcks.delete(channelId) })
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

async function handleListSnapshots(req: Extract<ControlRequest, { kind: 'snapshots:list' }>): Promise<void> {
  if (!snapshotStore) { reply(req.reqId, { kind: 'snapshots:list:ok', reqId: req.reqId, snapshots: [] }); return }
  const snapshots = await snapshotStore.list(req.workspaceHash)
  reply(req.reqId, {
    kind: 'snapshots:list:ok',
    reqId: req.reqId,
    snapshots: snapshots.map((s) => ({
      id: s.id,
      workspaceHash: s.workspaceHash,
      cwd: s.cwd,
      shell: s.shell,
      profileId: s.profileId,
      writtenAt: s.writtenAt,
      ringBytes: new TextEncoder().encode(s.ring).byteLength,
    })),
  })
}

async function handleRestoreSnapshot(req: Extract<ControlRequest, { kind: 'snapshots:restore' }>): Promise<void> {
  if (!snapshotStore) { fail(req.reqId, 'snapshot:disabled', 'snapshot store disabled'); return }
  const snap = await snapshotStore.load(req.workspaceHash, req.id)
  if (!snap) { fail(req.reqId, 'snapshot:not-found', `snapshot ${req.id} not found`); return }
  const id = randomUUID()
  const opts = {
    shell: snap.shell,
    args: process.platform === 'win32' ? [] : ['-l'],
    cwd: snap.cwd,
    env: process.env as Record<string, string>,
    cols: 80,
    rows: 24,
    restoreId: snap.id,
    workspaceHash: snap.workspaceHash,
    profileId: snap.profileId,
  }
  const plan = applyShellIntegration(opts)
  const sess = new PtySession(id, plan.spawn)
  if (plan.artifacts.length > 0) integrationCleanups.set(id, plan.cleanup)
  sess.seedReplay(new TextEncoder().encode(snap.ring), snap.lastSeq)
  sessions.set(id, sess)
  scheduleSnapshot(id)
  reply(req.reqId, { kind: 'snapshots:restore:ok', reqId: req.reqId, session: sess.info() })
}

async function handleDiscardSnapshot(req: Extract<ControlRequest, { kind: 'snapshots:discard' }>): Promise<void> {
  if (snapshotStore) await snapshotStore.delete(req.workspaceHash, req.id)
  reply(req.reqId, { kind: 'ok', reqId: req.reqId })
}

async function handleFlushSnapshots(req: Extract<ControlRequest, { kind: 'snapshots:flush' }>): Promise<void> {
  if (snapshotStore) {
    for (const id of sessions.keys()) scheduleSnapshot(id)
    await snapshotStore.flushAll()
  }
  reply(req.reqId, { kind: 'ok', reqId: req.reqId })
}

function dispatch(msg: unknown, port: HostPort | null = null): void {
  if (!msg || typeof msg !== 'object') return
  const m = msg as ControlRequest
  switch (m.kind) {
    case 'spawn':  handleSpawn(m);  break
    case 'write':  handleWrite(m);  break
    case 'resize': handleResize(m); break
    case 'signal': handleSignal(m); break
    case 'kill':   handleKill(m);   break
    case 'list':   handleList(m);   break
    case 'attach': handleAttach(m, port); break
    case 'detach': handleDetach(m); break
    case 'snapshots:list': void handleListSnapshots(m); break
    case 'snapshots:restore': void handleRestoreSnapshot(m); break
    case 'snapshots:discard': void handleDiscardSnapshot(m); break
    case 'snapshots:flush': void handleFlushSnapshots(m); break
    default: {
      // Unknown kind — log via control event so main can surface it.
      send({
        kind: 'host:log',
        level: 'warn',
        message: `unknown control msg: ${JSON.stringify(msg).slice(0, 120)}`,
      } satisfies ControlEvent)
    }
  }
}

/**
 * Exported for unit testing. Production uses the bottom of this file
 * which wires `process.parentPort`. Tests may pass a port to exercise
 * the data-plane binding path.
 */
export function _dispatchForTest(msg: unknown, port: HostPort | null = null): void {
  dispatch(msg, port)
}
export function _sessionsForTest(): Map<string, PtySession> { return sessions }

// ─── boot ────────────────────────────────────────────────────────────────

// Only attach to parentPort when running as a utilityProcess (skipped when
// the module is imported by a unit test).
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
    void handleFlushSnapshots({ kind: 'snapshots:flush', reqId: 0 })
    for (const s of sessions.values()) s.kill('pty:shutdown')
    sessions.clear()
  })
  send({ kind: 'host:ready', version: HOST_VERSION } satisfies ControlEvent)
  const beat = setInterval(() => {
    send({ kind: 'host:beat', t: Date.now() } satisfies ControlEvent)
  }, 2_000)
  beat.unref?.()
}

// Re-export the channel name for main's port broker.
export { PTY_PORT_CHANNEL }
