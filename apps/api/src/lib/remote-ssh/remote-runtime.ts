// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Lifecycle management for an agent-runtime running on an SSH host.
 *
 * The SSH connection is deliberately the only transport dependency here.
 * The runtime is a detached remote process; the agent HTTP port is forwarded
 * to this process and the runtime's API port is reverse-forwarded back to
 * the local remote-API gateway (see api-gateway.ts), never to the API itself.
 */

import {
  bootstrapRemoteRuntime,
  type RemoteRuntimeBootstrapOptions,
  type RemoteSshConnection,
} from './bootstrap'
import type { SSHForwardHandle } from './connection'
import {
  RemoteCommandError,
  commandSucceeded,
  quoteRemoteShellArgument,
  remotePathExpression,
  type RemoteCommandRunner,
} from './shell'

const DEFAULT_REMOTE_PORT_START = 37_100
const DEFAULT_REMOTE_PORT_END = 37_900
/**
 * Ports owned by one runtime: agent (+0), API/skill server (+1), and preview
 * sidecars from WORKSPACE_API_PORT_BASE (+2 onward). Slots never overlap, so
 * several runtimes can share a host.
 */
export const REMOTE_PORT_SLOT_SIZE = 20
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000
const DEFAULT_HEALTH_POLL_MS = 500
const DEFAULT_HEALTH_REQUEST_TIMEOUT_MS = 1_500
const DEFAULT_IDLE_MS = 45 * 60 * 1000
const DEFAULT_RECOVERY_THRESHOLD = 3
const MAX_LOG_BYTES = 5 * 1024 * 1024

const API_URL_KEYS = [
  'API_URL',
  'API_PROXY_URL',
  'SHOGO_API_URL',
  'SHOGO_API_BASE_URL',
  'SHOGO_CLOUD_URL',
  'AI_PROXY_URL',
  'ANTHROPIC_PROXY_URL',
  'OPENAI_PROXY_URL',
  'TOOLS_PROXY_URL',
] as const

type ApiUrlKey = (typeof API_URL_KEYS)[number]

export interface RemoteRuntimeConnection extends RemoteSshConnection {
  forward(localPort: number, remoteHostPort: string): Promise<SSHForwardHandle>
  reverseForward(remotePort: number, localPort: number): Promise<SSHForwardHandle>
  /** Probe the transport; a dead master resets so the next command reconnects. */
  status?(): Promise<{ connected: boolean }>
}

export interface RemoteRuntimePorts {
  /** Port on the SSH host where agent-runtime listens. */
  agentPort: number
  /** Port on the SSH host where the runtime API/skill server listens. */
  apiPort: number
}

export type RemoteRuntimeBootstrapper = (
  connection: RemoteSshConnection,
  options: RemoteRuntimeBootstrapOptions,
) => Promise<{ binaryPath: string; version?: string }>

/** Returns the first port of a free slot of `slotSize` consecutive ports. */
export type RemoteRuntimePortAllocator = (
  connection: RemoteCommandRunner,
  options: { start: number; end: number; slotSize: number; exclude: readonly number[] },
) => Promise<number>

export type RemoteRuntimeLifecycle = 'starting' | 'running' | 'stopping' | 'stopped' | 'error'

export interface RemoteRuntimeHealth {
  healthy: boolean
  lastCheck: number
  url: string
  status?: number
  error?: string
}

export interface RemoteRuntimeStatus {
  workspaceKey: string
  status: RemoteRuntimeLifecycle
  pid?: number
  /** Local port exposed by the SSH -L forward. */
  agentPort?: number
  remoteAgentPort?: number
  remoteApiPort?: number
  url?: string
  startedAt?: number
  reattached?: boolean
  lastHealthCheck?: RemoteRuntimeHealth
  error?: string
}

