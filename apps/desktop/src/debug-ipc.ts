// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Debug Adapter (CDP) IPC surface.
 *
 * Bridges the renderer ⇄ a live `DebugSession`.  Mirrors the shape of
 * `run-ipc.ts` (UUID per session, named broadcast channels) so the
 * renderer can re-use the same pattern it already understands.
 *
 * Channels:
 *   debug:start(runId, wsUrl)                → { ok, sessionId, error? }
 *      Opens a CDP socket to the URL emitted by run-ipc.  Returns a
 *      stable sessionId the renderer can use for everything below.
 *   debug:setBreakpoint(sessionId, args)     → { ok, bp?, error? }
 *   debug:removeBreakpoint(sessionId, id)    → { ok, error? }
 *   debug:resume / pause / stepOver / stepInto / stepOut(sessionId) → { ok, error? }
 *   debug:evaluate(sessionId, expression)    → { ok, result?, error? }
 *   debug:detach(sessionId)                  → { ok }
 *
 * Broadcast events (per-session):
 *   debug:event:<sessionId>  — { type: 'state' | 'paused' | 'resumed' | 'console' | 'exception' | 'detached', payload }
 *
 * Hard rules:
 *   • Every wsUrl is validated to be ws://127.0.0.1:* or ws://localhost:*
 *     before opening — no remote attaches allowed from renderer input.
 *   • Sessions are tracked in a Map keyed by sessionId; `dispose()`
 *     detaches every live one on Electron quit.
 */
import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { CdpClient } from './debug/cdp-client'
import { DebugSession, type DebugSessionState, type PausedEvent } from './debug/debug-session'
import { isLoopbackWsUrl } from './debug-ipc-pure'

interface SessionInfo {
  sessionId: string
  cdp: CdpClient
  session: DebugSession
}

const sessions = new Map<string, SessionInfo>()

function broadcastEvent(sessionId: string, type: string, payload: unknown): void {
  const channel = `debug:event:${sessionId}`
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try { w.webContents.send(channel, { type, payload }) } catch { /* window closed */ }
    }
  }
}

async function startHandler(_e: unknown, wsUrl: unknown): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  if (typeof wsUrl !== 'string' || !isLoopbackWsUrl(wsUrl)) {
    return { ok: false, error: 'invalid wsUrl (must be ws://127.0.0.1 or ws://localhost)' }
  }
  const sessionId = randomUUID()
  let cdp: CdpClient
  try {
    cdp = new CdpClient({ url: wsUrl, timeoutMs: 30_000 })
  } catch (e) {
    return { ok: false, error: `cdp init failed: ${(e as Error).message}` }
  }

  const session = new DebugSession({
    cdp,
    label: wsUrl,
    on: {
      onState: (s: DebugSessionState) => broadcastEvent(sessionId, 'state', s),
      onPaused: (p: PausedEvent) => broadcastEvent(sessionId, 'paused', p),
      onResumed: () => broadcastEvent(sessionId, 'resumed', null),
      onConsoleApi: (c) => broadcastEvent(sessionId, 'console', c),
      onException: (c) => broadcastEvent(sessionId, 'exception', c),
      onDetached: (r) => {
        broadcastEvent(sessionId, 'detached', { reason: r })
        sessions.delete(sessionId)
      },
    },
  })

  try {
    await session.attach()
  } catch (e) {
    return { ok: false, error: `attach failed: ${(e as Error).message}` }
  }

  sessions.set(sessionId, { sessionId, cdp, session })
  return { ok: true, sessionId }
}

interface BpArgs { url: string; lineNumber: number; columnNumber?: number; condition?: string }

