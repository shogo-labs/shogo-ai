// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Preload-side wiring for the Desktop terminal.
 *
 * Exposes `window.shogoDesktopTerminal` to the renderer. The renderer's
 * `@shogo/desktop-terminal` package consumes this bridge through the
 * `ShogoDesktopTerminalBridge` interface defined in pty-core's
 * desktop-protocol.
 *
 * The data plane is a transferred MessagePort that arrives via
 * `ipcRenderer.on(PTY_PORT_CHANNEL)`. We wrap the raw MessagePort in
 * a small adapter that matches `MessagePortLike` so the renderer never
 * touches a real DOM MessagePort directly (kept simple + testable).
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ControlEvent,
  SessionInfo,
  SpawnOptions,
  SnapshotSummary,
} from '@shogo/pty-core'

const CH = {
  spawn:  'shogo:terminal:spawn',
  write:  'shogo:terminal:write',
  resize: 'shogo:terminal:resize',
  signal: 'shogo:terminal:signal',
  kill:   'shogo:terminal:kill',
  list:   'shogo:terminal:list',
  attach: 'shogo:terminal:attach',
  detach: 'shogo:terminal:detach',
  listSnapshots: 'shogo:terminal:snapshots:list',
  restoreSession: 'shogo:terminal:snapshots:restore',
  discardSnapshot: 'shogo:terminal:snapshots:discard',
  restartHost: 'shogo:terminal:host:restart',
  event:  'shogo:terminal:event',
  llmStreamCommand: 'shogo:llm:stream-command',
  llmOpenChatWithContext: 'shogo:llm:open-chat-with-context',
  llmDelta: 'shogo:llm:stream-command:delta',
  llmDone: 'shogo:llm:stream-command:done',
  llmError: 'shogo:llm:stream-command:error',
  // Port-handoff channel — must match PTY_PORT_CHANNEL in pty-host/protocol.ts.
  port:   'shogo:pty:port',
} as const

// Pending attach() calls keyed by sessionId — the port arrives over a
// separate `ipcRenderer.on(CH.port)` listener and resolves the Promise.
const pendingAttach = new Map<string, (port: MessagePort, meta: { channelId: string; latestSeq: number }) => void>()

ipcRenderer.on(CH.port, (event: IpcRendererEvent, payload: { sessionId: string; channelId: string; latestSeq: number }) => {
  const port = event.ports[0]
  const resolver = pendingAttach.get(payload.sessionId)
  if (resolver) {
    pendingAttach.delete(payload.sessionId)
    resolver(port, { channelId: payload.channelId, latestSeq: payload.latestSeq })
  } else {
    // Race: an attach was disposed before its port arrived. Close it so
    // the host's subscriber unbinds cleanly.
    try { port.close() } catch { /* swallow */ }
  }
})

// Event multicast: every onEvent subscriber gets every event.
const eventListeners = new Set<(ev: ControlEvent) => void>()
ipcRenderer.on(CH.event, (_e, ev: ControlEvent) => {
  for (const cb of [...eventListeners]) {
    try { cb(ev) } catch { /* swallow */ }
  }
})

const llmStreams = new Map<string, {
  onDelta(text: string): void
  onDone(text: string): void
  onError(error: Error): void
}>()

ipcRenderer.on(CH.llmDelta, (_e, msg: { requestId: string; text: string }) => {
  llmStreams.get(msg.requestId)?.onDelta(msg.text)
})
ipcRenderer.on(CH.llmDone, (_e, msg: { requestId: string; text: string }) => {
  const slot = llmStreams.get(msg.requestId)
  if (!slot) return
  llmStreams.delete(msg.requestId)
  slot.onDone(msg.text)
})
ipcRenderer.on(CH.llmError, (_e, msg: { requestId: string; message: string }) => {
  const slot = llmStreams.get(msg.requestId)
  if (!slot) return
  llmStreams.delete(msg.requestId)
  slot.onError(new Error(msg.message))
})

// ─── adapter: wrap a real MessagePort into MessagePortLike ──────────────

