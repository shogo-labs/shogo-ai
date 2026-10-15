// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Forward renderer diagnostics into main.log.
 *
 * main.ts patches the main process's console into main.log, but a renderer's
 * console output only lives in DevTools, so a crash in the chat view (e.g.
 * React #185) left nothing on disk. This attaches to a webContents and writes
 * its console warnings/errors and process failures through `writeLog`.
 *
 * Electron-free (structural types) so it is unit-testable with a fake emitter.
 */

export type RendererLogLevel = 'WARN' | 'ERROR'
export type WriteLog = (level: string, ...args: unknown[]) => void

export interface WebContentsLike {
  id: number
  on(event: string, listener: (...args: any[]) => void): unknown
  once?(event: string, listener: (...args: any[]) => void): unknown
  getURL?: () => string
}

/** Max forwarded lines per webContents per window; the rest are counted. */
export const RENDERER_LOG_LIMIT = 200
export const RENDERER_LOG_WINDOW_MS = 60_000
const MAX_MESSAGE_CHARS = 4_000

interface ConsoleMessage {
  level: 'debug' | 'info' | 'warning' | 'error'
  message: string
  lineNumber?: number
  sourceId?: string
}

/** Electron ≥ 35 passes one event object carrying `level`/`message`. */
export function parseConsoleMessage(event: unknown): ConsoleMessage | null {
  const e = event as any
  if (!e || typeof e !== 'object' || typeof e.level !== 'string' || typeof e.message !== 'string') return null
  return {
    level: e.level,
    message: e.message,
    lineNumber: typeof e.lineNumber === 'number' ? e.lineNumber : undefined,
    sourceId: typeof e.sourceId === 'string' ? e.sourceId : undefined,
  }
}

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}… [${text.length} chars]` : text
}

/** Drops the query string and fragment, which can carry tokens. */
export function stripUrlQuery(url: string): string {
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
}

export function formatConsoleMessage(webContentsId: number, msg: ConsoleMessage): string {
  const source = msg.sourceId ? stripUrlQuery(msg.sourceId) : ''
  const where = source ? ` (${source}${msg.lineNumber ? `:${msg.lineNumber}` : ''})` : ''
  return `[renderer:${webContentsId}] console.${msg.level === 'warning' ? 'warn' : msg.level}: ${truncate(msg.message)}${where}`
}

function describeRate(limit: number, windowMs: number): string {
  if (windowMs % 60_000 === 0) return windowMs === 60_000 ? `${limit}/min` : `${limit} per ${windowMs / 60_000} min`
  return `${limit} per ${windowMs / 1000}s`
}

export function attachRendererLogForwarding(
  contents: WebContentsLike,
  writeLog: WriteLog,
  {
    now = Date.now,
    limit = RENDERER_LOG_LIMIT,
    windowMs = RENDERER_LOG_WINDOW_MS,
    schedule = (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
    cancelScheduled = (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = {},
): void {
  let windowStart = now()
  let count = 0
  let suppressed = 0
  let flushTimer: unknown = null

  const flushSuppressed = () => {
    if (flushTimer !== null) cancelScheduled(flushTimer)
    flushTimer = null
    if (suppressed > 0) {
      writeLog('WARN', `[renderer:${contents.id}] ${suppressed} console lines suppressed (over ${describeRate(limit, windowMs)})`)
    }
    suppressed = 0
  }

  const emit = (level: RendererLogLevel, line: string, { always = false } = {}) => {
    const t = now()
    if (t - windowStart >= windowMs) {
      flushSuppressed()
      windowStart = t
      count = 0
    }
    if (!always && count >= limit) {
      suppressed++
      // Report the suppressed count when the window ends even if the renderer goes quiet.
      if (flushTimer === null) {
        flushTimer = schedule(flushSuppressed, Math.max(0, windowStart + windowMs - t))
      }
      return
    }
    count++
    writeLog(level, line)
  }

  contents.on('console-message', (event: unknown) => {
    const msg = parseConsoleMessage(event)
    if (!msg || (msg.level !== 'warning' && msg.level !== 'error')) return
    emit(msg.level === 'error' ? 'ERROR' : 'WARN', formatConsoleMessage(contents.id, msg))
  })

  contents.on('render-process-gone', (_event: unknown, details: { reason?: string; exitCode?: number } = {}) => {
    const url = stripUrlQuery(contents.getURL?.() ?? '')
    emit(
      'ERROR',
      `[renderer:${contents.id}] render process gone: reason=${details.reason ?? 'unknown'} exitCode=${details.exitCode ?? '?'}${url ? ` url=${url}` : ''}`,
      { always: true },
    )
  })

  contents.on('unresponsive', () => {
    emit('WARN', `[renderer:${contents.id}] renderer unresponsive`, { always: true })
  })
  contents.on('responsive', () => {
    emit('WARN', `[renderer:${contents.id}] renderer responsive again`, { always: true })
  })

  contents.on('preload-error', (_event: unknown, preloadPath: string, error: unknown) => {
    const detail = error instanceof Error ? error.stack || error.message : String(error)
    emit('ERROR', `[renderer:${contents.id}] preload error in ${preloadPath}: ${truncate(detail)}`, { always: true })
  })

  contents.once?.('destroyed', flushSuppressed)
}
