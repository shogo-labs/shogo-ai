// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * A small OpenSSH transport used by Remote-SSH.
 *
 * This module deliberately invokes `ssh` with argument arrays. The only shell
 * parsing involved is the shell on the remote host, which is inherent to
 * `ssh <host> <command>`. Secrets and file contents travel over stdin, never
 * argv.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  RemoteCommandError,
  quoteRemoteShellArgument,
  type RemoteCommandResult,
  type RemoteExecOptions,
} from './shell'

export interface SSHConnectionConfig {
  /**
   * The SSH host or SSH config alias. It may include a user, for example
   * `alice@example.com`; use `username` when keeping them separate.
   */
  host: string
  username?: string
  port?: number
  identityFile?: string
  /**
   * Share one OpenSSH ControlMaster between exec calls and forwards. Defaults
   * to `process.platform !== 'win32'`: Windows OpenSSH has no usable control
   * socket (`getsockname failed: Not a socket`, or no fd-passing for the
   * Git-for-Windows build). Without multiplexing every exec is its own ssh
   * process and each forward is a supervised `ssh -N -L/-R` child.
   */
  multiplex?: boolean
  /** Override the generated shared ControlMaster socket path. */
  controlPath?: string
  /** OpenSSH `ControlPersist` value. Defaults to five minutes. */
  controlPersist?: string | number
  /** OpenSSH `ConnectTimeout` in milliseconds. */
  connectTimeoutMs?: number
  /** Default timeout for `exec` when the caller does not pass one. */
  commandTimeoutMs?: number
  /** Override the system executable name, primarily useful for embedding. */
  sshCommand?: string
  /** Allow SSH_ASKPASS to answer passphrase/host-key prompts. */
  batchMode?: boolean
  /** Additional environment for ssh child processes. */
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

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
/** Long enough for an interactive askpass prompt (the helper waits 2 minutes). */
const MASTER_START_TIMEOUT_MS = 150_000
const UPLOAD_TIMEOUT_MS = 10 * 60_000
const CONTROL_TIMEOUT_MS = 15_000
const KILL_GRACE_MS = 5_000
/** Detect a dead network path in ~45s instead of waiting for TCP to give up. */
const SERVER_ALIVE_INTERVAL_SECONDS = 15
const SERVER_ALIVE_COUNT_MAX = 3
/** Cap on retained ssh stderr for a supervised forward child. */
const FORWARD_STDERR_TAIL_BYTES = 16 * 1024
/** `ssh -v` lines proving a forward is established. */
const FORWARD_READY_MARKERS: Record<'-L' | '-R', RegExp> = {
  '-L': /Local forwarding listening on/,
  '-R': /remote forward success for: listen/,
}

export const systemProcessRunner: SSHProcessRunner = (command, args, options) =>
  spawn(command, args, options)

export function getSSHConnectionTarget(
  config: Pick<SSHConnectionConfig, 'host' | 'username'>,
): string {
  const host = config.host.trim()
  if (!host) throw new TypeError('SSH host is required')
  const username = config.username?.trim()
  return username ? `${username}@${host}` : host
}

/**
 * Return the stable socket path shared by all connections to the same SSH
 * target and port. A digest keeps hostnames out of the filesystem path and
 * keeps the path well below OpenSSH's ControlPath length limit.
 */
export function getSharedControlPath(
  config: Pick<SSHConnectionConfig, 'host' | 'username' | 'port' | 'controlPath'>,
): string {
  if (config.controlPath?.trim()) return config.controlPath

  const target = getSSHConnectionTarget(config)
  const identity = `${target}\u0000${config.port ?? 22}`
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 32)
  return join(tmpdir(), 'shogo-remote-ssh', `${digest}.sock`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Drop `ssh -v` debug chatter so a failure message shows the real cause. */
function userFacingSshError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^debug\d:/.test(line) && !/^OpenSSH_/.test(line))
  return lines.length > 0 ? lines.join('\n') : stderr
}

function appendError(stderr: string, error: unknown): string {
  const message = errorMessage(error)
  return stderr ? `${stderr}${stderr.endsWith('\n') ? '' : '\n'}${message}` : message
}

