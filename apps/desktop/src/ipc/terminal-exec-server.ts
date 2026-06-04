// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * terminal-exec-server — tiny HTTP handler for the agent runtime to execute
 * commands in the user's visible terminal.
 *
 * Architecture:
 *
 *   Agent Gateway (child process)
 *     → fetch(POST http://localhost:{port}/terminal/exec)
 *     → terminal-exec-server (this file, in Electron main process)
 *     → ipcMain handler → renderer → AgentTerminalBridge → PTY
 *     → result back to gateway
 *
 * The server listens on a random port and exposes a single endpoint:
 *   POST /terminal/exec { command, cwd?, timeoutMs? }
 *   → { exitCode, output, cwd, durationMs, timedOut }
 *
 * The gateway receives this URL via TERMINAL_EXEC_URL env var, set
 * when the Electron main process spawns the agent-runtime child.
 */

import { createServer, type Server } from 'node:http'

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

const TERMINAL_EXEC_CHANNEL = 'shogo:terminal:exec'

// ─── server ─────────────────────────────────────────────────────────────

let server: Server | null = null
let port: number = 0

/**
 * Start the terminal exec HTTP server. Returns the URL to pass
 * to the agent-runtime via TERMINAL_EXEC_URL env var.
 */
export function startTerminalExecServer(): string {
  if (server) return `http://localhost:${port}`

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

  // Listen on a random available port, bound to localhost only
  server.listen(0, '127.0.0.1', () => {
    const addr = server!.address()
    if (addr && typeof addr === 'object') {
      port = addr.port
      console.log(`[TerminalExecServer] Listening on http://127.0.0.1:${port}`)
    }
  })

  return `http://localhost:${port}`
}

/**
 * Stop the terminal exec HTTP server.
 */
export function stopTerminalExecServer(): void {
  if (server) {
    server.close()
    server = null
    port = 0
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

  // Find the user's active terminal session
  const sessions = await host.list()
  const activeSession = sessions.length > 0 ? sessions[0] : null

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

    // Collect output from this session
    const dataHandler = (data: any) => {
      if (data.sessionId === sessionId && data.type === 'data') {
        // Stop collecting after we see the sentinel (command done)
        if (!data.data.includes(sentinel)) {
          output += data.data
        }
      }
    }

    host.on('event', dataHandler)

    try {
      // Write the command followed by a sentinel echo to detect completion
      await host.write(sessionId, `${request.command} ; echo "${sentinel}"\n`)

      // Wait for sentinel to appear in output, or timeout
      const deadline = startMs + timeoutMs
      while (!output.includes(sentinel) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
      }

      // Extract output before the sentinel
      const sentinelIdx = output.indexOf(sentinel)
      if (sentinelIdx >= 0) {
        output = output.substring(0, sentinelIdx)
        exitCode = 0 // Command completed (sentinel ran after it)
      }

      if (exitCode === null) {
        timedOut = true
        exitCode = null
        output += '\n[Timed out after ' + timeoutMs + 'ms]'
      }

      return {
        exitCode,
        output: stripAnsi(output),
        cwd: request.cwd ?? null,
        durationMs: Date.now() - startMs,
        timedOut,
      }
    } finally {
      host.removeListener('event', dataHandler)
    }
  }

  // ── Fallback: no active session — spawn a hidden one-shot ──
  const session = await host.spawn({
    shell: process.env.SHELL || '/bin/zsh',
    args: ['-l'],
    cwd: request.cwd || process.env.HOME || '/',
    cols: 200,
    rows: 50,
    env: {
      ...process.env as Record<string, string>,
      TERM_PROGRAM: 'shogo',
      SHOGO_TERMINAL: '1',
    },
  })

  const sessionId = session.id
  let output = ''
  let exitCode: number | null = null
  let timedOut = false

  const dataHandler = (data: any) => {
    if (data.sessionId === sessionId && data.type === 'data') {
      output += data.data
    }
  }

  const exitHandler = (data: any) => {
    if (data.sessionId === sessionId) {
      exitCode = data.exitCode ?? 1
    }
  }

  host.on('event', dataHandler)
  host.on('event', exitHandler)

  await host.write(sessionId, `${request.command}\n`)

  const deadline = startMs + timeoutMs
  while (exitCode === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }

  if (exitCode === null) {
    timedOut = true
    exitCode = null
    output += '\n[Timed out after ' + timeoutMs + 'ms]'
  }

  host.removeListener('event', dataHandler)
  host.removeListener('event', exitHandler)
  try { await host.kill(sessionId) } catch { /* already dead */ }

  return {
    exitCode,
    output: stripAnsi(output),
    cwd: request.cwd ?? null,
    durationMs: Date.now() - startMs,
    timedOut,
  }
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
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\].*?\x07/g, '')
}
