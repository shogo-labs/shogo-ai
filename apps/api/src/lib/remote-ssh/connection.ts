// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * A small OpenSSH transport used by Remote-SSH.
 *
 * This module deliberately invokes `ssh` and `scp` with argument arrays. The
 * only shell parsing involved is the shell on the remote host, which is
 * inherent to `ssh <host> <command>` and is also used to quote an scp
 * destination path.
 */

import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

export interface SSHConnectionConfig {
  /**
   * The SSH host or SSH config alias. It may include a user, for example
   * `alice@example.com`; use `username`/`user` when keeping them separate.
   */
  host: string
  username?: string
  /** Short alias for `username`. */
  user?: string
  port?: number
  identityFile?: string
  /** Override the generated shared ControlMaster socket path. */
  controlPath?: string
  /** OpenSSH `ControlPersist` value. Defaults to five minutes. */
  controlPersist?: string | number
  /** OpenSSH `ConnectTimeout` in milliseconds. */
  connectTimeoutMs?: number
  /** Override the system executable names, primarily useful for embedding. */
  sshCommand?: string
  scpCommand?: string
  /** Allow SSH_ASKPASS to answer passphrase/host-key prompts. */
  batchMode?: boolean
  /** Additional environment for ssh/scp child processes. */
  env?: NodeJS.ProcessEnv
}

export type SSHConnectionOptions = SSHConnectionConfig

export interface SSHCommandResult {
  stdout: string
  stderr: string
  /** `null` means that the process did not produce a normal exit code. */
  exitCode: number | null
}

export type SSHExecResult = SSHCommandResult

export interface SSHExecOptions {
  /** Kill the local ssh process after this many milliseconds. */
  timeoutMs?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
}

/**
 * The narrow process surface used by this module. Keeping the runner
 * injectable makes all connection behavior testable without an SSH daemon.
 */
export type SSHProcessRunner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess

export interface SSHConnectionDependencies {
  processRunner?: SSHProcessRunner
}

export type SSHConnectionState = 'connected' | 'disconnected' | 'connecting'

export interface SSHConnectionStatus {
  connected: boolean
  state: SSHConnectionState
  host: string
  controlPath: string
}

export type SSHForwardDirection = 'local' | 'reverse'

export interface SSHForwardHandle {
  readonly direction: SSHForwardDirection
  readonly spec: string
  close(): Promise<void>
}

export class SSHConnectionError extends Error {
  readonly result: SSHCommandResult
  readonly operation: string

  constructor(operation: string, result: SSHCommandResult) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.exitCode)}`
    super(`${operation} failed: ${detail}`)
    this.name = 'SSHConnectionError'
    this.operation = operation
    this.result = result
  }
}

export const systemProcessRunner: SSHProcessRunner = (command, args, options) =>
  spawn(command, args, options)

/**
 * Quote one literal argument for the remote POSIX shell.
 *
 * This must not be used for local process arguments: local arguments are
 * passed directly to spawn(). It is exported so callers composing their own
 * remote commands can use the same quoting rule.
 */
export function quoteRemoteShellArgument(value: string): string {
  if (value.includes('\u0000')) {
    throw new TypeError('Remote shell arguments cannot contain NUL bytes')
  }
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Alias with a concise name for callers that build remote commands. */
export const shellQuoteRemote = quoteRemoteShellArgument

export function getSSHConnectionTarget(
  config: Pick<SSHConnectionConfig, 'host' | 'username' | 'user'>,
): string {
  const host = config.host.trim()
  if (!host) throw new TypeError('SSH host is required')
  const username = (config.username ?? config.user)?.trim()
  return username ? `${username}@${host}` : host
}

/**
 * Return the stable socket path shared by all connections to the same SSH
 * target and port. A digest keeps hostnames out of the filesystem path and
 * keeps the path well below OpenSSH's ControlPath length limit.
 */
export function getSharedControlPath(
  config: Pick<SSHConnectionConfig, 'host' | 'username' | 'user' | 'port' | 'controlPath'>,
): string {
  if (config.controlPath?.trim()) return config.controlPath

  const target = getSSHConnectionTarget(config)
  const identity = `${target}\u0000${config.port ?? 22}`
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 32)
  return join(tmpdir(), 'shogo-remote-ssh', `${digest}.sock`)
}

export function buildScpRemoteDestination(
  config: Pick<SSHConnectionConfig, 'host' | 'username' | 'user'>,
  remotePath: string,
): string {
  if (!remotePath) throw new TypeError('Remote path is required')
  return `${getSSHConnectionTarget(config)}:${quoteRemoteShellArgument(remotePath)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function appendError(stderr: string, error: unknown): string {
  const message = errorMessage(error)
  return stderr ? `${stderr}${stderr.endsWith('\n') ? '' : '\n'}${message}` : message
}

function runProcess(
  runner: SSHProcessRunner,
  command: string,
  args: string[],
  options: SSHExecOptions = {},
): Promise<SSHCommandResult> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = runner(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ stdout: '', stderr: errorMessage(error), exitCode: null })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (result: SSHCommandResult) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })
    child.once('error', (error) => {
      finish({ stdout, stderr: appendError(stderr, error), exitCode: null })
    })
    child.once('close', (code) => {
      finish({ stdout, stderr, exitCode: code })
    })

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGTERM')
        } catch {
          // The process may have exited between the timer and kill().
        }
        finish({
          stdout,
          stderr: appendError(stderr, `process timed out after ${options.timeoutMs}ms`),
          exitCode: null,
        })
      }, options.timeoutMs)
    }
  })
}

