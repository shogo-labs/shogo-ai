// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * terminal-exec-server — tiny HTTP bridge for the agent runtime to read from
 * and execute commands in the user's desktop IDE terminal.
 *
 * Architecture:
 *
 *   Agent Gateway (child process)
 *     → fetch(POST http://localhost:{port}/terminal/exec)
 *     → terminal-exec-server (this file, in Electron main process)
 *     → PTY host client → user's desktop terminal session
 *     → result/context back to gateway
 *
 * The server listens on a random port and exposes:
 *   POST /terminal/exec { command, cwd?, timeoutMs? }
 *   → { exitCode, output, cwd, durationMs, timedOut }
 *   POST /terminal/context { terminalId?, cwd?, maxChars? }
 *   → { terminalId, cwd, content, sessions, truncated }
 *
 * The gateway receives this URL via TERMINAL_EXEC_URL env var, set
 * when the Electron main process spawns the agent-runtime child.
 */

import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import electron from 'electron'
import type { ControlEvent, SessionInfo } from '../pty-host/protocol'

export const TERMINAL_AGENT_SPAWN_CHANNEL = 'shogo:terminal:agent-spawned' as const

/** Header the agent runtime must send to authenticate to the exec bridge. */
const AUTH_HEADER = 'x-shogo-bridge-token'
/** Hard cap on request body size (1 MiB) — exec/context payloads are tiny. */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024

// ─── types ──────────────────────────────────────────────────────────────

interface TerminalExecRequest {
  command: string
  cwd?: string
  timeoutMs?: number
  mode?: 'foreground' | 'background'
}

interface TerminalExecResponse {
  exitCode: number | null
  output: string
  cwd: string | null
  durationMs: number | null
  timedOut: boolean
  error?: string
  mode?: 'foreground' | 'background'
  sessionId?: string
  terminalLabel?: string
}

interface TerminalContextRequest {
  terminalId?: string
  cwd?: string
  maxChars?: number
}

interface TerminalContextSession {
  id: string
  cwd: string | null
  shell: string | null
  createdAt: number | null
  updatedAt: number | null
  exitedAt: number | null
  bytes: number
  active: boolean
}

interface TerminalContextResponse {
  source: 'desktop-pty'
  terminalId: string | null
  cwd: string | null
  content: string
  sessions: TerminalContextSession[]
  truncated: boolean
  error?: string
  hint?: string
}

// ─── server ─────────────────────────────────────────────────────────────

let server: Server | null = null
let port: number = 0
let authToken: string = ''
let serverReady: Promise<string> | null = null
let offTerminalEvents: (() => void) | null = null
let terminalEventsSubscribing = false

/**
 * Per-session serialization: only one foreground command may run in a given
 * PTY session at a time, otherwise two concurrent agent calls interleave their
 * sentinel detection and corrupt each other's output. We chain promises per
 * session id.
 */
const sessionExecLocks = new Map<string, Promise<unknown>>()

/** Session id of the most recent foreground command (target for interrupt). */
let lastForegroundSessionId: string | null = null

/** Background agent terminals spawned by this server — tracked for cleanup. */
const backgroundSessions = new Set<string>()

/** Run `fn` exclusively per-session, serializing concurrent foreground execs. */
async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionExecLocks.get(sessionId) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  // Keep the chain alive but swallow rejections so one failure doesn't poison
  // the next queued command.
  const tail = run.catch(() => {})
  sessionExecLocks.set(sessionId, tail)
  try {
    return await run
  } finally {
    // Drop the lock entry once we're the tail, so the map doesn't grow forever.
    if (sessionExecLocks.get(sessionId) === tail) {
      sessionExecLocks.delete(sessionId)
    }
  }
}

const TEXT_DECODER = new TextDecoder()
const MAX_CONTEXT_BYTES_PER_SESSION = 512 * 1024
const DEFAULT_CONTEXT_CHARS = 24_000

type BufferedSession = {
  id: string
  cwd: string | null
  shell: string | null
  createdAt: number | null
  updatedAt: number | null
  exitedAt: number | null
  bytes: number
  chunks: string[]
}

