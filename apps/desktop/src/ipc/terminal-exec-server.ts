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
import type { ControlEvent, SessionInfo } from '../pty-host/protocol'

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
let serverReady: Promise<string> | null = null
let offTerminalEvents: (() => void) | null = null
let terminalEventsSubscribing = false

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

/**
 * Start the terminal exec HTTP server. Returns the URL to pass
 * to the agent-runtime via TERMINAL_EXEC_URL env var.
 */
export function startTerminalExecServer(): Promise<string> {
  if (server && port > 0) return Promise.resolve(`http://127.0.0.1:${port}`)
  if (serverReady) return serverReady

  ensureTerminalEventSubscription()

  server = createServer(async (req, res) => {
    // CORS — allow the agent-runtime child process
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
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

      const result = await executeViaRenderer(request)
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
    serverReady = null
    if (offTerminalEvents) {
      offTerminalEvents()
      offTerminalEvents = null
    }
    terminalEventsSubscribing = false
    terminalBuffers.clear()
    console.log('[TerminalExecServer] Stopped')
  }
}

/**
 * Get the current port (0 if not running).
 */
export function getTerminalExecPort(): number {
  return port
}

// ─── renderer bridge ────────────────────────────────────────────────────

/**
 * Execute a command in the renderer's terminal via IPC.
 *
 * Flow:
 *   main process → ipcRenderer.invoke(request)
 *   renderer → TerminalCommandExecutor.execute(request)
 *   result → back to main process
 *
 * Falls back to spawning the command directly via PTY host if
 * the renderer is not available (e.g., during startup).
 */
async function executeViaRenderer(request: TerminalExecRequest): Promise<TerminalExecResponse> {
  // Electron doesn't have webContents.invoke() — we can't call the renderer
  // from the main process. Instead, execute directly via the PTY host, which
  // runs in the main process and has full access to the user's shell.
  //
  // The renderer-side bridge (AgentTerminalBridge → TerminalCommandExecutor)
  // can be used for future UI-visible agent terminals, but for the gateway
  // tool, PTY host is the correct execution path.
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
    // ── Write to the user's visible terminal ──
    const sessionId = activeSession.id
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
  }

  return executeHiddenOneShot(request, timeoutMs, startMs)
}

// ─── helpers ────────────────────────────────────────────────────────────

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
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

  const buffered = terminalBuffers.get(target.id)
  const raw = buffered?.chunks.join('') ?? ''
  const maxChars = clampMaxChars(request.maxChars)
  const plain = stripAnsi(raw)
  const truncated = plain.length > maxChars
  const content = truncated ? plain.slice(plain.length - maxChars) : plain

  return {
    source: 'desktop-pty',
    terminalId: target.id,
    cwd: target.cwd,
    content,
    sessions,
    truncated,
    ...(content
      ? {}
      : { hint: 'The terminal exists, but no output has reached the desktop context buffer yet.' }),
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
  const startMs = Date.now()

  // Build the terminal label
  const maxLen = 50
  const display = request.command.length > maxLen
    ? request.command.slice(0, maxLen) + '...'
    : request.command
  const terminalLabel = `Shogo (${display})`

  // Spawn a new session labeled as agent terminal
  const session = await host.spawn({
    shell: process.env.SHELL || '/bin/zsh',
    args: ['-l', '-c', request.command],
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