function assertPort(port: number, name: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError(`${name} must be an integer between 1 and 65535`)
  }
}

/**
 * ControlMaster sockets are shared by connection instances in this process.
 * Keep a local owner count so closing one instance does not tear down a
 * master that another instance is still using.
 */
const sharedMasterOwners = new Map<string, number>()

interface ActiveForward {
  key: string
  option: '-L' | '-R'
  spec: string
}

export class SSHConnection {
  readonly config: Readonly<SSHConnectionConfig>
  readonly target: string
  readonly controlPath: string

  private readonly runner: SSHProcessRunner
  private connected = false
  private ownsMaster = false
  private connectPromise: Promise<void> | undefined
  private closePromise: Promise<void> | undefined
  private readonly activeForwards = new Map<string, ActiveForward>()

  constructor(
    config: SSHConnectionConfig,
    dependencies: SSHConnectionDependencies | SSHProcessRunner = {},
  ) {
    if (!config.host?.trim()) throw new TypeError('SSH host is required')
    if (config.port !== undefined) assertPort(config.port, 'SSH port')
    if (config.connectTimeoutMs !== undefined && config.connectTimeoutMs < 0) {
      throw new RangeError('connectTimeoutMs cannot be negative')
    }

    this.config = { ...config }
    this.target = getSSHConnectionTarget(config)
    this.controlPath = getSharedControlPath(config)
    this.runner = typeof dependencies === 'function'
      ? dependencies
      : dependencies.processRunner ?? systemProcessRunner
  }

  async connect(): Promise<void> {
    if (this.connected) return
    if (this.connectPromise) return this.connectPromise

    const promise = this.startMaster()
    this.connectPromise = promise
    try {
      await promise
    } finally {
      if (this.connectPromise === promise) this.connectPromise = undefined
    }
  }

  async reconnect(): Promise<void> {
    await this.close()
    await this.connect()
  }