const terminalBuffers = new Map<string, BufferedSession>()

type RendererTerminalContext = {
  sessionId: string
  cwd: string | null
  content: string
  updatedAt: number
}

/** Structured command history pushed from the renderer (OSC633 tracker). */
const rendererContexts = new Map<string, RendererTerminalContext>()

export function updateRendererTerminalContext(payload: {
  sessionId: string
  cwd: string | null
  content: string
}): void {
  if (!payload.sessionId || !payload.content.trim()) return
  rendererContexts.set(payload.sessionId, {
    sessionId: payload.sessionId,
    cwd: payload.cwd,
    content: payload.content.trim(),
    updatedAt: Date.now(),
  })
}

function notifyAgentTerminalSpawned(payload: {
  sessionId: string
  terminalLabel: string
  cwd: string | null
}): void {
  for (const win of electron.BrowserWindow.getAllWindows()) {
    try { win.webContents.send(TERMINAL_AGENT_SPAWN_CHANNEL, payload) } catch { /* gone */ }
  }
}

/**
 * Start the terminal exec HTTP server. Returns the URL to pass
 * to the agent-runtime via TERMINAL_EXEC_URL env var.
 */
export function startTerminalExecServer(): Promise<string> {
  if (server && port > 0) return Promise.resolve(`http://127.0.0.1:${port}`)
  if (serverReady) return serverReady

  authToken = randomBytes(24).toString('hex')
  ensureTerminalEventSubscription()

  server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // Auth gate — the bridge runs on loopback but any local process can reach
    // it, so require the per-process token (mirrors recording/bridge.ts). This
    // is the primary defense against a confused-deputy localhost attacker.
    if (!authToken || req.headers[AUTH_HEADER] !== authToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    if (req.method === 'POST' && req.url === '/terminal/interrupt') {
      try {
        const result = await interruptActiveCommand()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ interrupted: false, error: err?.message ?? String(err) }))
      }
      return
    }

    if (req.url === '/terminal/context' && (req.method === 'GET' || req.method === 'POST')) {
      try {
        const rawBody = req.method === 'POST' ? await readBody(req) : ''
        const request: TerminalContextRequest = rawBody.trim() ? JSON.parse(rawBody) : {}
        const result = await readTerminalContext(request)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err: any) {
        const message = err?.message ?? String(err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          source: 'desktop-pty',
          terminalId: null,
          cwd: null,
          content: '',
          sessions: [],
          truncated: false,
          error: message,
        } satisfies TerminalContextResponse))
      }
      return
    }

    if (req.method !== 'POST' || req.url !== '/terminal/exec') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }

    try {
      const body = await readBody(req)
      const request: TerminalExecRequest = JSON.parse(body)

      if (!request.command || typeof request.command !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing or invalid "command" field' }))
        return
      }

      const result = await executeAgentCommand(request)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err: any) {
      const message = err?.message ?? String(err)
      console.error('[TerminalExecServer] Error:', message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        exitCode: null,
        output: '',
        cwd: null,
        durationMs: null,
        timedOut: false,
        error: message,
      }))
    }
  })

  serverReady = new Promise<string>((resolve, reject) => {
    server!.once('error', reject)
    // Listen on a random available port, bound to localhost only.
    server!.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      if (addr && typeof addr === 'object') {
        port = addr.port
        const url = `http://127.0.0.1:${port}`
        console.log(`[TerminalExecServer] Listening on ${url}`)
        resolve(url)
      } else {
        reject(new Error('Terminal exec server did not receive a TCP port'))
      }
    })
  }).catch((err) => {
    serverReady = null
    throw err
  })

  return serverReady
}

/**
 * Stop the terminal exec HTTP server.
 */