export interface RemoteRuntimeOptions {
  connection: RemoteRuntimeConnection
  /** Stable, path-safe key used below ~/.shogo-server/run/. */
  workspaceKey: string
  /** Directory containing the project on the SSH host. */
  remoteProjectDir: string
  /** Local port reached by the SSH reverse forward (the remote API gateway). */
  localApiPort: number
  /** Local port for the -L agent forward. Omit to allocate an ephemeral port. */
  localAgentPort?: number
  /** Fixed remote slot; the API port is agentPort + 1. Omit to probe. */
  remoteAgentPort?: number
  env?: Record<string, string>
  /** Use an already-installed binary instead of bootstrapping a release. */
  runtimeBinaryPath?: string
  runtimeVersion?: string
  bootstrapOptions?: Omit<RemoteRuntimeBootstrapOptions, 'version'>
  bootstrap?: RemoteRuntimeBootstrapper
  portAllocator?: RemoteRuntimePortAllocator
  healthTimeoutMs?: number
  healthPollMs?: number
  healthRequestTimeoutMs?: number
  /** Stop the detached runtime after this much time without activity. 0 disables it. */
  idleMs?: number
  /** Consecutive failed health checks on a running runtime before reconnecting. */
  recoveryThreshold?: number
  fetch?: typeof fetch
}

export type RemoteRuntimeStartOverrides = Partial<Pick<RemoteRuntimeOptions, 'env' | 'localAgentPort'>>

interface PidfileRecord {
  pid: number
  agentPort?: number
  apiPort?: number
  workspaceKey?: string
  binaryPath?: string
  version?: string
  startedAt?: number
}

interface RuntimeRecord {
  pid: number
  remotePorts: RemoteRuntimePorts
  localAgentPort: number
  startedAt: number
  reattached: boolean
  forwards: SSHForwardHandle[]
  binaryPath: string
}

function assertPort(port: number, name: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError(`${name} must be an integer between 1 and 65535`)
  }
}

