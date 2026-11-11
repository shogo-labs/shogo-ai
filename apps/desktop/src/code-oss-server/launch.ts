// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Start the prebuilt Shogo IDE server (Code - OSS REH-web) for one workspace.
 * Electron-free so it can be unit tested.
 *
 * The server's own `node[.exe]` runs `out/server-main.js` directly: no
 * `code-server.bat` / `.sh` (spawning a .bat without a shell fails with EINVAL
 * on current Node), no dev-mode `VSCODE_DEV`, and only flags the server
 * accepts (it silently ignores desktop-only ones).
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { spawn as defaultSpawn } from '../child-process'

/** Every flag `buildServerArgs` may emit. All are server options at the pinned commit. */
export const SERVER_FLAG_ALLOWLIST: ReadonlySet<string> = new Set([
  '--host',
  '--port',
  '--connection-token-file',
  '--accept-server-license-terms',
  '--disable-telemetry',
  '--disable-workspace-trust',
  '--user-data-dir',
  '--extensions-dir',
  '--server-data-dir',
])

export const SERVER_HOST = '127.0.0.1'
const READY_TIMEOUT_MS = 60_000
const OUTPUT_TAIL_LINES = 20

export interface ServerProfile {
  profileDir: string
  userDataDir: string
  extensionsDir: string
  serverDataDir: string
}

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface StartServerOptions {
  serverDir: string
  profile: ServerProfile
  portRange: readonly [number, number]
  env?: NodeJS.ProcessEnv
  /** Defaults to the server's bundled node. Tests substitute their runtime. */
  nodeBinary?: string
  spawnImpl?: SpawnFn
  fetchImpl?: typeof fetch
  readyTimeoutMs?: number
  log?: (line: string) => void
  platform?: NodeJS.Platform
}

export interface RunningServer {
  proc: ChildProcess
  port: number
  token: string
  workbenchUrl(workspacePath: string): string
}

export function serverNodeBinary(serverDir: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(serverDir, platform === 'win32' ? 'node.exe' : 'node')
}

export function buildServerArgs(opts: { serverDir: string; port: number; tokenFile: string; profile: ServerProfile }): string[] {
  return [
    path.join(opts.serverDir, 'out', 'server-main.js'),
    '--host', SERVER_HOST,
    '--port', String(opts.port),
    '--connection-token-file', opts.tokenFile,
    '--accept-server-license-terms',
    '--disable-telemetry',
    '--disable-workspace-trust',
    '--user-data-dir', opts.profile.userDataDir,
    '--extensions-dir', opts.profile.extensionsDir,
    '--server-data-dir', opts.profile.serverDataDir,
  ]
}

/**
 * The `folder` query value. The web client treats a value starting with `/`
 * as a path on the server; anything else is parsed as a URI, so a bare
 * `C:\Users\...` would become scheme `c`. Windows paths become `/c:/Users/...`.
 */
export function workspaceFolderQuery(workspacePath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return workspacePath
  const forward = workspacePath.replace(/\\/g, '/')
  return forward.startsWith('/') ? forward : `/${forward}`
}

export function buildWorkbenchUrl(
  port: number,
  token: string,
  workspacePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const url = new URL(`http://${SERVER_HOST}:${port}/`)
  url.searchParams.set('tkn', token)
  url.searchParams.set('folder', workspaceFolderQuery(workspacePath, platform))
  return url.toString()
}

/** The profile's connection token, created once (32 random bytes, hex, owner-only). */
export function ensureConnectionToken(profileDir: string): { token: string; tokenFile: string } {
  const tokenFile = path.join(profileDir, 'token')
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(existing)) return { token: existing, tokenFile }
  } catch {
    // first run
  }
  fs.mkdirSync(profileDir, { recursive: true })
  const token = randomBytes(32).toString('hex')
  fs.writeFileSync(tokenFile, token, { mode: 0o600 })
  return { token, tokenFile }
}

function canListen(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(null))
    server.listen(port, SERVER_HOST, () => {
      const address = server.address()
      const bound = typeof address === 'object' && address ? address.port : null
      server.close(() => resolve(bound))
    })
  })
}

/** First free port in the inclusive range, else one the OS assigns. */
export async function pickPort(range: readonly [number, number]): Promise<number> {
  for (let port = range[0]; port <= range[1]; port++) {
    if ((await canListen(port)) !== null) return port
  }
  const assigned = await canListen(0)
  if (assigned === null) throw new Error('No free port for the Shogo IDE server')
  return assigned
}