export function stopTerminalExecServer(): void {
  if (server) {
    server.close()
    server = null
    port = 0
    authToken = ''
    serverReady = null
    if (offTerminalEvents) {
      offTerminalEvents()
      offTerminalEvents = null
    }
    terminalEventsSubscribing = false
    terminalBuffers.clear()
    rendererContexts.clear()
    sessionExecLocks.clear()
    lastForegroundSessionId = null
    // Best-effort: kill any background agent terminals this server spawned so
    // they don't linger after shutdown.
    if (backgroundSessions.size > 0) {
      const ids = [...backgroundSessions]
      backgroundSessions.clear()
      void import('../pty-host-client').then(({ getPtyHostClient }) => {
        const host = getPtyHostClient()
        for (const id of ids) {
          host.kill(id).catch(() => { /* already gone */ })
        }
      }).catch(() => { /* host unavailable */ })
    }
    console.log('[TerminalExecServer] Stopped')
  }
}

/**
 * Get the current port (0 if not running).
 */
export function getTerminalExecPort(): number {
  return port
}

/**
 * Get the auth token clients must send via the `x-shogo-bridge-token` header.
 * Empty string if the server is not running.
 */
export function getTerminalExecToken(): string {
  return authToken
}

/**
 * Send SIGINT to the session running the most recent foreground command.
 */
async function interruptActiveCommand(): Promise<{ interrupted: boolean; error?: string }> {
  if (!lastForegroundSessionId) {
    return { interrupted: false, error: 'No active terminal command to interrupt.' }
  }
  try {
    const { getPtyHostClient } = await import('../pty-host-client')
    await getPtyHostClient().signal(lastForegroundSessionId, 'INT')
    return { interrupted: true }
  } catch (err: any) {
    return { interrupted: false, error: err?.message ?? String(err) }
  }
}

// ─── agent command dispatch ─────────────────────────────────────────────

/**
 * Single execution path for agent terminal commands.
 *
 * Electron has no `webContents.invoke()`, so the main process cannot call the
 * renderer to run a command. The chosen — and only — path is therefore the PTY
 * host, which runs in the main process and has full access to the user's shell:
 *
 *   - `mode: 'background'` → {@link executeInBackground} (detached, polled later)
 *   - otherwise            → {@link executeViaPtyHost} (foreground, awaited)
 *
 * The renderer-side stack (AgentTerminalBridge → TerminalCommandExecutor) is a
 * separate, UI-visible path used by the renderer itself; it is intentionally
 * NOT invoked from here. Keep this the sole server-side dispatcher so there is
 * one place that maps a request to its runner.
 */
async function executeAgentCommand(request: TerminalExecRequest): Promise<TerminalExecResponse> {
  if (request.mode === 'background') return executeInBackground(request)
  return executeViaPtyHost(request)
}

/**
 * Execute a command in the user's VISIBLE terminal.
 *
 * Strategy:
 *   1. List existing terminal sessions via PTY host
 *   2. If an active session exists, write the command there (user sees it!)
 *   3. If no active session, spawn a new one (fallback)
 *   4. Use a sentinel marker to detect when the command finishes
 *
 * The key difference from the old approach: we write to the EXISTING
 * terminal so the user sees the command running in their own terminal.
 */