function runProcess(
  runner: SSHProcessRunner,
  command: string,
  args: string[],
  options: RemoteExecOptions & { env: NodeJS.ProcessEnv },
): Promise<RemoteCommandResult> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = runner(command, args, {
        env: options.env,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ stdout: '', stderr: errorMessage(error), exitCode: null })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (result: RemoteCommandResult) => {
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
      if (killTimer) clearTimeout(killTimer)
      finish({ stdout, stderr, exitCode: code })
    })

    if (options.input !== undefined && child.stdin) {
      // The remote side may exit before consuming all input (for example a
      // failed `cd`); the exit code reports that, not an EPIPE.
      child.stdin.on('error', () => {})
      if (typeof options.input === 'string') {
        child.stdin.end(options.input)
      } else {
        options.input.once('error', (error) => {
          stderr = appendError(stderr, error)
          child.stdin?.destroy()
        })
        options.input.pipe(child.stdin)
      }
    }

    const timeoutMs = options.timeoutMs
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGTERM')
        } catch {
          // The process may have exited between the timer and kill().
        }
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // Already gone.
          }
        }, KILL_GRACE_MS)
        ;(killTimer as unknown as { unref?: () => void }).unref?.()
        finish({
          stdout,
          stderr: appendError(stderr, `process timed out after ${timeoutMs}ms`),
          exitCode: null,
        })
      }, timeoutMs)
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
  /** Supervised `ssh -N` child; only used when multiplexing is off. */
  child?: ChildProcess
  /** The supervised child exited without close() asking it to. */
  dead?: boolean
  /** close() is killing the child; its exit is expected. */
  closing?: boolean
}

function killChild(child: ChildProcess): void {
  try {
    child.kill('SIGTERM')
  } catch {
    // The process may already have exited.
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }, KILL_GRACE_MS)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  child.once('close', () => clearTimeout(timer))
}

export class SSHConnection {
  readonly config: Readonly<SSHConnectionConfig>
  readonly target: string
  readonly controlPath: string
  /** True when exec and forwards share an OpenSSH ControlMaster. */
  readonly multiplex: boolean

  private readonly runner: SSHProcessRunner
  private connected = false
  private ownsMaster = false
  private connectPromise: Promise<void> | undefined
  private closePromise: Promise<void> | undefined
  private readonly activeForwards = new Map<string, ActiveForward>()
  /** A supervised forward died; the next status must report the transport dead. */
  private forwardFailure = false