  async status(): Promise<SSHConnectionStatus> {
    if (this.connectPromise) {
      try {
        await this.connectPromise
      } catch {
        // The check below provides the authoritative status.
      }
    }

    const result = await this.runSSH(['-O', 'check'])
    this.connected = result.exitCode === 0
    if (!this.connected && this.ownsMaster) {
      this.ownsMaster = false
      const owners = sharedMasterOwners.get(this.controlPath) ?? 1
      if (owners <= 1) sharedMasterOwners.delete(this.controlPath)
      else sharedMasterOwners.set(this.controlPath, owners - 1)
    }
    return {
      connected: this.connected,
      state: this.connectPromise ? 'connecting' : this.connected ? 'connected' : 'disconnected',
      host: this.target,
      controlPath: this.controlPath,
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise

    const promise = (async () => {
      if (this.connectPromise) {
        try {
          await this.connectPromise
        } catch {
          // Closing is idempotent even if establishing the master failed.
        }
      }

      const forwards = [...this.activeForwards.values()]
      for (const forward of forwards) {
        await this.cancelForward(forward, true)
      }
      this.activeForwards.clear()

      if (this.ownsMaster) {
        this.ownsMaster = false
        const owners = sharedMasterOwners.get(this.controlPath) ?? 1
        if (owners <= 1) {
          sharedMasterOwners.delete(this.controlPath)
          // `-O exit` is intentionally best effort: the master may already
          // have gone away, which is a successful end state for close().
          await this.runSSH(['-O', 'exit'])
        } else {
          sharedMasterOwners.set(this.controlPath, owners - 1)
        }
      }
      this.connected = false
    })()

    this.closePromise = promise
    try {
      await promise
    } finally {
      if (this.closePromise === promise) this.closePromise = undefined
    }
  }

  async exec(command: string, options: SSHExecOptions = {}): Promise<SSHCommandResult> {
    if (!command.trim()) throw new TypeError('Remote command is required')
    await this.connect()
    // `command` is one argument to ssh and is interpreted only by the
    // remote shell. It is never interpolated into a local shell command.
    return runProcess(
      this.runner,
      this.config.sshCommand ?? 'ssh',
      this.sshArgs([], command),
      { ...options, env: { ...process.env, ...this.config.env, ...options.env } },
    )
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    if (!localPath) throw new TypeError('Local path is required')
    if (!remotePath) throw new TypeError('Remote path is required')
    await this.connect()

    const args = [
      ...this.scpOptions(),
      '--',
      localPath,
      buildScpRemoteDestination(this.config, remotePath),
    ]
    const result = await runProcess(this.runner, this.config.scpCommand ?? 'scp', args, {
      env: { ...process.env, ...this.config.env },
    })
    if (result.exitCode !== 0) {
      throw new SSHConnectionError('upload', result)
    }
  }

  async forward(localPort: number, remoteHostPort: string): Promise<SSHForwardHandle> {
    assertPort(localPort, 'Local port')
    if (!remoteHostPort || remoteHostPort.includes('\u0000')) {
      throw new TypeError('Remote host and port are required')
    }
    await this.connect()

    const active: ActiveForward = {
      key: `local:${localPort}:${remoteHostPort}`,
      option: '-L',
      spec: `${localPort}:${remoteHostPort}`,
    }
    await this.openForward(active)
    return this.makeForwardHandle(active)
  }

  async reverseForward(remotePort: number, localPort: number): Promise<SSHForwardHandle> {
    assertPort(remotePort, 'Remote port')
    assertPort(localPort, 'Local port')
    await this.connect()

    const active: ActiveForward = {
      key: `reverse:${remotePort}:${localPort}`,
      option: '-R',
      spec: `${remotePort}:localhost:${localPort}`,
    }
    await this.openForward(active)
    return this.makeForwardHandle(active)
  }

  private async startMaster(): Promise<void> {
    await mkdir(dirname(this.controlPath), { recursive: true, mode: 0o700 })
    const result = await this.runSSH(['-M', '-N', '-f'])
    if (result.exitCode === 0) {
      this.markMasterAcquired()
      return
    }

    // A different connection object may already own this shared master. If
    // so, the `-M` invocation can fail while the existing master is usable.
    const check = await this.runSSH(['-O', 'check'])
    if (check.exitCode === 0) {
      this.markMasterAcquired()
      return
    }
    throw new SSHConnectionError('connect', result)
  }

  private markMasterAcquired(): void {
    this.connected = true
    this.ownsMaster = true
    sharedMasterOwners.set(
      this.controlPath,
      (sharedMasterOwners.get(this.controlPath) ?? 0) + 1,
    )
  }

  private async openForward(active: ActiveForward): Promise<void> {
    const result = await this.runSSH(['-O', 'forward', active.option, active.spec])
    if (result.exitCode !== 0) {
      throw new SSHConnectionError(`${active.option} ${active.spec}`, result)
    }
    this.activeForwards.set(active.key, active)
  }

  private async cancelForward(active: ActiveForward, ignoreFailure: boolean): Promise<void> {
    if (!this.activeForwards.has(active.key)) return
    const result = await this.runSSH(['-O', 'cancel', active.option, active.spec])
    if (!ignoreFailure && result.exitCode !== 0) {
      throw new SSHConnectionError(`cancel ${active.option} ${active.spec}`, result)
    }
    this.activeForwards.delete(active.key)
  }

  private makeForwardHandle(active: ActiveForward): SSHForwardHandle {
    let closed = false
    return {
      direction: active.option === '-L' ? 'local' : 'reverse',
      spec: active.spec,
      close: async () => {
        if (closed) return
        await this.cancelForward(active, false)
        closed = true
      },
    }
  }

  private sshOptions(): string[] {
    const args = [
      '-o', `BatchMode=${this.config.batchMode === false ? 'no' : 'yes'}`,
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${this.controlPath}`,
      '-o', `ControlPersist=${this.config.controlPersist ?? 300}`,
    ]
    if (this.config.port !== undefined) args.push('-p', String(this.config.port))
    if (this.config.identityFile) args.push('-i', this.config.identityFile)
    if (this.config.connectTimeoutMs !== undefined) {
      const seconds = Math.max(1, Math.ceil(this.config.connectTimeoutMs / 1000))
      args.push('-o', `ConnectTimeout=${seconds}`)
    }
    return args
  }

  private scpOptions(): string[] {
    const args = [
      ...(this.config.batchMode === false ? [] : ['-B']),
      '-o', `BatchMode=${this.config.batchMode === false ? 'no' : 'yes'}`,
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${this.controlPath}`,
      '-o', `ControlPersist=${this.config.controlPersist ?? 300}`,
    ]
    if (this.config.port !== undefined) args.push('-P', String(this.config.port))
    if (this.config.identityFile) args.push('-i', this.config.identityFile)
    if (this.config.connectTimeoutMs !== undefined) {
      const seconds = Math.max(1, Math.ceil(this.config.connectTimeoutMs / 1000))
      args.push('-o', `ConnectTimeout=${seconds}`)
    }
    return args
  }

  private sshArgs(extra: string[], remoteCommand?: string): string[] {
    const args = [...this.sshOptions(), ...extra, '--', this.target]
    if (remoteCommand !== undefined) args.push(remoteCommand)
    return args
  }

  private runSSH(extra: string[], remoteCommand?: string): Promise<SSHCommandResult> {
    return runProcess(
      this.runner,
      this.config.sshCommand ?? 'ssh',
      this.sshArgs(extra, remoteCommand),
      { env: { ...process.env, ...this.config.env } },
    )
  }
}

export function createSSHConnection(
  config: SSHConnectionConfig,
  dependencies: SSHConnectionDependencies | SSHProcessRunner = {},
): SSHConnection {
  return new SSHConnection(config, dependencies)
}
