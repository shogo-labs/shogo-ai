// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { parsePtyClientFrame, serializePtyFrame } from './pty-protocol'
import { PtyRegistry } from './pty-registry'
import type { PtySession } from './pty-session'
import { traceOperation } from '@shogo/shared-runtime'
import { recordRuntimeLogEntry } from '../runtime-log-dispatcher'

const WS_BACKPRESSURE_LIMIT_BYTES = 4 * 1024 * 1024
const OUTBOUND_CHUNK_BYTES = 16 * 1024

export interface TerminalPtyWsData {
  kind: 'terminal-pty'
  registry: PtyRegistry
  sessionId?: string
  dispose?: () => void
  exitDispose?: () => void
  killed?: boolean
}

type RuntimeWebSocket = WebSocket & { data?: TerminalPtyWsData }

export function isPtyEnabled(): boolean {
  return process.env.ENABLE_PTY === '1' || process.env.ENABLE_PTY === 'true'
}

export function createTerminalPtyRegistry(rootDir: string): PtyRegistry {
  const registry = new PtyRegistry({
    rootDir,
    maxSessions: Number(process.env.PTY_MAX_SESSIONS || 8),
    idleTtlMs: Number(process.env.PTY_IDLE_TTL_MS || 10 * 60_000),
    maxAgeMs: Number(process.env.PTY_MAX_AGE_MS || 8 * 60 * 60_000),
  })
  setInterval(() => registry.reapExpired(), 60_000).unref?.()
  return registry
}

export function handleTerminalPtyWsOpen(ws: RuntimeWebSocket): void {
  ws.send(serializePtyFrame({ type: 'pong' }))
}

export async function handleTerminalPtyWsMessage(
  ws: RuntimeWebSocket,
  raw: string | Buffer | ArrayBuffer | Uint8Array,
): Promise<void> {
  const data = ws.data
  if (!data?.registry) {
    ws.close(1011, 'Missing PTY registry')
    return
  }

  let frame: ReturnType<typeof parsePtyClientFrame>
  try {
    frame = parsePtyClientFrame(raw)
  } catch (err) {
    ws.send(serializePtyFrame({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
    return
  }

  if (frame.type === 'ping') {
    ws.send(serializePtyFrame({ type: 'pong' }))
    return
  }

  if (frame.type === 'init') {
    if (data.sessionId) {
      ws.send(serializePtyFrame({ type: 'error', message: 'PTY session already initialized' }))
      return
    }
    try {
      const result = await traceOperation(
        'agent-runtime',
        'pty.session.start',
        {
          sessionId: frame.sessionId ?? 'new',
          cols: frame.cols,
          rows: frame.rows,
        },
        () => data.registry.getOrCreate(frame),
      )
      bindSession(ws, result.session)
      data.sessionId = result.session.id
      logTerminal('info', `PTY session start id=${result.session.id} attached=${result.attached} cwd=${result.session.cwd}`)
      ws.send(serializePtyFrame({
        type: 'ready',
        sessionId: result.session.id,
        cwd: result.session.cwd,
        scrollback: result.scrollback || undefined,
        attached: result.attached,
      }))
    } catch (err) {
      ws.send(serializePtyFrame({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
      ws.close(1011, 'PTY init failed')
    }
    return
  }

  const sessionId = data.sessionId
  if (!sessionId) {
    ws.send(serializePtyFrame({ type: 'error', message: 'PTY session not initialized' }))
    return
  }
  const session = getSessionFromSocket(ws)
  if (!session) {
    ws.send(serializePtyFrame({ type: 'error', message: 'PTY session missing' }))
    return
  }

  if (frame.type === 'data') session.write(frame.data)
  else if (frame.type === 'resize') session.resize(frame.cols, frame.rows)
  else if (frame.type === 'signal') session.signal(frame.signal)
}

export function handleTerminalPtyWsClose(ws: RuntimeWebSocket): void {
  const data = ws.data
  data?.dispose?.()
  data?.exitDispose?.()
  const session = getSessionFromSocket(ws)
  if (data?.sessionId) {
    if (session) {
      logTerminal('info', formatSessionEnd('PTY session disconnected; detaching', session))
    }
    data.registry.detach(data.sessionId)
  }
  delete (ws as any)._ptySession
}

function bindSession(ws: RuntimeWebSocket, session: PtySession): void {
  ws.data!.dispose?.()
  ws.data!.exitDispose?.()
  ;(ws as any)._ptySession = session
  ws.data!.dispose = session.onData((chunk) => {
    if (ws.data?.killed) return
    try {
      if (((ws as any).bufferedAmount ?? 0) > WS_BACKPRESSURE_LIMIT_BYTES) {
        logTerminal('warn', formatSessionEnd('PTY backpressure limit exceeded; killing', session))
        if (ws.data) ws.data.killed = true
        ws.data?.registry.kill(session.id, 'SIGTERM')
        disposeSocketSession(ws)
        ws.close(1013, 'PTY output backpressure')
        return
      }
      for (const piece of chunkOutput(chunk)) {
        ws.send(serializePtyFrame({ type: 'data', data: piece }))
      }
    } catch {
      if (ws.data?.killed) return
      if (ws.data) ws.data.killed = true
      logTerminal('error', formatSessionEnd('PTY output send failed; killing', session))
      ws.data?.registry.kill(session.id, 'SIGTERM')
      disposeSocketSession(ws)
    }
  })
  ws.data!.exitDispose = session.onExit((exit) => {
    try {
      logTerminal('info', `${formatSessionEnd('PTY session end', session)} exitCode=${exit.exitCode} signal=${exit.signal}`)
      ws.send(serializePtyFrame({ type: 'exit', exitCode: exit.exitCode, signal: exit.signal }))
      ws.close(1000, 'PTY exited')
    } catch {
      // Ignore close races.
    }
  })
}

function disposeSocketSession(ws: RuntimeWebSocket): void {
  ws.data?.dispose?.()
  ws.data?.exitDispose?.()
  if (ws.data) {
    ws.data.dispose = undefined
    ws.data.exitDispose = undefined
  }
  delete (ws as any)._ptySession
}

function getSessionFromSocket(ws: RuntimeWebSocket): PtySession | null {
  return ((ws as any)._ptySession as PtySession | undefined) ?? null
}

function chunkOutput(data: string): string[] {
  if (Buffer.byteLength(data, 'utf8') <= OUTBOUND_CHUNK_BYTES) return [data]
  const chunks: string[] = []
  let current = ''
  for (const char of data) {
    current += char
    if (Buffer.byteLength(current, 'utf8') >= OUTBOUND_CHUNK_BYTES) {
      chunks.push(current)
      current = ''
    }
  }
  if (current) chunks.push(current)
  return chunks
}

function formatSessionEnd(prefix: string, session: PtySession): string {
  const stats = session.getStats()
  const mem = process.memoryUsage()
  return `${prefix} id=${session.id} durationMs=${stats.durationMs} idleMs=${stats.idleMs} bytesIn=${stats.bytesIn} bytesOut=${stats.bytesOut} rss=${mem.rss} heapUsed=${mem.heapUsed}`
}

function logTerminal(level: 'info' | 'warn' | 'error', text: string): void {
  const line = `[terminal-pty] ${text}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  recordRuntimeLogEntry({ source: 'terminal', level, text: line })
}