export function createOutputTail(limit = OUTPUT_TAIL_LINES): { push(chunk: string): void; text(): string } {
  const lines: string[] = []
  let partial = ''
  return {
    push(chunk: string) {
      const parts = (partial + chunk).split(/\r?\n/)
      partial = parts.pop() ?? ''
      for (const line of parts) if (line.trim()) lines.push(line)
      if (lines.length > limit) lines.splice(0, lines.length - limit)
    },
    text() {
      return [...lines, ...(partial.trim() ? [partial] : [])].slice(-limit).join('\n')
    },
  }
}

export async function waitForServer(opts: {
  port: number
  token: string
  proc: ChildProcess
  output: () => string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const deadline = Date.now() + (opts.timeoutMs ?? READY_TIMEOUT_MS)
  while (Date.now() < deadline) {
    if (opts.proc.exitCode !== null || opts.proc.signalCode !== null) {
      throw new Error(
        `The Shogo IDE server exited (${opts.proc.exitCode ?? opts.proc.signalCode}) before it was ready.\n${opts.output()}`.trim(),
      )
    }
    try {
      const res = await fetchImpl(`http://${SERVER_HOST}:${opts.port}/`, {
        headers: { cookie: `vscode-tkn=${opts.token}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(2_000),
      })
      if (res.status === 200) return
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`The Shogo IDE server did not start within ${Math.round((opts.timeoutMs ?? READY_TIMEOUT_MS) / 1000)} s.\n${opts.output()}`.trim())
}

/** Kills the server and the extension hosts it spawned. */
export function killProcessTree(
  proc: ChildProcess,
  platform: NodeJS.Platform = process.platform,
  spawnImpl: SpawnFn = defaultSpawn as SpawnFn,
): void {
  if (proc.pid === undefined || proc.exitCode !== null) return
  if (platform === 'win32') {
    try {
      spawnImpl('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }).once('error', () => proc.kill())
    } catch {
      proc.kill()
    }
    return
  }
  try {
    process.kill(-proc.pid, 'SIGTERM')
  } catch {
    proc.kill('SIGTERM')
  }
}

export async function startCodeOssServer(opts: StartServerOptions): Promise<RunningServer> {
  const platform = opts.platform ?? process.platform
  const nodeBinary = opts.nodeBinary ?? serverNodeBinary(opts.serverDir, platform)
  for (const required of [nodeBinary, path.join(opts.serverDir, 'out', 'server-main.js')]) {
    if (!fs.existsSync(required)) throw new Error(`The Shogo IDE server install is incomplete: ${required} is missing.`)
  }
  for (const dir of [opts.profile.userDataDir, opts.profile.extensionsDir, opts.profile.serverDataDir]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const { token, tokenFile } = ensureConnectionToken(opts.profile.profileDir)
  const port = await pickPort(opts.portRange)
  const args = buildServerArgs({ serverDir: opts.serverDir, port, tokenFile, profile: opts.profile })
  const env = { ...(opts.env ?? process.env) }
  delete env.VSCODE_DEV
  delete env.ELECTRON_RUN_AS_NODE
  opts.log?.(`Starting Shogo IDE server on ${SERVER_HOST}:${port}`)
  const spawnImpl = opts.spawnImpl ?? (defaultSpawn as SpawnFn)
  const proc = spawnImpl(nodeBinary, args, {
    cwd: opts.serverDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group on POSIX so killProcessTree can signal the extension hosts too.
    detached: platform !== 'win32',
  })
  const tail = createOutputTail()
  const onData = (chunk: Buffer) => {
    const text = chunk.toString()
    tail.push(text)
    for (const line of text.split(/\r?\n/)) if (line.trim()) opts.log?.(`[server] ${line}`)
  }
  proc.stdout?.on('data', onData)
  proc.stderr?.on('data', onData)
  const spawnError = new Promise<never>((_, reject) => proc.once('error', reject))
  spawnError.catch(() => {})
  try {
    await Promise.race([
      waitForServer({ port, token, proc, output: () => tail.text(), timeoutMs: opts.readyTimeoutMs, fetchImpl: opts.fetchImpl }),
      spawnError,
    ])
  } catch (error) {
    killProcessTree(proc, platform)
    throw error
  }
  return {
    proc,
    port,
    token,
    workbenchUrl: (workspacePath: string) => buildWorkbenchUrl(port, token, workspacePath, platform),
  }
}