async function executeViaPtyHost(request: TerminalExecRequest): Promise<TerminalExecResponse> {
  const { getPtyHostClient } = await import('../pty-host-client')
  const host = getPtyHostClient()
  const startMs = Date.now()
  const timeoutMs = request.timeoutMs ?? 120_000

  // Find the user's active terminal session.
  const sessions = await host.list()
  const activeSession = chooseBestSession(sessions, request.cwd)

  if (activeSession) {
    const sessionId = activeSession.id
    // Serialize per-session: two concurrent foreground commands writing to the
    // same PTY would interleave and corrupt each other's sentinel detection.
    return withSessionLock(sessionId, async () => {
      lastForegroundSessionId = sessionId
      let output = ''
      let exitCode: number | null = null
      let timedOut = false

      // Use a unique sentinel to detect when the command finishes.
      // The shell integration PROMPT_COMMAND will emit after the command,
      // and we detect completion by watching for the next prompt marker.
      const sentinel = `__SHOGO_EXEC_DONE_${Date.now()}__`
      const sentinelRe = new RegExp(`${escapeRegExp(sentinel)}:(\\d+)`)

      // Collect output from this session
      const dataHandler = (ev: ControlEvent) => {
        if (ev.kind === 'session:data' && ev.id === sessionId) {
          output += decodeSessionData(ev.dataB64)
        }
      }

      host.on('event', dataHandler)

      try {
        // Write the command followed by a sentinel echo to detect completion
        const command = request.cwd && request.cwd !== activeSession.cwd
          ? `cd ${shellQuote(request.cwd)} && ${request.command}`
          : request.command
        await host.write(sessionId, `${command}; printf '\\n${sentinel}:%s\\n' "$?"\r`)

        // Wait for sentinel to appear in output, or timeout
        const deadline = startMs + timeoutMs
        while (!sentinelRe.test(output) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100))
        }

        // Extract output before the sentinel
        const match = output.match(sentinelRe)
        const sentinelIdx = match ? output.indexOf(match[0]) : -1
        if (match && sentinelIdx >= 0) {
          output = output.substring(0, sentinelIdx)
          exitCode = Number(match[1])
        }

        if (exitCode === null) {
          timedOut = true
          exitCode = null
          // The command is still running in the user's visible terminal. Send
          // SIGINT so it doesn't keep occupying the prompt indefinitely.
          try { await host.signal(sessionId, 'INT') } catch { /* best-effort */ }
          output += '\n[Timed out after ' + timeoutMs + 'ms]'
        }

        return {
          exitCode,
          output: stripAnsi(output),
          cwd: request.cwd ?? activeSession.cwd ?? null,
          durationMs: Date.now() - startMs,
          timedOut,
        }
      } finally {
        host.removeListener('event', dataHandler)
      }
    })
  }

  return executeHiddenOneShot(request, timeoutMs, startMs)
}

// ─── helpers ────────────────────────────────────────────────────────────

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_REQUEST_BODY_BYTES) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

async function executeHiddenOneShot(
  request: TerminalExecRequest,
  timeoutMs: number,
  startMs: number,
): Promise<TerminalExecResponse> {
  const { spawn } = await import('node:child_process')
  const command = request.cwd
    ? `cd ${shellQuote(request.cwd)} && ${request.command}`
    : request.command
  const child = spawn(process.env.SHELL || '/bin/zsh', ['-l', '-c', command], {
    cwd: request.cwd || process.env.HOME || '/',
    env: {
      ...process.env as Record<string, string>,
      TERM_PROGRAM: 'shogo',
      SHOGO_TERMINAL: '1',
    },
  })

  let output = ''
  let exitCode: number | null = null
  let timedOut = false
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf-8') })
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf-8') })

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch {}
      output += '\n[Timed out after ' + timeoutMs + 'ms]'
      resolve()
    }, timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      exitCode = code
      resolve()
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      output += `\n${err.message}`
      exitCode = 1
      resolve()
    })
  })

  return {
    exitCode,
    output: stripAnsi(output),
    cwd: request.cwd ?? null,
    durationMs: Date.now() - startMs,
    timedOut,
  }
}

function ensureTerminalEventSubscription(): void {
  if (offTerminalEvents || terminalEventsSubscribing) return
  terminalEventsSubscribing = true
  void import('../pty-host-client').then(({ getPtyHostClient }) => {
    const host = getPtyHostClient()
    const handler = (ev: ControlEvent) => {
      if (ev.kind === 'session:data') {
        appendTerminalData(ev.id, decodeSessionData(ev.dataB64), ev.seq)
        return
      }
      if (ev.kind === 'session:exit' || ev.kind === 'session:reap') {
        const session = ensureBufferedSession(ev.id)
        session.exitedAt = Date.now()
        session.updatedAt = session.exitedAt
      }
      if (ev.kind === 'session:trunc') {
        appendTerminalData(ev.id, '\n[scrollback truncated]\n')
      }
    }
    host.on('event', handler)
    offTerminalEvents = () => host.removeListener('event', handler)
  }).catch((err) => {
    terminalEventsSubscribing = false
    console.warn('[TerminalExecServer] Failed to subscribe to terminal events:', err)
  })
}

