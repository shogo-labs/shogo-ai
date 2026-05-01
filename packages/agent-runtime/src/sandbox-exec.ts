// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Docker Sandbox Execution
 *
 * Wraps shell commands in ephemeral Docker containers for isolation.
 * Non-main sessions run commands inside a sandboxed container with:
 * - Workspace directory mounted read-write
 * - No network by default
 * - Resource limits (memory, CPU)
 * - Automatic container cleanup (--rm)
 */

import { execSync, spawn, type ChildProcess } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { SandboxConfig } from './types'

// ---------------------------------------------------------------------------
// Windows shell resolution — use Git Bash when available so Unix commands
// (head, tail, grep, find, cat, wc, xargs, pipes …) work transparently.
// ---------------------------------------------------------------------------

let _resolvedShell: string | undefined | false = false // false = not yet resolved

function resolveShell(): string | undefined {
  if (_resolvedShell !== false) return _resolvedShell || undefined

  if (process.platform !== 'win32') {
    _resolvedShell = undefined
    return undefined
  }

  const candidates = [
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      _resolvedShell = candidate
      return candidate
    }
  }

  // Last resort: check PATH
  try {
    const result = execSync('where.exe bash', { encoding: 'utf-8', timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    const firstLine = result.split('\n')[0]?.trim()
    if (firstLine && existsSync(firstLine)) {
      _resolvedShell = firstLine
      return firstLine
    }
  } catch {}

  _resolvedShell = undefined
  return undefined
}

// Project-scoped env vars that are safe for the agent to read.
// These are derived per-project (HMAC of projectId + signing secret),
// so even if the agent reads them, the blast radius is zero.
const PROJECT_SCOPED_SAFE = new Set([
  'RUNTIME_AUTH_SECRET',
  'WEBHOOK_TOKEN',
])

// Env vars that must never leak to agent-spawned child processes.
// Patterns are matched case-insensitively against env var names.
// Defense-in-depth: even if purgeSecretsFromEnv() already removed them from
// process.env, this list catches anything that was re-injected or missed.
const REDACTED_ENV_PATTERNS = [
  /^BETTER_AUTH_SECRET$/i,
  /^AI_PROXY_SECRET$/i,
  /^PREVIEW_TOKEN_SECRET$/i,
  /^ANTHROPIC_API_KEY$/i,
  /^OPENAI_API_KEY$/i,
  /^STRIPE_SECRET_KEY$/i,
  /^STRIPE_WEBHOOK_SECRET$/i,
  /^GH_APP_CLIENT_SECRET$/i,
  /^GH_APP_PRIVATE_KEY$/i,
  /^GH_APP_WEBHOOK_SECRET$/i,
  /^COMPOSIO_API_KEY$/i,
  /^SERPER_API_KEY$/i,
  /^GOOGLE_CLIENT_SECRET$/i,
  /^AWS_SECRET_ACCESS_KEY$/i,
  /^DATABASE_URL$/i,
  /^PROJECTS_DATABASE_URL$/i,
  /SECRET/i,
  /PRIVATE_KEY/i,
  /INGESTION_KEY/i,
  /_TOKEN$/i,
  /API_KEY$/i,
]

function isRedacted(key: string): boolean {
  if (PROJECT_SCOPED_SAFE.has(key)) return false
  return REDACTED_ENV_PATTERNS.some((p) => p.test(key))
}

// Keys to capture into JS variables then delete from process.env.
// After purgeSecretsFromEnv() runs, these are no longer visible to
// child processes, `env`, `printenv`, or `echo $VAR`.
const PURGE_KEYS = [
  'BETTER_AUTH_SECRET',
  'AI_PROXY_SECRET',
  'PREVIEW_TOKEN_SECRET',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'GH_APP_CLIENT_SECRET',
  'GH_APP_PRIVATE_KEY',
  'GH_APP_WEBHOOK_SECRET',
  'COMPOSIO_API_KEY',
  'SERPER_API_KEY',
  'GOOGLE_CLIENT_SECRET',
  'AWS_SECRET_ACCESS_KEY',
  'DATABASE_URL',
  'PROJECTS_DATABASE_URL',
  'SIGNOZ_INGESTION_KEY',
]

const capturedSecrets = new Map<string, string>()

/**
 * Capture secrets into memory then delete them from process.env.
 * Call once at startup, after all modules that read env directly have loaded.
 * Captured values are retrievable via getCapturedSecret().
 */
export function purgeSecretsFromEnv(): void {
  for (const key of PURGE_KEYS) {
    const val = process.env[key]
    if (val !== undefined) {
      capturedSecrets.set(key, val)
      delete process.env[key]
    }
  }
  // Also purge any remaining env vars that match the broad patterns
  for (const key of Object.keys(process.env)) {
    if (isRedacted(key)) {
      if (!capturedSecrets.has(key) && process.env[key] !== undefined) {
        capturedSecrets.set(key, process.env[key]!)
      }
      delete process.env[key]
    }
  }
}

/** Retrieve a secret that was captured before purging. */
export function getCapturedSecret(key: string): string | undefined {
  return capturedSecrets.get(key)
}

export function getSanitizedEnv(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!isRedacted(key)) {
      clean[key] = value
    }
  }
  return clean
}

