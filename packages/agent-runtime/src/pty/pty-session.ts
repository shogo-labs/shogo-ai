// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { existsSync } from 'fs'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process'
import { chmodSync } from 'fs'
import { dirname, isAbsolute, relative, resolve } from 'path'
import { fileURLToPath } from 'url'
import type { IPty } from 'node-pty'
import type { PtyShell, PtySignal } from './pty-protocol'

const DEFAULT_SCROLLBACK_BYTES = 64 * 1024
const NODE_PTY_BRIDGE = resolve(dirname(fileURLToPath(import.meta.url)), 'node-pty-bridge.cjs')

export interface PtySessionInit {
  id: string
  cwd: string
  rootDir: string
  cols: number
  rows: number
  shell?: PtyShell
  scrollbackBytes?: number
}

export interface PtyExit {
  exitCode: number | null
  signal: string | null
}

export class PtySession {
  readonly id: string
  readonly cwd: string
  readonly createdAt = Date.now()
  lastAttachedAt = Date.now()
  lastActivityAt = Date.now()
  bytesIn = 0
  bytesOut = 0

  private readonly ptyProcess: PtyProcess
  private readonly scrollbackBytes: number
  private scrollback = ''
  private attached = false
  private exited = false
  private dataHandlers = new Set<(data: string) => void>()
  private exitHandlers = new Set<(exit: PtyExit) => void>()

  private constructor(args: PtySessionInit & { ptyProcess: PtyProcess }) {
    this.id = args.id
    this.cwd = args.cwd
    this.scrollbackBytes = args.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES
    this.ptyProcess = args.ptyProcess

    this.ptyProcess.onData((data) => {
      this.lastActivityAt = Date.now()
      this.bytesOut += Buffer.byteLength(data, 'utf8')
      this.appendScrollback(data)
      for (const handler of this.dataHandlers) handler(data)
    })

    this.ptyProcess.onExit((event) => {
      this.exited = true
      const exit = {
        exitCode: typeof event.exitCode === 'number' ? event.exitCode : null,
        signal: typeof event.signal === 'number' ? String(event.signal) : event.signal ?? null,
      }
      for (const handler of this.exitHandlers) handler(exit)
      this.dataHandlers.clear()
      this.exitHandlers.clear()
    })
  }

  static async create(args: PtySessionInit): Promise<PtySession> {
    const cwd = pickExistingCwd(args.cwd, args.rootDir)
    const shell = resolveShell(args.shell)
    const options = {
      name: 'xterm-256color',
      cols: args.cols,
      rows: args.rows,
      cwd,
      // Do not leak the runtime pod's full environment into an interactive
      // shell. The runtime may hold AI/API tokens; the terminal gets only the
      // minimum process environment needed for normal CLI behavior.
      env: buildSafePtyEnv(args.rootDir, shell.executable),
    }
    const ptyProcess = process.versions.bun && process.env.NODE_ENV !== 'test'
      ? await createNodeBridgePty(shell.executable, shell.args, options)
      : await createNativePty(shell.executable, shell.args, options)
    return new PtySession({ ...args, cwd, ptyProcess })
  }

  attach(): { ok: true; scrollback: string } | { ok: false; reason: 'attached' | 'exited' } {
    if (this.exited) return { ok: false, reason: 'exited' }
    if (this.attached) return { ok: false, reason: 'attached' }
    this.attached = true
    this.lastAttachedAt = Date.now()
    return { ok: true, scrollback: this.scrollback }
  }

  detach(): void {
    this.attached = false
    this.lastActivityAt = Date.now()
  }

  onData(handler: (data: string) => void): () => void {
    this.dataHandlers.add(handler)
    return () => this.dataHandlers.delete(handler)
  }

  onExit(handler: (exit: PtyExit) => void): () => void {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
  }

  write(data: string): void {
    if (this.exited) return
    this.lastActivityAt = Date.now()
    this.bytesIn += Buffer.byteLength(data, 'utf8')
    this.ptyProcess.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return
    this.lastActivityAt = Date.now()
    this.ptyProcess.resize(cols, rows)
  }