async function readTerminalContext(request: TerminalContextRequest): Promise<TerminalContextResponse> {
  ensureTerminalEventSubscription()
  const { getPtyHostClient } = await import('../pty-host-client')
  const host = getPtyHostClient()
  const activeSessions = await host.list().catch(() => [] as SessionInfo[])
  for (const session of activeSessions) {
    mergeSessionInfo(session)
  }

  const sessions = summarizeSessions(activeSessions)
  if (sessions.length === 0) {
    return {
      source: 'desktop-pty',
      terminalId: null,
      cwd: request.cwd ?? null,
      content: '',
      sessions: [],
      truncated: false,
      error: 'No desktop terminal sessions found.',
      hint: 'Open the IDE Terminal tab or run a command in an existing terminal first.',
    }
  }

  const target = chooseBufferedSession(sessions, request)
  if (!target) {
    return {
      source: 'desktop-pty',
      terminalId: null,
      cwd: request.cwd ?? null,
      content: '',
      sessions,
      truncated: false,
      error: request.terminalId
        ? `Terminal "${request.terminalId}" not found.`
        : 'No matching desktop terminal session found.',
    }
  }

  const rendererCtx = rendererContexts.get(target.id)
  const buffered = terminalBuffers.get(target.id)
  const raw = buffered?.chunks.join('') ?? ''
  const maxChars = clampMaxChars(request.maxChars)
  const plainScrollback = stripAnsi(raw)
  const scrollbackTruncated = plainScrollback.length > maxChars
  const scrollbackTail = scrollbackTruncated
    ? plainScrollback.slice(plainScrollback.length - maxChars)
    : plainScrollback

  const structured = rendererCtx?.content ?? ''
  const parts: string[] = []
  if (structured) parts.push(structured)
  if (scrollbackTail.trim()) {
    parts.push('## Terminal scrollback (raw)')
    parts.push(scrollbackTail.trim())
  }
  const combined = parts.join('\n\n')
  const truncated = scrollbackTruncated || combined.length > maxChars
  const content = combined.length > maxChars
    ? combined.slice(combined.length - maxChars)
    : combined

  return {
    source: 'desktop-pty',
    terminalId: target.id,
    cwd: rendererCtx?.cwd ?? target.cwd,
    content,
    sessions,
    truncated,
    ...(content
      ? {}
      : { hint: 'The terminal exists, but no output has reached the desktop context buffer yet. Run a command in the IDE terminal first.' }),
  }
}

function summarizeSessions(activeSessions: SessionInfo[]): TerminalContextSession[] {
  const activeIds = new Set(activeSessions.map((s) => s.id))
  for (const session of activeSessions) mergeSessionInfo(session)
  return [...terminalBuffers.values()]
    .map((session) => ({
      id: session.id,
      cwd: session.cwd,
      shell: session.shell,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      exitedAt: session.exitedAt,
      bytes: session.bytes,
      active: activeIds.has(session.id) && session.exitedAt == null,
    }))
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
}

function chooseBufferedSession(
  sessions: TerminalContextSession[],
  request: TerminalContextRequest,
): TerminalContextSession | null {
  if (request.terminalId) {
    return sessions.find((s) => s.id === request.terminalId) ?? null
  }
  const active = sessions.filter((s) => s.active)
  const pool = active.length > 0 ? active : sessions
  if (request.cwd) {
    const cwdMatch = pool.find((s) => pathsRelated(s.cwd, request.cwd!))
    if (cwdMatch) return cwdMatch
  }
  return pool[0] ?? null
}

function chooseBestSession(sessions: SessionInfo[], cwd?: string): SessionInfo | null {
  if (sessions.length === 0) return null
  if (cwd) {
    const cwdMatch = sessions.find((s) => pathsRelated(s.cwd, cwd))
    if (cwdMatch) return cwdMatch
  }
  return [...sessions].sort((a, b) => {
    const aUpdated = terminalBuffers.get(a.id)?.updatedAt ?? a.createdAt
    const bUpdated = terminalBuffers.get(b.id)?.updatedAt ?? b.createdAt
    return bUpdated - aUpdated
  })[0] ?? null
}