/**
 * Load user-provided env vars from the workspace .env file.
 * These are intentionally merged AFTER getSanitizedEnv() so that
 * tokens the user explicitly saved (e.g. GITHUB_TOKEN) are available
 * to CLI tools even though the redaction patterns would normally strip them.
 */
export function loadWorkspaceEnv(workspaceDir: string): Record<string, string> {
  const envPath = join(workspaceDir, '.env')
  if (!existsSync(envPath)) return {}
  try {
    const content = readFileSync(envPath, 'utf-8')
    const vars: Record<string, string> = {}
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx < 0) continue
      const key = trimmed.slice(0, eqIdx).trim()
      let val = trimmed.slice(eqIdx + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      if (key) vars[key] = val
    }
    return vars
  } catch {
    return {}
  }
}

// Probe `docker` once per process. The previous heuristic
// (SANDBOX_EXEC_ENABLED || KUBERNETES_SERVICE_HOST) blindly assumed a
// docker binary was on PATH, which is false on the agent-runtime pod
// itself: it ships Bun + Node, not Docker. When the probe fails we
// disable sandboxing so the exec tool falls back to in-process exec
// instead of returning the cryptic `/bin/sh: 1: docker: not found`.
let _dockerAvailable: boolean | undefined
function isDockerAvailable(): boolean {
  if (_dockerAvailable !== undefined) return _dockerAvailable
  try {
    execSync('docker version --format "{{.Server.Version}}"', {
      timeout: 2_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    _dockerAvailable = true
  } catch {
    _dockerAvailable = false
    if (process.env.SANDBOX_EXEC_ENABLED === 'true' || process.env.KUBERNETES_SERVICE_HOST) {
      console.warn(
        '[sandbox-exec] SANDBOX_EXEC_ENABLED/KUBERNETES_SERVICE_HOST set but `docker` not on PATH. ' +
          'Falling back to in-process exec. Set SANDBOX_EXEC_ENABLED=false to silence this warning.',
      )
    }
  }
  return _dockerAvailable
}

function defaultSandboxConfig(): SandboxConfig {
  const requested = process.env.SANDBOX_EXEC_ENABLED === 'true' || !!process.env.KUBERNETES_SERVICE_HOST
  return {
    enabled: requested && isDockerAvailable(),
    mode: 'non-main',
    image: process.env.SANDBOX_IMAGE || 'ubuntu:22.04',
    networkEnabled: false,
    memoryLimit: '256m',
    cpuLimit: '0.5',
  }
}

export interface SandboxExecOptions {
  command: string
  workspaceDir: string
  timeout?: number
  sandboxConfig?: Partial<SandboxConfig>
  sessionId?: string
  mainSessionIds?: string[]
}

export interface SandboxExecResult {
  stdout: string
  stderr: string
  exitCode: number
  sandboxed: boolean
}

// Internal runtime env vars that must not leak to agent-spawned child
// processes.  PORT / VITE_PORT are set by RuntimeManager for the agent
// server itself; if they leak, user servers try to bind the same port
// → EADDRINUSE.  Workspace .env values are merged *after* stripping
// so explicit user PORT overrides still take effect.
export const RUNTIME_ONLY_VARS = ['PORT', 'VITE_PORT']

export function stripRuntimeVars(env: Record<string, string | undefined>): typeof env {
  for (const key of RUNTIME_ONLY_VARS) delete env[key]
  return env
}

export function shouldSandbox(opts: SandboxExecOptions): boolean {
  const config = { ...defaultSandboxConfig(), ...opts.sandboxConfig }
  if (!config.enabled) return false

  if (config.mode === 'all') return true

  if (config.mode === 'non-main' && opts.sessionId) {
    const mainIds = opts.mainSessionIds || []
    return !mainIds.includes(opts.sessionId)
  }

  return false
}

export function sandboxExec(opts: SandboxExecOptions): SandboxExecResult {
  const useSandbox = shouldSandbox(opts)

  if (!useSandbox) {
    return nativeExec(opts.command, opts.workspaceDir, opts.timeout)
  }

  const config = { ...defaultSandboxConfig(), ...opts.sandboxConfig }

  const dockerArgs = [
    'docker', 'run', '--rm',
    '-v', `${opts.workspaceDir}:/workspace`,
    '-w', '/workspace',
    '--memory', config.memoryLimit,
    '--cpus', config.cpuLimit,
    '--pids-limit', '256',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
  ]

  if (!config.networkEnabled) {
    dockerArgs.push('--network', 'none')
  }

  const workspaceEnv = loadWorkspaceEnv(opts.workspaceDir)
  for (const [key, val] of Object.entries(workspaceEnv)) {
    dockerArgs.push('-e', `${key}=${val}`)
  }

  dockerArgs.push(config.image, 'bash', '-c', opts.command)

  try {
    const stdout = execSync(dockerArgs.join(' '), {
      timeout: opts.timeout || 300_000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
      env: stripRuntimeVars(getSanitizedEnv()),
    })
    return { stdout: stdout.trim(), stderr: '', exitCode: 0, sandboxed: true }
  } catch (err: any) {
    return {
      stdout: err.stdout?.trim() || '',
      stderr: err.stderr?.trim() || '',
      exitCode: err.status ?? 1,
      sandboxed: true,
    }
  }
}

function nativeExec(command: string, cwd: string, timeout?: number): SandboxExecResult {
  const shell = resolveShell()
  try {
    const baseEnv = stripRuntimeVars(getSanitizedEnv())
    const stdout = execSync(command, {
      cwd,
      timeout: timeout || 300_000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
      env: { ...baseEnv, ...loadWorkspaceEnv(cwd) },
      ...(shell ? { shell } : {}),
    })
    return { stdout: stdout.trim(), stderr: '', exitCode: 0, sandboxed: false }
  } catch (err: any) {
    return {
      stdout: err.stdout?.trim() || '',
      stderr: err.stderr?.trim() || '',
      exitCode: err.status ?? 1,
      sandboxed: false,
    }
  }
}

// ===========================================================================
// Async / soft-timeout exec primitive
// ---------------------------------------------------------------------------
// `sandboxExecAsync` is the spawn-based counterpart of `sandboxExec`. It
// returns a `CommandHandle` so callers can race a soft timeout against
// completion without killing the underlying process. Output is accumulated
// in bounded ring buffers so a runaway log producer can't OOM the runtime.
// ===========================================================================

/** Default absolute kill ceiling for backgrounded runs (10 min). */
const DEFAULT_HARD_TIMEOUT_MS = 600_000

/** Per-stream buffer cap. When exceeded we keep head + tail and drop the middle. */
const MAX_STREAM_BUFFER_BYTES = 64 * 1024

function getHardTimeoutMs(): number {
  const env = parseInt(process.env.SHOGO_EXEC_HARD_TIMEOUT_MS || '', 10)
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_HARD_TIMEOUT_MS
}

/**
 * Bounded text buffer that keeps the head and tail of a stream when it
 * grows beyond `maxBytes`. The middle is collapsed into a marker so the
 * caller can still see start-of-run banners and end-of-run errors.
 */
class BoundedBuffer {
  private head = ''
  private tail = ''
  private droppedBytes = 0
  private readonly headSize: number
  private readonly tailSize: number

  constructor(maxBytes: number = MAX_STREAM_BUFFER_BYTES) {
    this.headSize = Math.floor(maxBytes * 0.5)
    this.tailSize = maxBytes - this.headSize
  }

  push(chunk: string): void {
    if (!chunk) return
    if (this.head.length < this.headSize) {
      const room = this.headSize - this.head.length
      if (chunk.length <= room) {
        this.head += chunk
        return
      }
      this.head += chunk.slice(0, room)
      chunk = chunk.slice(room)
    }
    this.tail += chunk
    if (this.tail.length > this.tailSize) {
      const overflow = this.tail.length - this.tailSize
      this.droppedBytes += overflow
      this.tail = this.tail.slice(overflow)
    }
  }

  toString(): string {
    if (this.droppedBytes === 0) return this.head + this.tail
    return `${this.head}\n\n... [${this.droppedBytes} bytes dropped from middle] ...\n\n${this.tail}`
  }
}

export interface CommandHandle {
  /** Native pid for non-sandboxed runs, the docker CLI pid otherwise. */
  pid: number | undefined
  /** Sandbox container name when sandboxed (use `docker kill <name>` to terminate). */
  containerName?: string
  sandboxed: boolean
  /** Snapshot accumulated stdout so far (truncated head/tail when very large). */
  stdout: () => string
  /** Snapshot accumulated stderr so far. */
  stderr: () => string
  /** Resolves once the child process has exited (cleanly, killed, or timed out). */
  done: Promise<{ exitCode: number; stdout: string; stderr: string; killed: boolean; timedOut: boolean }>
  /** Send a termination signal. SIGTERM is graceful, SIGKILL is forceful. */
  kill: (signal?: 'SIGTERM' | 'SIGKILL') => void
  /** True once the child has exited. */
  exited: () => boolean
  startedAt: number
}

export interface SandboxExecAsyncOptions extends SandboxExecOptions {
  /**
   * Absolute lifetime cap. After this many ms the run is forcibly SIGKILLed
   * even if no caller has asked for it. Defaults to SHOGO_EXEC_HARD_TIMEOUT_MS
   * env var or 10 minutes.
   */
  hardTimeoutMs?: number
}

/**
 * Spawn a command and return a CommandHandle. Output is captured into bounded
 * buffers; the returned `done` promise resolves when the child exits.
 *
 * The caller is responsible for racing `done` against any soft timeout it
 * wants to expose to the agent — this primitive never returns "still running".
 */
export function sandboxExecAsync(opts: SandboxExecAsyncOptions): CommandHandle {
  const useSandbox = shouldSandbox(opts)
  const startedAt = Date.now()
  const hardTimeout = opts.hardTimeoutMs ?? getHardTimeoutMs()

  const stdoutBuf = new BoundedBuffer()
  const stderrBuf = new BoundedBuffer()

  let child: ChildProcess
  let containerName: string | undefined

  if (useSandbox) {
    const config = { ...defaultSandboxConfig(), ...opts.sandboxConfig }
    containerName = `shogo-exec-${randomBytes(6).toString('hex')}`

    const dockerArgs = [
      'run', '--rm',
      '--name', containerName,
      '-v', `${opts.workspaceDir}:/workspace`,
      '-w', '/workspace',
      '--memory', config.memoryLimit,
      '--cpus', config.cpuLimit,
      '--pids-limit', '256',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
    ]
    if (!config.networkEnabled) {
      dockerArgs.push('--network', 'none')
    }
    const workspaceEnv = loadWorkspaceEnv(opts.workspaceDir)
    for (const [key, val] of Object.entries(workspaceEnv)) {
      dockerArgs.push('-e', `${key}=${val}`)
    }
    dockerArgs.push(config.image, 'bash', '-c', opts.command)

    child = spawn('docker', dockerArgs, {
      env: stripRuntimeVars(getSanitizedEnv()),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } else {
    const shell = resolveShell()
    const baseEnv = stripRuntimeVars(getSanitizedEnv())
    const env = { ...baseEnv, ...loadWorkspaceEnv(opts.workspaceDir) }

    if (shell) {
      child = spawn(shell, ['-c', opts.command], {
        cwd: opts.workspaceDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } else {
      child = spawn(opts.command, {
        cwd: opts.workspaceDir,
        env,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    }
  }

  let killed = false
  let timedOut = false
  let exited = false

  child.stdout?.setEncoding('utf-8')
  child.stderr?.setEncoding('utf-8')
  child.stdout?.on('data', (chunk: string) => stdoutBuf.push(chunk))
  child.stderr?.on('data', (chunk: string) => stderrBuf.push(chunk))

  // Suppress unhandled-error events; we surface failures via the `done`
  // promise's exitCode field instead of throwing.
  child.on('error', (err) => {
    stderrBuf.push(`\n[shogo] spawn error: ${err.message}\n`)
  })

  // Hard ceiling — auto-SIGKILL backgrounded orphans.
  const hardTimer = setTimeout(() => {
    if (exited) return
    timedOut = true
    sendKill('SIGKILL')
  }, hardTimeout)
  hardTimer.unref?.()

  function sendKill(signal: 'SIGTERM' | 'SIGKILL'): void {
    killed = true
    try {
      child.kill(signal)
    } catch { /* already gone */ }

    // For sandboxed runs the SIGTERM to the docker CLI may not always
    // propagate to the container — issue an explicit `docker kill` as
    // belt-and-suspenders when the caller asks for a forceful kill.
    if (useSandbox && containerName && signal === 'SIGKILL') {
      try {
        execSync(`docker kill ${containerName}`, {
          timeout: 5_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch { /* container may already be gone */ }
    }
  }

  function gracefulKill(): void {
    if (exited) return
    sendKill('SIGTERM')
    // Escalate after 2s grace period.
    const escalate = setTimeout(() => {
      if (!exited) sendKill('SIGKILL')
    }, 2_000)
    escalate.unref?.()
  }

  const done = new Promise<{ exitCode: number; stdout: string; stderr: string; killed: boolean; timedOut: boolean }>((resolve) => {
    child.on('exit', (code, signal) => {
      exited = true
      clearTimeout(hardTimer)
      const exitCode = typeof code === 'number'
        ? code
        : (signal ? 128 + (signalNumber(signal) ?? 0) : 1)
      resolve({
        exitCode,
        stdout: stdoutBuf.toString(),
        stderr: stderrBuf.toString(),
        killed,
        timedOut,
      })
    })
  })

  return {
    pid: child.pid,
    containerName,
    sandboxed: useSandbox,
    stdout: () => stdoutBuf.toString(),
    stderr: () => stderrBuf.toString(),
    done,
    kill: (signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') => {
      if (signal === 'SIGTERM') {
        gracefulKill()
      } else {
        sendKill('SIGKILL')
      }
    },
    exited: () => exited,
    startedAt,
  }
}

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6,
  SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
  SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  return SIGNAL_NUMBERS[signal]
}