  signal(signal: PtySignal): void {
    if (this.exited) return
    if (signal === 'EOF') {
      this.ptyProcess.write('\x04')
      return
    }
    if (signal === 'SIGINT') {
      this.ptyProcess.write('\x03')
      return
    }
    this.kill(signal)
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.exited) return
    this.ptyProcess.kill(signal)
  }

  isExited(): boolean {
    return this.exited
  }

  isAttached(): boolean {
    return this.attached
  }

  getStats(): { bytesIn: number; bytesOut: number; durationMs: number; idleMs: number } {
    const now = Date.now()
    return {
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      durationMs: now - this.createdAt,
      idleMs: now - this.lastActivityAt,
    }
  }

  private appendScrollback(data: string): void {
    this.scrollback += data
    if (Buffer.byteLength(this.scrollback, 'utf8') <= this.scrollbackBytes) return
    while (Buffer.byteLength(this.scrollback, 'utf8') > this.scrollbackBytes) {
      const nextNewline = this.scrollback.indexOf('\n')
      if (nextNewline === -1) {
        this.scrollback = trimUtf8ToBytes(this.scrollback, this.scrollbackBytes)
        return
      }
      this.scrollback = this.scrollback.slice(nextNewline + 1)
    }
  }
}

type PtyProcess = Pick<IPty, 'onData' | 'onExit' | 'write' | 'resize' | 'kill'>

type PtySpawnOptions = {
  name: string
  cols: number
  rows: number
  cwd: string
  env: NodeJS.ProcessEnv
}

type ResolvedShell = {
  executable: string
  args: string[]
}

async function createNativePty(file: string, args: string[], options: PtySpawnOptions): Promise<PtyProcess> {
  const pty = await import('node-pty')
  return pty.spawn(file, args, options)
}

function createNodeBridgePty(file: string, args: string[], options: PtySpawnOptions): Promise<PtyProcess> {
  ensureNodePtyHelperExecutable()

  const child = spawn('node', [NODE_PTY_BRIDGE, JSON.stringify({ file, args, options })], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  })
  const bridge = new NodeBridgePty(child)
  return bridge.ready
}

function ensureNodePtyHelperExecutable(): void {
  if (process.platform !== 'darwin') return
  try {
    const helper = resolve(
      dirname(fileURLToPath(import.meta.resolve('node-pty/package.json'))),
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper',
    )
    if (existsSync(helper)) chmodSync(helper, 0o755)
  } catch {
    // If resolution fails, let node-pty report the native load/spawn error.
  }
}

function resolveShell(requested?: PtyShell): ResolvedShell {
  if (process.platform === 'win32') return resolveWindowsShell(requested)
  const shell = requested === 'zsh' || requested === 'sh' || requested === 'bash' ? requested : 'bash'
  const executable = shell === 'zsh' ? '/bin/zsh' : shell === 'sh' ? '/bin/sh' : pickUnixShell('/bin/bash', '/bin/sh')
  return { executable, args: ['-l'] }
}

function resolveWindowsShell(requested?: PtyShell): ResolvedShell {
  if (requested === 'cmd') return { executable: process.env.ComSpec || 'cmd.exe', args: [] }
  if (requested === 'powershell') return { executable: resolveWindowsExecutable('powershell.exe'), args: ['-NoLogo'] }
  if (requested === 'pwsh') return { executable: resolveWindowsExecutable('pwsh.exe', 'powershell.exe'), args: ['-NoLogo'] }
  const executable = resolveWindowsExecutable('pwsh.exe', 'powershell.exe', process.env.ComSpec || 'cmd.exe')
  return executable.toLowerCase().endsWith('cmd.exe')
    ? { executable, args: [] }
    : { executable, args: ['-NoLogo'] }
}

function resolveWindowsExecutable(...candidates: string[]): string {
  for (const candidate of candidates) {
    if (candidate && commandExists(candidate)) return candidate
  }
  return candidates[candidates.length - 1] || 'cmd.exe'
}

function commandExists(command: string): boolean {
  if (command.includes('\\') || command.includes('/')) return existsSync(command)
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'command', process.platform === 'win32' ? [command] : ['-v', command], {
    stdio: 'ignore',
  })
  return result.status === 0
}

function pickUnixShell(primary: string, fallback: string): string {
  return existsSync(primary) ? primary : fallback
}