function assertNonNegativeDuration(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`)
  }
}

function assertWorkspaceKey(value: string): string {
  const key = value.trim()
  if (!key || !/^[A-Za-z0-9._-]+$/.test(key) || key === '.' || key === '..') {
    throw new TypeError(
      'workspaceKey must contain only letters, numbers, dots, underscores, and hyphens',
    )
  }
  return key
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Slots handed out by this process but possibly not yet bound on the host,
 * keyed by the shared per-host connection.
 */
const reservedSlots = new WeakMap<object, Set<number>>()

function slotsFor(connection: object): Set<number> {
  let slots = reservedSlots.get(connection)
  if (!slots) {
    slots = new Set()
    reservedSlots.set(connection, slots)
  }
  return slots
}

/** Allocation and reservation must be atomic per host, or concurrent starts pick the same slot. */
const allocationQueues = new WeakMap<object, Promise<unknown>>()

function withAllocationLock<T>(connection: object, task: () => Promise<T>): Promise<T> {
  const previous = allocationQueues.get(connection) ?? Promise.resolve()
  const next = previous.then(task, task)
  allocationQueues.set(connection, next.catch(() => {}))
  return next
}

function buildPortProbeCommand(options: {
  start: number
  end: number
  slotSize: number
  exclude: readonly number[]
}): string {
  const { start, end, slotSize, exclude } = options
  const python = [
    'import socket,sys',
    `exclude={${exclude.join(',')}}`,
    `for base in range(${start},${end - slotSize + 1},${slotSize}):`,
    ' if base in exclude: continue',
    ' held=[]',
    ' try:',
    `  for p in range(base,base+${slotSize}):`,
    '   s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(("127.0.0.1",p)); held.append(s)',
    ' except OSError:',
    '  continue',
    ' finally:',
    '  [s.close() for s in held]',
    ' print(base)',
    ' sys.exit(0)',
    'sys.exit(1)',
  ].join('\n')
  return [
    'set -eu',
    'if command -v python3 >/dev/null 2>&1; then',
    `  python3 -c ${quoteRemoteShellArgument(python)}`,
    '  exit $?',
    'fi',
    'command -v ss >/dev/null 2>&1 || exit 1',
    `used=$(ss -Htln 2>/dev/null | awk '{ n = split($4, a, ":"); print a[n] }')`,
    `base=${start}`,
    `while [ $((base + ${slotSize})) -le ${end} ]; do`,
    `  case " ${exclude.join(' ')} " in *" $base "*) base=$((base + ${slotSize})); continue ;; esac`,
    '  free=1',
    '  p=$base',
    `  while [ "$p" -lt $((base + ${slotSize})) ]; do`,
    '    if printf \'%s\\n\' "$used" | grep -qx "$p"; then free=0; break; fi',
    '    p=$((p + 1))',
    '  done',
    '  if [ "$free" = 1 ]; then printf \'%s\\n\' "$base"; exit 0; fi',
    `  base=$((base + ${slotSize}))`,
    'done',
    'exit 1',
  ].join('\n')
}

/** Probe a remote high-port range for a free slot of consecutive loopback ports. */
export const allocateRemotePortSlot: RemoteRuntimePortAllocator = async (connection, options) => {
  assertPort(options.start, 'Remote port range start')
  assertPort(options.end, 'Remote port range end')
  if (options.end - options.start < options.slotSize) throw new RangeError('Remote port range is too small')

  const result = await connection.exec(buildPortProbeCommand(options))
  const base = Number(result.stdout.trim())
  if (!commandSucceeded(result) || !Number.isInteger(base)) {
    throw new Error(
      `Unable to find ${options.slotSize} free remote ports in ${options.start}-${options.end} (requires python3 or ss)`,
    )
  }
  assertPort(base, 'Remote agent port')
  return base
}

function parsePidfile(stdout: string): PidfileRecord | undefined {
  const lines = stdout.trim().split(/\r?\n/)
  const pid = Number(lines[0]?.trim())
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  if (lines.length === 1) return { pid }
  try {
    const metadata = JSON.parse(lines.slice(1).join('\n')) as Partial<PidfileRecord>
    return {
      pid,
      agentPort: typeof metadata.agentPort === 'number' ? metadata.agentPort : undefined,
      apiPort: typeof metadata.apiPort === 'number' ? metadata.apiPort : undefined,
      workspaceKey: typeof metadata.workspaceKey === 'string' ? metadata.workspaceKey : undefined,
      binaryPath: typeof metadata.binaryPath === 'string' ? metadata.binaryPath : undefined,
      version: typeof metadata.version === 'string' ? metadata.version : undefined,
      startedAt: typeof metadata.startedAt === 'number' ? metadata.startedAt : undefined,
    }
  } catch {
    return { pid }
  }
}

function rewriteInternalUrl(value: string, localApiBase: string): string {
  try {
    const url = new URL(value)
    const path = `${url.pathname}${url.search}${url.hash}`
    return `${localApiBase}${path === '/' ? '' : path}`
  } catch {
    return localApiBase
  }
}

function localApiEnv(input: Record<string, string>, localApiBase: string): Record<string, string> {
  const env = { ...input }
  const defaultPaths: Record<ApiUrlKey, string> = {
    API_URL: '',
    API_PROXY_URL: '',
    SHOGO_API_URL: '',
    SHOGO_API_BASE_URL: '',
    SHOGO_CLOUD_URL: '',
    AI_PROXY_URL: '/api/ai/v1',
    ANTHROPIC_PROXY_URL: '/api/ai/anthropic',
    OPENAI_PROXY_URL: '/api/ai/v1',
    TOOLS_PROXY_URL: '/api/tools',
  }

  for (const key of API_URL_KEYS) {
    const current = env[key]
    if (current !== undefined && current !== '') {
      env[key] = rewriteInternalUrl(current, localApiBase)
    } else if (key !== 'SHOGO_CLOUD_URL') {
      env[key] = `${localApiBase}${defaultPaths[key]}`
    }
  }
  return env
}

/**
 * The environment is sent on stdin and `eval`ed by the remote shell so tokens
 * never appear in any process's argv (readable by every user on the host).
 */
export function buildEnvScript(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new TypeError(`Invalid remote environment variable name '${name}'`)
      }
      return `export ${name}=${quoteRemoteShellArgument(value)}`
    })
    .join('\n')
}

function runDir(workspaceKey: string): string {
  return `"$HOME/.shogo-server/run/${workspaceKey}"`
}

function buildLaunchCommand(options: {
  workspaceKey: string
  remoteProjectDir: string
  binaryPath: string
  metadata: Omit<PidfileRecord, 'pid'>
}): string {
  return [
    'set -eu',
    `run_dir=${runDir(options.workspaceKey)}`,
    'mkdir -p "$run_dir"',
    'pidfile="$run_dir/agent-runtime.pid"',
    'logfile="$run_dir/agent-runtime.log"',
    `if [ -f "$logfile" ] && [ "$(wc -c < "$logfile" | tr -d ' ')" -gt ${MAX_LOG_BYTES} ]; then mv -f "$logfile" "$logfile.1"; fi`,
    'rm -f "$pidfile"',
    'env_script=$(cat)',
    'eval "$env_script"',
    'unset env_script',
    `cd ${remotePathExpression(options.remoteProjectDir)}`,
    `nohup ${remotePathExpression(options.binaryPath)} >>"$logfile" 2>&1 </dev/null &`,
    'pid=$!',
    // Line 1 is the PID; line 2 is the reattach metadata.
    `printf '%s\\n%s\\n' "$pid" ${quoteRemoteShellArgument(JSON.stringify(options.metadata))} >"$pidfile"`,
    'printf "%s\\n" "$pid"',
  ].join('\n')
}

function buildReadPidfileCommand(workspaceKey: string): string {
  return [
    'set -eu',
    `pidfile=${runDir(workspaceKey)}/agent-runtime.pid`,
    'if test -s "$pidfile"; then cat "$pidfile"; fi',
  ].join('\n')
}

function buildRemovePidfileCommand(workspaceKey: string): string {
  return `rm -f ${runDir(workspaceKey)}/agent-runtime.pid`
}

/**
 * Shell prelude defining `is_ours`: true only when `$pid` is still the
 * agent-runtime we launched from `$bin`. A bare `kill -0` is not enough;
 * after a reboot the PID may belong to an unrelated process of this user.
 */
function identityPrelude(pid: number, binaryPath: string): string {
  return [
    `pid=${pid}`,
    `bin=${remotePathExpression(binaryPath)}`,
    'is_ours() {',
    '  test -d "/proc/$pid" || return 1',
    '  real=$(readlink -f "$bin" 2>/dev/null || printf \'%s\' "$bin")',
    '  exe=$(readlink "/proc/$pid/exe" 2>/dev/null || true)',
    '  exe=${exe% (deleted)}',
    '  if [ "$exe" = "$real" ] || [ "$exe" = "$bin" ]; then return 0; fi',
    // Script runtimes (e.g. a `#!/usr/bin/env bun` wrapper) show the
    // interpreter as exe and the launched path as an argv entry.
    '  tr \'\\0\' \'\\n\' < "/proc/$pid/cmdline" 2>/dev/null | grep -Fx -e "$bin" -e "$real" >/dev/null',
    '}',
  ].join('\n')
}

