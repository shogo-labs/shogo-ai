// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Localhost HTTP bridge that lets the Bun API process drive Electron's
 * recording pipeline without re-implementing audio capture in Node.
 *
 * Design goals:
 * - Zero-config: random port + per-process token, written to a file under
 *   `userData/` that apps/api discovers when running on the same machine.
 * - Minimal surface: 4 routes (POST start, POST stop, GET status, POST abort).
 * - Not reachable off-box: binds to 127.0.0.1 only, requires header token.
 *
 * Recording itself still needs the renderer (the only place `getUserMedia`
 * and `getDisplayMedia` exist). The bridge dispatches IPC events to the
 * main window, which wires the capture pipeline via the preload script.
 */
import http from 'http'
import path from 'path'
import crypto from 'crypto'
import fs from 'fs'
import { BrowserWindow } from 'electron'
import type { AddressInfo } from 'net'

interface BridgeState {
  server: http.Server
  port: number
  token: string
  filePath: string
}

interface StartRecordingFn {
  (): Promise<{ ok: true; id: string; audioPath: string } | { ok: false; error: string }>
}
interface StopRecordingFn {
  (): Promise<{ ok: true; id: string; audioPath: string; duration: number } | { ok: false; error: string }>
}
interface StatusFn {
  (): { isRecording: boolean; id: string | null; audioPath: string | null; duration: number }
}

export interface RecordingBridgeHandlers {
  start: StartRecordingFn
  stop: StopRecordingFn
  status: StatusFn
}

let current: BridgeState | null = null

export interface RecordingBridgeOptions {
  /** Directory to write `recording-bridge.json` — usually `app.getPath('userData')`. */
  userDataDir: string
  handlers: RecordingBridgeHandlers
}

/**
 * Start the bridge, write the descriptor file so `apps/api` can discover it,
 * and return the chosen port for logging. Idempotent.
 */
export async function startRecordingBridge(opts: RecordingBridgeOptions): Promise<{ port: number; token: string; filePath: string }> {
  if (current) {
    return { port: current.port, token: current.token, filePath: current.filePath }
  }

  const token = crypto.randomBytes(24).toString('hex')

  const server = http.createServer(async (req, res) => {
    if (!req.url) { res.statusCode = 400; return res.end() }

    if (req.headers['x-shogo-bridge-token'] !== token) {
      res.statusCode = 401
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ error: 'unauthorized' }))
    }

    const url = new URL(req.url, 'http://127.0.0.1')
    try {
      if (req.method === 'GET' && url.pathname === '/recording/status') {
        return sendJson(res, 200, opts.handlers.status())
      }
      if (req.method === 'POST' && url.pathname === '/recording/start') {
        const result = await opts.handlers.start()
        if (!result.ok) return sendJson(res, 400, { error: result.error })
        return sendJson(res, 200, { id: result.id, audioPath: result.audioPath })
      }
      if (req.method === 'POST' && url.pathname === '/recording/stop') {
        const result = await opts.handlers.stop()
        if (!result.ok) return sendJson(res, 400, { error: result.error })
        return sendJson(res, 200, { id: result.id, audioPath: result.audioPath, duration: result.duration })
      }
      res.statusCode = 404
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ error: 'not found' }))
    } catch (err) {
      console.error('[RecordingBridge] handler error:', err)
      return sendJson(res, 500, { error: (err as Error).message })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo | null
  if (!address) {
    server.close()
    throw new Error('failed to bind recording bridge')
  }

  const filePath = path.join(opts.userDataDir, 'recording-bridge.json')
  fs.writeFileSync(
    filePath,
    JSON.stringify({ port: address.port, token, pid: process.pid, startedAt: Date.now() }, null, 2),
    { mode: 0o600 },
  )

  current = { server, port: address.port, token, filePath }
  console.log(`[RecordingBridge] listening on 127.0.0.1:${address.port} (descriptor at ${filePath})`)
  return { port: address.port, token, filePath }
}

export async function stopRecordingBridge(): Promise<void> {
  if (!current) return
  const { server, filePath } = current
  current = null
  try { fs.unlinkSync(filePath) } catch { /* best-effort */ }
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

/**
 * Helper used by `recording.ts` to ask the renderer to start capture via the
 * `startRecording` contextBridge function. This keeps all the Web Audio
 * plumbing in one place.
 */
export async function invokeRendererStart(): Promise<{ ok: true; id: string; audioPath: string } | { ok: false; error: string }> {
  const win = findVisibleWindow()
  if (!win) return { ok: false, error: 'no renderer window available — open the Shogo app first' }

  try {
    const result = await win.webContents.executeJavaScript(
      `window.shogoDesktop?.startRecording?.().catch((e) => ({ ok: false, error: String(e && e.message || e) }))`,
      true,
    ) as { ok: boolean; id?: string; audioPath?: string; error?: string }
    if (!result?.ok || !result.id || !result.audioPath) {
      return { ok: false, error: result?.error || 'renderer did not acknowledge start' }
    }
    return { ok: true, id: result.id, audioPath: result.audioPath }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export async function invokeRendererStop(): Promise<{ ok: true; id: string; audioPath: string; duration: number } | { ok: false; error: string }> {
  const win = findVisibleWindow()
  if (!win) return { ok: false, error: 'no renderer window available' }

  try {
    const result = await win.webContents.executeJavaScript(
      `window.shogoDesktop?.stopRecording?.().catch((e) => ({ ok: false, error: String(e && e.message || e) }))`,
      true,
    ) as { ok: boolean; id?: string; audioPath?: string; duration?: number; error?: string }
    if (!result?.ok || !result.id || !result.audioPath) {
      return { ok: false, error: result?.error || 'renderer did not acknowledge stop' }
    }
    return { ok: true, id: result.id, audioPath: result.audioPath, duration: result.duration ?? 0 }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

function findVisibleWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  return windows[0] ?? null
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}