class NodeBridgePty implements PtyProcess {
  readonly ready: Promise<PtyProcess>
  private dataHandlers = new Set<(data: string) => void>()
  private exitHandlers = new Set<(exit: { exitCode: number; signal?: number }) => void>()
  private buffer = ''
  private settled = false

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.ready = new Promise((resolveReady, rejectReady) => {
      const failReady = (err: Error) => {
        if (this.settled) return
        this.settled = true
        rejectReady(err)
      }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        this.buffer += chunk
        let newline = this.buffer.indexOf('\n')
        while (newline !== -1) {
          const line = this.buffer.slice(0, newline)
          this.buffer = this.buffer.slice(newline + 1)
          this.handleBridgeLine(line, resolveReady, failReady)
          newline = this.buffer.indexOf('\n')
        }
      })

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        if (!this.settled) failReady(new Error(chunk.trim() || 'PTY bridge failed'))
        else process.stderr.write(`[node-pty-bridge] ${chunk}`)
      })

      child.on('error', failReady)
      child.on('exit', (code, signal) => {
        if (!this.settled) {
          failReady(new Error(`PTY bridge exited before ready: code=${code} signal=${signal}`))
          return
        }
        const exit = { exitCode: typeof code === 'number' ? code : 0, signal: 0 }
        for (const handler of this.exitHandlers) handler(exit)
        this.dataHandlers.clear()
        this.exitHandlers.clear()
      })
    })
  }

  onData(handler: (data: string) => void): { dispose: () => void } {
    this.dataHandlers.add(handler)
    return { dispose: () => this.dataHandlers.delete(handler) }
  }

  onExit(handler: (exit: { exitCode: number; signal?: number }) => void): { dispose: () => void } {
    this.exitHandlers.add(handler)
    return { dispose: () => this.exitHandlers.delete(handler) }
  }

  write(data: string): void {
    this.send({ type: 'write', data })
  }

  resize(cols: number, rows: number): void {
    this.send({ type: 'resize', cols, rows })
  }

  kill(signal?: string): void {
    const nextSignal = (signal ?? 'SIGTERM') as NodeJS.Signals
    this.send({ type: 'kill', signal: nextSignal })
    this.child.stdin.end()
    if (this.child.exitCode === null) this.child.kill(nextSignal)
  }

  private handleBridgeLine(
    line: string,
    resolveReady: (pty: PtyProcess) => void,
    rejectReady: (err: Error) => void,
  ): void {
    if (!line) return
    let message: any
    try {
      message = JSON.parse(line)
    } catch {
      return
    }

    if (message.type === 'ready') {
      this.settled = true
      resolveReady(this)
    } else if (message.type === 'data' && typeof message.data === 'string') {
      for (const handler of this.dataHandlers) handler(message.data)
    } else if (message.type === 'exit') {
      for (const handler of this.exitHandlers) handler({
        exitCode: typeof message.exitCode === 'number' ? message.exitCode : 0,
        signal: typeof message.signal === 'number' ? message.signal : 0,
      })
    } else if (message.type === 'error') {
      const err = new Error(typeof message.message === 'string' ? message.message : 'PTY bridge error')
      if (!this.settled) rejectReady(err)
      else throw err
    }
  }

  private send(message: unknown): void {
    if (this.child.stdin.destroyed) return
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }
}

function pickExistingCwd(candidate: string | undefined, rootDir: string): string {
  const root = resolve(rootDir)
  if (!candidate) return root
  const abs = resolve(root, candidate)
  const rel = relative(root, abs)
  const insideRoot = abs === root || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
  return insideRoot && existsSync(abs) ? abs : root
}

function buildSafePtyEnv(rootDir: string, shell: string): NodeJS.ProcessEnv {
  if (process.platform === 'win32') {
    return {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      HOME: rootDir,
      PWD: rootDir,
      SHELL: shell,
      USERPROFILE: rootDir,
      USERNAME: process.env.USERNAME || 'appuser',
      USER: process.env.USER || process.env.USERNAME || 'appuser',
      LOGNAME: process.env.LOGNAME || process.env.USERNAME || 'appuser',
      PATH: process.env.PATH || '',
      Path: process.env.Path,
      PATHEXT: process.env.PATHEXT,
      SystemRoot: process.env.SystemRoot,
      ComSpec: process.env.ComSpec,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      SHOGO_PTY: '1',
    }
  }

  return {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    HOME: rootDir,
    PWD: rootDir,
    SHELL: shell,
    USER: 'appuser',
    LOGNAME: 'appuser',
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || 'C.UTF-8',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    SHOGO_PTY: '1',
  }
}

function trimUtf8ToBytes(input: string, maxBytes: number): string {
  let bytes = 0
  const kept: string[] = []
  const chars = Array.from(input)
  for (let i = chars.length - 1; i >= 0; i--) {
    const char = chars[i]
    const nextBytes = Buffer.byteLength(char, 'utf8')
    if (bytes + nextBytes > maxBytes) break
    kept.push(char)
    bytes += nextBytes
  }
  return kept.reverse().join('')
}
