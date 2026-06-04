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
}

interface TerminalExecResponse {
  exitCode: number | null
  output: string
  cwd: string | null
  durationMs: number | null
  timedOut: boolean
  error?: string
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
 * Fallback: execute a command directly via the PTY host.
 * Used when the renderer doesn't handle the terminal:exec channel.
 */
async function executeViaPtyHost(request: TerminalExecRequest): Promise<TerminalExecResponse> {
  const { getPtyHostClient } = await import('../pty-host-client')
  const host = getPtyHostClient()
  const startMs = Date.now()
  const timeoutMs = request.timeoutMs ?? 120_000

  // Spawn a one-shot terminal session
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

  // Collect output
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

  // Send the command + exit sentinel
  await host.write(sessionId, `${request.command}\n`)

  // Wait for completion or timeout
  const deadline = startMs + timeoutMs
  while (exitCode === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }

  if (exitCode === null) {
    timedOut = true
    exitCode = null
    output += '\n[Timed out after ' + timeoutMs + 'ms]'
  }

  // Clean up
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

/** Strip ANSI escape sequences from output. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\].*?\x07/g, '')
}