async function setBreakpointHandler(
  _e: unknown,
  sessionId: string,
  args: BpArgs,
): Promise<{ ok: boolean; bp?: unknown; error?: string }> {
  const info = sessions.get(sessionId)
  if (!info) return { ok: false, error: 'no such session' }
  if (!args || typeof args.url !== 'string' || typeof args.lineNumber !== 'number') {
    return { ok: false, error: 'invalid args' }
  }
  try {
    const bp = await info.session.setBreakpoint(args)
    return { ok: true, bp }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

async function removeBreakpointHandler(
  _e: unknown,
  sessionId: string,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const info = sessions.get(sessionId)
  if (!info) return { ok: false, error: 'no such session' }
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' }
  try { await info.session.removeBreakpoint(id); return { ok: true } }
  catch (e) { return { ok: false, error: (e as Error).message } }
}

type SimpleAction = 'resume' | 'pause' | 'stepOver' | 'stepInto' | 'stepOut'

function makeSimpleHandler(action: SimpleAction) {
  return async (_e: unknown, sessionId: string): Promise<{ ok: boolean; error?: string }> => {
    const info = sessions.get(sessionId)
    if (!info) return { ok: false, error: 'no such session' }
    try {
      await info.session[action]()
      return { ok: true }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  }
}

async function evaluateHandler(
  _e: unknown,
  sessionId: string,
  expression: string,
): Promise<{ ok: boolean; result?: { ok: boolean; text: string; data?: unknown }; error?: string }> {
  const info = sessions.get(sessionId)
  if (!info) return { ok: false, error: 'no such session' }
  if (typeof expression !== 'string' || expression.length === 0) {
    return { ok: false, error: 'empty expression' }
  }
  if (expression.length > 8192) {
    return { ok: false, error: 'expression too long (max 8192 chars)' }
  }
  try {
    const r = await info.session.evaluate(expression)
    return { ok: true, result: r }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

async function detachHandler(_e: unknown, sessionId: string): Promise<{ ok: boolean }> {
  const info = sessions.get(sessionId)
  if (!info) return { ok: true }
  try { await info.session.detach('user') } catch { /* swallow */ }
  sessions.delete(sessionId)
  return { ok: true }
}

async function listHandler(): Promise<{ ok: true; sessions: Array<{ sessionId: string; state: DebugSessionState }> }> {
  const list = Array.from(sessions.values()).map((i) => ({
    sessionId: i.sessionId,
    state: i.session.state,
  }))
  return { ok: true, sessions: list }
}

let registered = false

export function registerDebugIpcHandlers(): void {
  if (registered) return
  registered = true
  ipcMain.handle('debug:start', startHandler)
  ipcMain.handle('debug:setBreakpoint', setBreakpointHandler)
  ipcMain.handle('debug:removeBreakpoint', removeBreakpointHandler)
  ipcMain.handle('debug:resume', makeSimpleHandler('resume'))
  ipcMain.handle('debug:pause', makeSimpleHandler('pause'))
  ipcMain.handle('debug:stepOver', makeSimpleHandler('stepOver'))
  ipcMain.handle('debug:stepInto', makeSimpleHandler('stepInto'))
  ipcMain.handle('debug:stepOut', makeSimpleHandler('stepOut'))
  ipcMain.handle('debug:evaluate', evaluateHandler)
  ipcMain.handle('debug:detach', detachHandler)
  ipcMain.handle('debug:list', listHandler)
}

export function disposeDebugIpc(): void {
  for (const info of sessions.values()) {
    try { void info.session.detach('shutdown') } catch { /* swallow */ }
  }
  sessions.clear()
}

// Test-only seam: lets the unit test inject a session bypassing the
// real CDP socket.  NOT exposed via IPC.
export function __debugIpcInjectSessionForTest(info: SessionInfo): void {
  sessions.set(info.sessionId, info)
}
export function __debugIpcClearForTest(): void {
  sessions.clear()
}
export const __debugIpcHandlersForTest = {
  start: startHandler,
  setBreakpoint: setBreakpointHandler,
  removeBreakpoint: removeBreakpointHandler,
  resume: makeSimpleHandler('resume'),
  pause: makeSimpleHandler('pause'),
  stepOver: makeSimpleHandler('stepOver'),
  stepInto: makeSimpleHandler('stepInto'),
  stepOut: makeSimpleHandler('stepOut'),
  evaluate: evaluateHandler,
  detach: detachHandler,
  list: listHandler,
}