  constructor(config: SSHConnectionConfig, dependencies: SSHConnectionDependencies = {}) {
    if (!config.host?.trim()) throw new TypeError('SSH host is required')
    if (config.port !== undefined) assertPort(config.port, 'SSH port')
    if (config.connectTimeoutMs !== undefined && config.connectTimeoutMs < 0) {
      throw new RangeError('connectTimeoutMs cannot be negative')
    }

    this.config = { ...config }
    this.target = getSSHConnectionTarget(config)
    this.controlPath = getSharedControlPath(config)
    this.multiplex = config.multiplex ?? process.platform !== 'win32'
    this.runner = dependencies.processRunner ?? systemProcessRunner
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

  /**
   * Check the control master. A dead master (network drop, laptop sleep)
   * resets this instance so the next `connect()` establishes a new one.
   */
  async status(): Promise<SSHConnectionStatus> {
    if (this.connectPromise) {
      try {
        await this.connectPromise
      } catch {
        // The check below provides the authoritative status.
      }
    }

    if (!this.multiplex) return this.statusWithoutMux()

    const result = await this.control(['-O', 'check'])
    this.connected = result.exitCode === 0
    if (!this.connected) {
      // Forwards die with their master; they must be re-requested.
      this.activeForwards.clear()
      this.releaseMasterOwnership()
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

      for (const forward of [...this.activeForwards.values()]) {
        await this.cancelForward(forward, true)
      }
      this.activeForwards.clear()

      if (!this.multiplex) {
        this.connected = false
        return
      }

      if (this.ownsMaster) {
        const lastOwner = (sharedMasterOwners.get(this.controlPath) ?? 1) <= 1
        this.releaseMasterOwnership()
        // `-O exit` is best effort: the master may already have gone away,
        // which is a successful end state for close().
        if (lastOwner) await this.control(['-O', 'exit'])
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

  async exec(command: string, options: RemoteExecOptions = {}): Promise<RemoteCommandResult> {
    if (!command.trim()) throw new TypeError('Remote command is required')
    await this.connect()
    // `command` is one argument to ssh and is interpreted only by the
    // remote shell. It is never interpolated into a local shell command.
    return runProcess(this.runner, this.config.sshCommand ?? 'ssh', this.sshArgs([], command), {
      input: options.input,
      timeoutMs: options.timeoutMs ?? this.config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      env: this.processEnv(),
    })
  }

  /**
   * Stream a local file to a remote path over the existing master.
   *
   * This uses `cat` rather than scp: OpenSSH 9+ scp defaults to SFTP, which
   * does not unquote remote paths, so quoting behaves differently between
   * scp modes.
   */
  async upload(localPath: string, remotePath: string): Promise<void> {
    if (!localPath) throw new TypeError('Local path is required')
    if (!remotePath) throw new TypeError('Remote path is required')
    const result = await this.exec(`umask 077 && cat > ${quoteRemoteShellArgument(remotePath)}`, {
      input: createReadStream(localPath),
      timeoutMs: UPLOAD_TIMEOUT_MS,
    })
    if (result.exitCode !== 0) throw new RemoteCommandError('upload', result)
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
      spec: `${remotePort}:127.0.0.1:${localPort}`,
    }
    await this.openForward(active)
    return this.makeForwardHandle(active)
  }

  private async startMaster(): Promise<void> {
    if (!this.multiplex) {
      // No master to start: authenticate once to verify credentials and
      // reachability (this is where askpass prompts surface). Later execs
      // and forwards each authenticate on their own.
      const probe = await this.probe(MASTER_START_TIMEOUT_MS)
      if (probe.exitCode !== 0) throw new RemoteCommandError('connect', probe)
      this.connected = true
      this.forwardFailure = false
      return
    }

    await mkdir(dirname(this.controlPath), { recursive: true, mode: 0o700 })

    // Another connection object (or an earlier run) may already own a live
    // master at this path.
    if ((await this.control(['-O', 'check'])).exitCode === 0) {
      this.markMasterAcquired()
      return
    }

    // A socket left behind by a master that died abruptly makes OpenSSH
    // silently disable multiplexing, which would break `-O forward`.
    await rm(this.controlPath, { force: true })

    const result = await runProcess(
      this.runner,
      this.config.sshCommand ?? 'ssh',
      this.sshArgs(['-M', '-N', '-f']),
      { timeoutMs: MASTER_START_TIMEOUT_MS, env: this.processEnv() },
    )
    if (result.exitCode === 0) {
      this.markMasterAcquired()
      return
    }

    // A concurrent connect may have won the race to create the master.
    if ((await this.control(['-O', 'check'])).exitCode === 0) {
      this.markMasterAcquired()
      return
    }
    throw new RemoteCommandError('connect', result)
  }

  private markMasterAcquired(): void {
    this.connected = true
    if (this.ownsMaster) return
    this.ownsMaster = true
    sharedMasterOwners.set(this.controlPath, (sharedMasterOwners.get(this.controlPath) ?? 0) + 1)
  }

  private releaseMasterOwnership(): void {
    if (!this.ownsMaster) return
    this.ownsMaster = false
    const owners = sharedMasterOwners.get(this.controlPath) ?? 1
    if (owners <= 1) sharedMasterOwners.delete(this.controlPath)
    else sharedMasterOwners.set(this.controlPath, owners - 1)
  }

  private async openForward(active: ActiveForward): Promise<void> {
    if (!this.multiplex) {
      await this.openSupervisedForward(active)
      return
    }
    const result = await this.control(['-O', 'forward', active.option, active.spec])
    if (result.exitCode !== 0) {
      throw new RemoteCommandError(`${active.option} ${active.spec}`, result)
    }
    this.activeForwards.set(active.key, active)
  }

  /**
   * Start `ssh -N -L|-R` as a child owned by this connection and resolve once
   * ssh reports the forward as established. `-v` is what makes ssh print the
   * readiness line; `ExitOnForwardFailure` turns a bind failure into an exit
   * instead of a silently useless connection.
   */
  private openSupervisedForward(active: ActiveForward): Promise<void> {
    // Re-requesting the same forward replaces the old child instead of
    // leaking it (and colliding with its listener).
    const previous = this.activeForwards.get(active.key)
    if (previous) {
      this.activeForwards.delete(active.key)
      this.killForwardChild(previous)
    }

    const operation = `${active.option} ${active.spec}`
    const args = this.sshArgs([
      '-v',
      '-N',
      '-o', 'ExitOnForwardFailure=yes',
      active.option,
      active.spec,
    ])

    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = this.runner(this.config.sshCommand ?? 'ssh', args, {
          env: this.processEnv(),
          stdio: ['ignore', 'ignore', 'pipe'],
        })
      } catch (error) {
        reject(new RemoteCommandError(operation, { stdout: '', stderr: errorMessage(error), exitCode: null }))
        return
      }

      let stderrTail = ''
      let ready = false
      let settled = false
      let startTimer: ReturnType<typeof setTimeout> | undefined
      const marker = FORWARD_READY_MARKERS[active.option]

      const fail = (exitCode: number | null, extra?: string) => {
        if (settled) return
        settled = true
        if (startTimer) clearTimeout(startTimer)
        if (exitCode === null) killChild(child)
        reject(
          new RemoteCommandError(operation, {
            stdout: '',
            stderr: extra ? appendError(stderrTail, extra) : stderrTail,
            exitCode,
          }),
        )
      }

      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderrTail += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        if (!ready && marker.test(stderrTail)) {
          ready = true
          settled = true
          if (startTimer) clearTimeout(startTimer)
          active.child = child
          this.activeForwards.set(active.key, active)
          resolve()
        }
        // Once established the log is only useful as a short diagnostic tail.
        if (stderrTail.length > FORWARD_STDERR_TAIL_BYTES) {
          stderrTail = stderrTail.slice(-FORWARD_STDERR_TAIL_BYTES)
        }
      })
      child.once('error', (error) => {
        if (!ready) fail(null, errorMessage(error))
        else this.markForwardDead(active)
      })
      child.once('close', (code) => {
        if (!ready) {
          // Strip -v chatter from the user-facing message when possible.
          stderrTail = userFacingSshError(stderrTail)
          fail(code)
        } else {
          this.markForwardDead(active)
        }
      })

      startTimer = setTimeout(() => {
        fail(null, `forward was not established after ${MASTER_START_TIMEOUT_MS}ms`)
      }, MASTER_START_TIMEOUT_MS)
    })
  }

  /** A supervised child exited on its own: the link is no longer trustworthy. */
  private markForwardDead(active: ActiveForward): void {
    if (active.closing) return
    if (this.activeForwards.get(active.key) === active) {
      this.activeForwards.delete(active.key)
    }
    this.forwardFailure = true
    active.dead = true
    this.connected = false
  }

  private killForwardChild(active: ActiveForward): void {
    active.closing = true
    if (active.child) killChild(active.child)
  }

  private async statusWithoutMux(): Promise<SSHConnectionStatus> {
    const forwards = [...this.activeForwards.values()]
    if (this.forwardFailure || forwards.some((forward) => forward.dead)) {
      // The dead forward's owner (RemoteRuntimeManager) closes and re-opens
      // all of its forwards when it sees a disconnected status.
      this.connected = false
    } else if (this.connected && forwards.length === 0) {
      // Nothing is holding a connection open, so verify with a fresh login.
      this.connected = (await this.probe(CONTROL_TIMEOUT_MS)).exitCode === 0
    }
    // With live forwards the supervised children are the liveness signal
    // (ServerAlive* makes ssh exit on a dead path). A never-connected
    // instance stays disconnected without probing, so status polls cannot
    // surface surprise askpass prompts.
    return {
      connected: this.connected,
      state: this.connectPromise ? 'connecting' : this.connected ? 'connected' : 'disconnected',
      host: this.target,
      controlPath: this.controlPath,
    }
  }

  private probe(timeoutMs: number): Promise<RemoteCommandResult> {
    return runProcess(this.runner, this.config.sshCommand ?? 'ssh', this.sshArgs([], 'true'), {
      timeoutMs,
      env: this.processEnv(),
    })
  }

  private async cancelForward(active: ActiveForward, ignoreFailure: boolean): Promise<void> {
    if (!this.multiplex) {
      // Dead forwards stay in the map (so status() can see them) until the
      // owner closes them.
      if (this.activeForwards.get(active.key) !== active) return
      this.killForwardChild(active)
      this.activeForwards.delete(active.key)
      return
    }
    if (!this.activeForwards.has(active.key)) return
    const result = await this.control(['-O', 'cancel', active.option, active.spec])
    if (!ignoreFailure && result.exitCode !== 0) {
      throw new RemoteCommandError(`cancel ${active.option} ${active.spec}`, result)
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
      // Explicitly disable multiplexing when it is off so a user's
      // ~/.ssh/config cannot re-enable the sockets Windows cannot serve.
      ...(this.multiplex
        ? [
            '-o', 'ControlMaster=auto',
            '-o', `ControlPath=${this.controlPath}`,
            '-o', `ControlPersist=${this.config.controlPersist ?? 300}`,
          ]
        : ['-o', 'ControlMaster=no', '-o', 'ControlPath=none']),
      '-o', `ServerAliveInterval=${SERVER_ALIVE_INTERVAL_SECONDS}`,
      '-o', `ServerAliveCountMax=${SERVER_ALIVE_COUNT_MAX}`,
    ]
    if (this.config.port !== undefined) args.push('-p', String(this.config.port))
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

  private processEnv(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.config.env }
  }

  private control(extra: string[]): Promise<RemoteCommandResult> {
    return runProcess(this.runner, this.config.sshCommand ?? 'ssh', this.sshArgs(extra), {
      timeoutMs: CONTROL_TIMEOUT_MS,
      env: this.processEnv(),
    })
  }
}

export function createSSHConnection(
  config: SSHConnectionConfig,
  dependencies: SSHConnectionDependencies = {},
): SSHConnection {
  return new SSHConnection(config, dependencies)
}