function mergeSessionInfo(session: SessionInfo): void {
  const buffered = ensureBufferedSession(session.id)
  buffered.cwd = session.cwd ?? buffered.cwd
  buffered.shell = session.shell ?? buffered.shell
  buffered.createdAt = session.createdAt ?? buffered.createdAt
  if (buffered.updatedAt == null) buffered.updatedAt = session.createdAt ?? null
  buffered.exitedAt = null
}

function ensureBufferedSession(id: string): BufferedSession {
  let session = terminalBuffers.get(id)
  if (!session) {
    session = {
      id,
      cwd: null,
      shell: null,
      createdAt: null,
      updatedAt: null,
      exitedAt: null,
      bytes: 0,
      chunks: [],
    }
    terminalBuffers.set(id, session)
  }
  return session
}

function appendTerminalData(id: string, text: string, seq?: number): void {
  if (!text) return
  const session = ensureBufferedSession(id)
  session.chunks.push(text)
  session.bytes += Buffer.byteLength(text, 'utf-8')
  session.updatedAt = Date.now()
  while (session.bytes > MAX_CONTEXT_BYTES_PER_SESSION && session.chunks.length > 1) {
    const dropped = session.chunks.shift() ?? ''
    session.bytes -= Buffer.byteLength(dropped, 'utf-8')
  }
  void seq
}

function decodeSessionData(dataB64: string): string {
  return TEXT_DECODER.decode(Buffer.from(dataB64, 'base64'))
}

/**
 * Execute a command in a NEW agent terminal tab (background mode).
 * The terminal appears as "Shogo (cd /path && command...)" with an
 * infinity icon. The user can see it running but cannot type in it.
 */
async function executeInBackground(request: TerminalExecRequest): Promise<TerminalExecResponse> {
  const { getPtyHostClient } = await import('../pty-host-client')
  const host = getPtyHostClient()

  // Spawn an interactive shell (no -c — shell integration wraps args
  // with --rcfile which conflicts with -c on some shells).
  const session = await host.spawn({
    shell: process.env.SHELL || '/bin/zsh',
    args: [],
    cwd: request.cwd || process.env.HOME || '/',
    cols: 200,
    rows: 50,
    env: {
      ...process.env as Record<string, string>,
      TERM_PROGRAM: 'shogo',
      SHOGO_TERMINAL: '1',
      SHOGO_AGENT_TERMINAL: '1',
    },
  })

  // Track for shutdown cleanup so background terminals don't leak.
  backgroundSessions.add(session.id)

  // Notify renderer immediately so the tab appears.
  const terminalLabel = 'Shogo'
  notifyAgentTerminalSpawned({
    sessionId: session.id,
    terminalLabel,
    cwd: request.cwd ?? session.cwd ?? null,
  })

  // Wait for shell init, then type the command — matching Cursor's UX.
  await new Promise((r) => setTimeout(r, 1500))
  try {
    await host.write(session.id, request.command + '\r')
  } catch (err) {
    console.error('[TerminalExecServer] write to agent terminal failed:', err)
  }

  return {
    exitCode: null,
    output: '',
    cwd: request.cwd ?? null,
    durationMs: null,
    timedOut: false,
    mode: 'background',
    sessionId: session.id,
    terminalLabel,
  }
}

/** Strip ANSI escape sequences from output. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1B[()][AB012]/g, '')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pathsRelated(a: string | null | undefined, b: string): boolean {
  if (!a || !b) return false
  const left = normalizePath(a)
  const right = normalizePath(b)
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function normalizePath(value: string): string {
  return value.replace(/\/+$/, '') || '/'
}

function clampMaxChars(value: number | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_CONTEXT_CHARS
  return Math.max(1_000, Math.min(80_000, Math.floor(value!)))
}