function wrapPort(port: MessagePort): {
  postMessage(msg: ArrayBuffer | Uint8Array): void
  addEventListener(type: 'message', listener: (ev: { data: ArrayBuffer | Uint8Array }) => void): void
  removeEventListener(type: 'message', listener: (ev: { data: ArrayBuffer | Uint8Array }) => void): void
  start(): void
  close(): void
} {
  // The renderer hands us Uint8Arrays; the wire wants ArrayBuffers. We
  // accept both and normalise.
  return {
    postMessage(msg) {
      if (msg instanceof Uint8Array) {
        const ab = msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength)
        port.postMessage(ab)
      } else {
        port.postMessage(msg)
      }
    },
    addEventListener(type, listener) {
      port.addEventListener(type, listener as unknown as EventListener)
    },
    removeEventListener(type, listener) {
      port.removeEventListener(type, listener as unknown as EventListener)
    },
    start() { port.start() },
    close() { port.close() },
  }
}

// ─── the bridge ─────────────────────────────────────────────────────────

const bridge = {
  async spawn(opts: SpawnOptions): Promise<SessionInfo> {
    return ipcRenderer.invoke(CH.spawn, opts) as Promise<SessionInfo>
  },
  async write(id: string, text: string): Promise<void> {
    await ipcRenderer.invoke(CH.write, id, text)
  },
  async resize(id: string, cols: number, rows: number): Promise<void> {
    await ipcRenderer.invoke(CH.resize, id, cols, rows)
  },
  async signal(id: string, sig: 'INT' | 'TERM' | 'KILL'): Promise<void> {
    await ipcRenderer.invoke(CH.signal, id, sig)
  },
  async kill(id: string): Promise<void> {
    await ipcRenderer.invoke(CH.kill, id)
  },
  async list(): Promise<SessionInfo[]> {
    return ipcRenderer.invoke(CH.list) as Promise<SessionInfo[]>
  },
  async listSnapshots(workspaceHash: string): Promise<SnapshotSummary[]> {
    return ipcRenderer.invoke(CH.listSnapshots, workspaceHash) as Promise<SnapshotSummary[]>
  },
  async restoreSession(workspaceHash: string, snapshotId: string): Promise<{ newSessionId: string; session?: SessionInfo }> {
    return ipcRenderer.invoke(CH.restoreSession, workspaceHash, snapshotId) as Promise<{ newSessionId: string; session?: SessionInfo }>
  },
  async discardSnapshot(workspaceHash: string, snapshotId: string): Promise<void> {
    await ipcRenderer.invoke(CH.discardSnapshot, workspaceHash, snapshotId)
  },
  async restartHost(): Promise<void> {
    await ipcRenderer.invoke(CH.restartHost)
  },
  async attach(id: string, sinceSeq: number): Promise<{
    port: ReturnType<typeof wrapPort>
    channelId: string
    latestSeq: number
  }> {
    const portPromise = new Promise<{ port: MessagePort; meta: { channelId: string; latestSeq: number } }>((resolve) => {
      pendingAttach.set(id, (port, meta) => resolve({ port, meta }))
    })
    try {
      await ipcRenderer.invoke(CH.attach, id, sinceSeq)
    } catch (err) {
      pendingAttach.delete(id)
      throw err
    }
    const { port, meta } = await portPromise
    return { port: wrapPort(port), channelId: meta.channelId, latestSeq: meta.latestSeq }
  },
  async detach(id: string, channelId: string): Promise<void> {
    await ipcRenderer.invoke(CH.detach, id, channelId)
  },
  onEvent(cb: (ev: ControlEvent) => void): () => void {
    eventListeners.add(cb)
    return () => { eventListeners.delete(cb) }
  },
  llm: {
    async streamCommand(opts: {
      prompt: string
      context: unknown
      onDelta(text: string): void
      onDone(text: string): void
      onError(error: Error): void
    }): Promise<{ cancel(): void }> {
      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
      llmStreams.set(requestId, {
        onDelta: opts.onDelta,
        onDone: opts.onDone,
        onError: opts.onError,
      })
      await ipcRenderer.invoke(CH.llmStreamCommand, { requestId, prompt: opts.prompt, context: opts.context })
      return { cancel() { llmStreams.delete(requestId) } }
    },
    async openChatWithContext(markdown: string): Promise<void> {
      await ipcRenderer.invoke(CH.llmOpenChatWithContext, markdown)
    },
  },
}

/**
 * Mount the bridge onto window. Called once by preload.ts at startup.
 */
export function exposeShogoDesktopTerminalBridge(): void {
  contextBridge.exposeInMainWorld('shogoDesktopTerminal', bridge)
}