function buildIdentityCommand(pid: number, binaryPath: string): string {
  return [identityPrelude(pid, binaryPath), 'is_ours'].join('\n')
}

function buildVerifiedKillCommand(pid: number, binaryPath: string): string {
  return [
    identityPrelude(pid, binaryPath),
    'is_ours || exit 0',
    'kill -TERM "$pid" 2>/dev/null || exit 0',
    'i=0',
    'while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done',
    'if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi',
  ].join('\n')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
}

async function allocateLocalPort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (error: Error) => reject(error))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error?: Error) => {
        if (error) reject(error)
        else if (port > 0) resolve(port)
        else reject(new Error('Unable to allocate a local agent port'))
      })
    })
  })
}

export class RemoteRuntimeManager {
  readonly connection: RemoteRuntimeConnection
  readonly workspaceKey: string

  private readonly options: RemoteRuntimeOptions
  private readonly healthTimeoutMs: number
  private readonly healthPollMs: number
  private readonly healthRequestTimeoutMs: number
  private readonly idleMs: number
  private readonly recoveryThreshold: number
  private readonly fetchImpl: typeof fetch

  private record: RuntimeRecord | undefined
  private lifecycle: RemoteRuntimeLifecycle = 'stopped'
  private startPromise: Promise<RemoteRuntimeStatus> | undefined
  private stopPromise: Promise<void> | undefined
  private recoverPromise: Promise<void> | undefined
  private lastStartOverrides: RemoteRuntimeStartOverrides = {}
  private lastHealth: RemoteRuntimeHealth | undefined
  private lastError: string | undefined
  private consecutiveHealthFailures = 0
  private lastActivityAt = 0
  private idleTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: RemoteRuntimeOptions) {
    if (!options.connection) throw new TypeError('Remote SSH connection is required')
    this.connection = options.connection
    this.workspaceKey = assertWorkspaceKey(options.workspaceKey)
    if (!options.remoteProjectDir?.trim() || options.remoteProjectDir.includes('\u0000')) {
      throw new TypeError('remoteProjectDir is required')
    }
    assertPort(options.localApiPort, 'Local API port')
    if (options.localAgentPort !== undefined) assertPort(options.localAgentPort, 'Local agent port')
    if (options.remoteAgentPort !== undefined) {
      assertPort(options.remoteAgentPort, 'Remote agent port')
      assertPort(options.remoteAgentPort + 1, 'Remote API port')
    }
    if (!options.runtimeBinaryPath && !options.runtimeVersion) {
      throw new TypeError('runtimeVersion is required when runtimeBinaryPath is not provided')
    }

    this.options = { ...options, remoteProjectDir: options.remoteProjectDir.trim() }
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
    this.healthPollMs = options.healthPollMs ?? DEFAULT_HEALTH_POLL_MS
    this.healthRequestTimeoutMs = options.healthRequestTimeoutMs ?? DEFAULT_HEALTH_REQUEST_TIMEOUT_MS
    this.idleMs = options.idleMs ?? Number(process.env.RUNTIME_LOCAL_IDLE_MS ?? DEFAULT_IDLE_MS)
    this.recoveryThreshold = options.recoveryThreshold ?? DEFAULT_RECOVERY_THRESHOLD
    this.fetchImpl = options.fetch ?? globalThis.fetch
    assertNonNegativeDuration(this.healthTimeoutMs, 'healthTimeoutMs')
    assertNonNegativeDuration(this.healthPollMs, 'healthPollMs')
    assertNonNegativeDuration(this.healthRequestTimeoutMs, 'healthRequestTimeoutMs')
    assertNonNegativeDuration(this.idleMs, 'idleMs')
  }

  get remoteProjectDir(): string {
    return this.options.remoteProjectDir
  }

  async start(overrides: RemoteRuntimeStartOverrides = {}): Promise<RemoteRuntimeStatus> {
    if (this.lifecycle === 'running' && this.record) return this.status()
    if (this.startPromise) return this.startPromise

    this.lastStartOverrides = overrides
    const promise = this.startInternal(overrides)
    this.startPromise = promise
    try {
      return await promise
    } finally {
      if (this.startPromise === promise) this.startPromise = undefined
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    const promise = this.stopInternal().finally(() => {
      if (this.stopPromise === promise) this.stopPromise = undefined
    })
    this.stopPromise = promise
    return promise
  }

  async getHealth(): Promise<RemoteRuntimeHealth> {
    const record = this.record
    const checkedAt = Date.now()

    // During start(), the forwards and record are installed before the
    // readiness gate flips lifecycle from "starting" to "running".
    if (!record) {
      const health: RemoteRuntimeHealth = {
        healthy: false,
        lastCheck: checkedAt,
        url: 'http://127.0.0.1:0/health',
        error: 'Remote runtime is not running',
      }
      this.lastHealth = health
      return health
    }

    const url = `http://127.0.0.1:${record.localAgentPort}/health`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.healthRequestTimeoutMs)
    let health: RemoteRuntimeHealth
    try {
      const response = await this.fetchImpl(url, { method: 'GET', signal: controller.signal })
      health = {
        healthy: response.ok,
        lastCheck: checkedAt,
        url,
        status: response.status,
        ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
      }
    } catch (error) {
      health = { healthy: false, lastCheck: checkedAt, url, error: errorMessage(error) }
    } finally {
      clearTimeout(timer)
    }
    this.lastHealth = health
    this.trackHealth(health)
    return health
  }

  /** Keep an active editor/chat request from being reaped by idle shutdown. */
  touch(): void {
    if (this.lifecycle !== 'running' || !this.record) return
    this.lastActivityAt = Date.now()
    this.scheduleIdleShutdown()
  }

  status(): RemoteRuntimeStatus {
    const record = this.record
    return {
      workspaceKey: this.workspaceKey,
      status: this.lifecycle,
      pid: record?.pid,
      agentPort: record?.localAgentPort,
      remoteAgentPort: record?.remotePorts.agentPort,
      remoteApiPort: record?.remotePorts.apiPort,
      url: record ? `http://127.0.0.1:${record.localAgentPort}` : undefined,
      startedAt: record?.startedAt,
      reattached: record?.reattached,
      lastHealthCheck: this.lastHealth,
      error: this.lastError,
    }
  }

  private expectedVersion(): string | undefined {
    return this.options.runtimeBinaryPath ? undefined : this.options.runtimeVersion
  }

  private async startInternal(overrides: RemoteRuntimeStartOverrides): Promise<RemoteRuntimeStatus> {
    const env = overrides.env ?? this.options.env ?? {}
    this.lifecycle = 'starting'
    this.lastError = undefined
    this.lastHealth = undefined
    this.consecutiveHealthFailures = 0

    let forwards: SSHForwardHandle[] = []
    let launched: { pid: number; binaryPath: string } | undefined
    let reservedSlot: number | undefined
    try {
      const pidfile = await this.readPidfile()
      if (pidfile?.workspaceKey && pidfile.workspaceKey !== this.workspaceKey) {
        throw new Error(
          `Remote runtime pidfile belongs to workspace '${pidfile.workspaceKey}', not '${this.workspaceKey}'`,
        )
      }

      let ports: RemoteRuntimePorts | undefined
      let binaryPath: string | undefined
      let pid: number | undefined
      let startedAt = Date.now()
      let reattached = false

      if (pidfile) {
        const ours = pidfile.binaryPath
          ? await this.isOurRuntime(pidfile.pid, pidfile.binaryPath)
          : false
        const expectedVersion = this.expectedVersion()
        const current =
          ours &&
          pidfile.agentPort !== undefined &&
          pidfile.apiPort !== undefined &&
          (expectedVersion === undefined || pidfile.version === expectedVersion) &&
          (!this.options.runtimeBinaryPath || pidfile.binaryPath === this.options.runtimeBinaryPath)
        if (current) {
          ports = { agentPort: pidfile.agentPort!, apiPort: pidfile.apiPort! }
          binaryPath = pidfile.binaryPath!
          pid = pidfile.pid
          startedAt = pidfile.startedAt ?? startedAt
          reattached = true
          reservedSlot = ports.agentPort
          slotsFor(this.connection).add(reservedSlot)
        } else {
          // Outdated (app upgraded) or foreign: never leave an orphan behind,
          // and never signal a process we cannot prove we launched.
          if (ours) await this.killVerified(pidfile.pid, pidfile.binaryPath!)
          await this.connection.exec(buildRemovePidfileCommand(this.workspaceKey))
        }
      }

      if (!ports || !binaryPath || !pid) {
        const agentPort = await this.reserveAgentPort()
        reservedSlot = agentPort
        ports = { agentPort, apiPort: agentPort + 1 }

        const installed = this.options.runtimeBinaryPath
          ? { binaryPath: this.options.runtimeBinaryPath, version: undefined }
          : await this.bootstrap()
        binaryPath = installed.binaryPath
        startedAt = Date.now()
        const launch = await this.connection.exec(
          buildLaunchCommand({
            workspaceKey: this.workspaceKey,
            remoteProjectDir: this.options.remoteProjectDir,
            binaryPath,
            metadata: {
              agentPort: ports.agentPort,
              apiPort: ports.apiPort,
              workspaceKey: this.workspaceKey,
              binaryPath,
              version: installed.version ?? this.expectedVersion(),
              startedAt,
            },
          }),
          { input: buildEnvScript(this.buildRuntimeEnv(env, ports)) },
        )
        if (!commandSucceeded(launch)) throw new RemoteCommandError('remote agent-runtime launch', launch)
        pid = this.parseLaunchedPid(launch.stdout)
        launched = { pid, binaryPath }
      }

      const localAgentPort =
        overrides.localAgentPort ?? this.options.localAgentPort ?? (await allocateLocalPort())
      forwards = await this.openForwards(localAgentPort, ports)
      this.record = {
        pid,
        remotePorts: ports,
        localAgentPort,
        startedAt,
        reattached,
        forwards,
        binaryPath,
      }

      await this.waitForHealth()
      this.lifecycle = 'running'
      this.lastActivityAt = Date.now()
      this.scheduleIdleShutdown()
      return this.status()
    } catch (error) {
      await this.closeForwards(forwards)
      if (launched) {
        await this.killVerified(launched.pid, launched.binaryPath)
        await this.connection.exec(buildRemovePidfileCommand(this.workspaceKey)).catch(() => {})
      }
      if (reservedSlot !== undefined) slotsFor(this.connection).delete(reservedSlot)
      this.record = undefined
      this.lifecycle = 'error'
      this.lastError = errorMessage(error)
      throw error
    }
  }

  private async stopInternal(): Promise<void> {
    if (this.startPromise) await this.startPromise.catch(() => {})
    this.clearIdleTimer()
    const record = this.record
    this.lifecycle = 'stopping'
    try {
      let pid = record?.pid
      let binaryPath = record?.binaryPath
      if (!pid) {
        const pidfile = await this.readPidfile().catch(() => undefined)
        pid = pidfile?.pid
        binaryPath = pidfile?.binaryPath
      }
      if (pid && binaryPath) await this.killVerified(pid, binaryPath)
      await this.connection.exec(buildRemovePidfileCommand(this.workspaceKey)).catch(() => {})
    } finally {
      await this.closeForwards(record?.forwards)
      if (record) slotsFor(this.connection).delete(record.remotePorts.agentPort)
      this.record = undefined
      this.lastHealth = undefined
      this.lifecycle = 'stopped'
    }
  }

  private trackHealth(health: RemoteRuntimeHealth): void {
    if (this.lifecycle !== 'running' || this.recoverPromise) return
    if (health.healthy) {
      this.consecutiveHealthFailures = 0
      return
    }
    this.consecutiveHealthFailures++
    if (this.recoveryThreshold > 0 && this.consecutiveHealthFailures >= this.recoveryThreshold) {
      this.recoverPromise = this.recover().finally(() => {
        this.recoverPromise = undefined
      })
    }
  }

  /**
   * Re-establish the transport and forwards after repeated health failures
   * (network drop, laptop sleep, SSH master exit). The detached remote
   * process normally survives and is reattached; a dead one is relaunched.
   */
  private async recover(): Promise<void> {
    const record = this.record
    this.clearIdleTimer()
    this.record = undefined
    this.lifecycle = 'starting'
    await this.closeForwards(record?.forwards)
    if (record) slotsFor(this.connection).delete(record.remotePorts.agentPort)
    try {
      await this.connection.status?.()
    } catch {
      // The next command reconnects regardless.
    }
    try {
      await this.start({
        ...this.lastStartOverrides,
        localAgentPort: record?.localAgentPort ?? this.lastStartOverrides.localAgentPort,
      })
    } catch {
      // startInternal recorded the error and set lifecycle to 'error'.
    }
  }

  private async readPidfile(): Promise<PidfileRecord | undefined> {
    const result = await this.connection.exec(buildReadPidfileCommand(this.workspaceKey))
    if (!commandSucceeded(result)) {
      throw new RemoteCommandError('read remote runtime pidfile', result)
    }
    return parsePidfile(result.stdout)
  }

  private async isOurRuntime(pid: number, binaryPath: string): Promise<boolean> {
    try {
      return commandSucceeded(await this.connection.exec(buildIdentityCommand(pid, binaryPath)))
    } catch {
      return false
    }
  }

  private async killVerified(pid: number, binaryPath: string): Promise<void> {
    try {
      await this.connection.exec(buildVerifiedKillCommand(pid, binaryPath))
    } catch {
      // The SSH session may be gone; the next start re-verifies identity.
    }
  }

  private reserveAgentPort(): Promise<number> {
    return withAllocationLock(this.connection, async () => {
      const slots = slotsFor(this.connection)
      let agentPort = this.options.remoteAgentPort
      if (agentPort === undefined) {
        const allocator = this.options.portAllocator ?? allocateRemotePortSlot
        agentPort = await allocator(this.connection, {
          start: DEFAULT_REMOTE_PORT_START,
          end: DEFAULT_REMOTE_PORT_END,
          slotSize: REMOTE_PORT_SLOT_SIZE,
          exclude: [...slots],
        })
      }
      slots.add(agentPort)
      return agentPort
    })
  }

  private async bootstrap(): Promise<{ binaryPath: string; version?: string }> {
    const version = this.options.runtimeVersion!
    const bootstrap = this.options.bootstrap ?? bootstrapRemoteRuntime
    const result = await bootstrap(this.connection, {
      ...this.options.bootstrapOptions,
      version,
      fetch: this.options.bootstrapOptions?.fetch ?? this.options.fetch,
    })
    if (!result.binaryPath?.trim()) throw new Error('Remote runtime bootstrap did not return a binary path')
    return { binaryPath: result.binaryPath.trim(), version: result.version ?? version }
  }

  private buildRuntimeEnv(input: Record<string, string>, ports: RemoteRuntimePorts): Record<string, string> {
    const env = localApiEnv(input, `http://127.0.0.1:${ports.apiPort}`)
    env.WORKSPACE_DIR = this.options.remoteProjectDir
    env.PROJECT_DIR = this.options.remoteProjectDir
    env.PORT = String(ports.agentPort)
    env.API_SERVER_PORT = String(ports.apiPort)
    env.SKILL_SERVER_PORT = String(ports.apiPort)
    env.WORKSPACE_API_PORT_BASE = String(ports.agentPort + 2)
    env.NODE_ENV ??= 'production'
    env.STARTUP_TIME = String(Date.now())
    env.HOST = '127.0.0.1'
    if (!env.RUNTIME_AUTH_SECRET) {
      throw new Error('RUNTIME_AUTH_SECRET is required for a remote agent-runtime')
    }
    return env
  }

  private parseLaunchedPid(stdout: string): number {
    const candidates = stdout.trim().split(/\s+/).reverse()
    const pid = Number(candidates.find((candidate) => /^\d+$/.test(candidate)))
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error('Remote agent-runtime launch did not return a valid PID')
    }
    return pid
  }

  private async openForwards(
    localAgentPort: number,
    remotePorts: RemoteRuntimePorts,
  ): Promise<SSHForwardHandle[]> {
    const forwards: SSHForwardHandle[] = []
    try {
      forwards.push(await this.connection.forward(localAgentPort, `127.0.0.1:${remotePorts.agentPort}`))
      forwards.push(await this.connection.reverseForward(remotePorts.apiPort, this.options.localApiPort))
      return forwards
    } catch (error) {
      await this.closeForwards(forwards)
      throw error
    }
  }

  private async closeForwards(forwards: SSHForwardHandle[] | undefined): Promise<void> {
    if (!forwards) return
    for (const forward of [...forwards].reverse()) {
      try {
        await forward.close()
      } catch {
        // Closing is best effort and must not leak the other direction.
      }
    }
  }

  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + this.healthTimeoutMs
    let lastError = 'unknown health error'
    while (Date.now() <= deadline) {
      const health = await this.getHealth()
      if (health.healthy) return
      lastError = health.error ?? `HTTP ${health.status ?? 'request failure'}`
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await sleep(Math.min(this.healthPollMs, remaining))
    }
    throw new Error(`Timeout waiting for remote agent-runtime /health: ${lastError}`)
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleTimer()
    if (this.idleMs <= 0 || this.lifecycle !== 'running' || !this.record) return
    const expectedActivity = this.lastActivityAt
    const timer = setTimeout(() => {
      this.idleTimer = undefined
      if (
        this.lifecycle === 'running' &&
        this.record &&
        this.lastActivityAt === expectedActivity &&
        Date.now() - expectedActivity >= this.idleMs
      ) {
        void this.stop().catch((error) => {
          this.lastError = errorMessage(error)
        })
      } else {
        this.scheduleIdleShutdown()
      }
    }, this.idleMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    this.idleTimer = timer
  }
}
