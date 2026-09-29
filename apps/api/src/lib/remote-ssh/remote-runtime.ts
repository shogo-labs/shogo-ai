// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Lifecycle management for an agent-runtime running on an SSH host.
 *
 * The SSH connection is deliberately the only transport dependency here.
 * The runtime is a detached remote process; the agent HTTP port is forwarded
 * to this process and the runtime's API port is reverse-forwarded back to the
 * API process that owns this manager.
 */

import { deriveWorkspaceRuntimeToken } from '../workspace-runtime-token'
import {
  bootstrapRemoteRuntime,
  shellQuote,
  type RemoteRuntimeBootstrapOptions,
  type RemoteRuntimeBootstrapResult,
  type RemoteSshConnection,
} from './bootstrap'
import {
  type SSHForwardHandle,
  type SSHConnection,
} from './connection'

const DEFAULT_LOCAL_API_PORT = 8002
const DEFAULT_REMOTE_PORT_START = 37_100
const DEFAULT_REMOTE_PORT_END = 37_900
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000
const DEFAULT_HEALTH_POLL_MS = 500
const DEFAULT_HEALTH_REQUEST_TIMEOUT_MS = 1_500
const DEFAULT_IDLE_MS = 45 * 60 * 1000
const RUN_ROOT = '~/.shogo-server/run'

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

/**
 * The portion of SSHConnection used by the manager. It is exported so unit
 * tests and embedders can provide a fake connection without an SSH daemon.
 */
export interface RemoteRuntimeConnection {
  exec(command: string): Promise<{
    stdout: string
    stderr?: string
    exitCode?: number | null
    code?: number
    status?: number
  }>
  upload(localPath: string, remotePath: string): Promise<void>
  forward(localPort: number, remoteHostPort: string): Promise<SSHForwardHandle>
  reverseForward(remotePort: number, localPort: number): Promise<SSHForwardHandle>
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
) => Promise<RemoteRuntimeBootstrapResult | { binaryPath: string } | string>

export type RemoteRuntimePortAllocator = (
  connection: RemoteRuntimeConnection,
  options: {
    start: number
    end: number
  },
) => Promise<RemoteRuntimePorts>

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
  /** Local API port used by the reverse forward. */
  apiPort: number
  remoteAgentPort?: number
  remoteApiPort?: number
  url?: string
  startedAt?: number
  reattached?: boolean
  lastHealthCheck?: RemoteRuntimeHealth
  error?: string
}

export interface RemoteRuntimeConfig {
  /** Stable, path-safe key used below ~/.shogo-server/run/. */
  workspaceKey: string
  /** Directory containing the project on the SSH host. */
  remoteProjectDir?: string
  /** Alias accepted by callers that already use projectDir terminology. */
  projectDir?: string
  env?: Record<string, string>
  /** Local API port reached by the SSH reverse forward. */
  localApiPort?: number
  /** Local port for the -L agent forward. Omit to allocate an ephemeral port. */
  localAgentPort?: number
  /** Remote agent/API ports. If omitted, the manager probes a remote range. */
  remoteAgentPort?: number
  remoteApiPort?: number
  /** Short aliases for the remote ports. */
  agentPort?: number
  apiPort?: number
  /** Alias for remoteProjectDir. */
  workspaceDir?: string
  /** Override the token already present in env. */
  runtimeAuthSecret?: string
  /** Installed binary path on the remote host. */
  runtimeBinaryPath?: string
  /** Alias for runtimeBinaryPath. */
  binaryPath?: string
  runtimeVersion?: string
  /** Alias for runtimeVersion. */
  version?: string
  bootstrapOptions?: Omit<RemoteRuntimeBootstrapOptions, 'version'> & {
    version?: string
  }
  bootstrap?: RemoteRuntimeBootstrapper
  /** Alias for bootstrap. */
  bootstrapRuntime?: RemoteRuntimeBootstrapper
  portAllocator?: RemoteRuntimePortAllocator
  /** Alias for portAllocator. */
  allocatePorts?: RemoteRuntimePortAllocator
  healthTimeoutMs?: number
  healthPollMs?: number
  healthRequestTimeoutMs?: number
  /** Stop the detached runtime after this much time without activity. 0 disables it. */
  idleMs?: number
  fetch?: typeof fetch
}

export type RemoteRuntimeManagerOptions = RemoteRuntimeConfig & {
  connection: RemoteRuntimeConnection | SSHConnection
}

export type RemoteRuntimeStartOverrides = Partial<
  Pick<
    RemoteRuntimeConfig,
    | 'remoteProjectDir'
    | 'projectDir'
    | 'workspaceDir'
    | 'env'
    | 'localApiPort'
    | 'localAgentPort'
    | 'remoteAgentPort'
    | 'remoteApiPort'
    | 'agentPort'
    | 'apiPort'
    | 'runtimeAuthSecret'
    | 'runtimeBinaryPath'
    | 'binaryPath'
  >
>

interface PidfileRecord {
  pid: number
  agentPort?: number
  apiPort?: number
  workspaceKey?: string
  binaryPath?: string
  projectDir?: string
  startedAt?: number
}

interface RuntimeRecord {
  pid: number
  remotePorts: RemoteRuntimePorts
  localAgentPort: number
  localApiPort: number
  startedAt: number
  reattached: boolean
  forwards: SSHForwardHandle[]
  binaryPath: string
}

interface ResolvedConfig {
  workspaceKey: string
  remoteProjectDir: string
  env: Record<string, string>
  localApiPort: number
  localAgentPort?: number
  remoteAgentPort?: number
  remoteApiPort?: number
  runtimeAuthSecret?: string
  runtimeBinaryPath?: string
  runtimeVersion?: string
  bootstrapOptions: RemoteRuntimeConfig['bootstrapOptions']
  bootstrap: RemoteRuntimeBootstrapper
  portAllocator?: RemoteRuntimePortAllocator
  healthTimeoutMs: number
  healthPollMs: number
  healthRequestTimeoutMs: number
  idleMs: number
  fetch: typeof fetch
}

interface CommandResult {
  exitCode?: number | null
  code?: number
  status?: number
}

function getExitCode(result: CommandResult): number | null | undefined {
  if (result.exitCode !== undefined) return result.exitCode
  if ('code' in result && result.code !== undefined) return result.code
  if ('status' in result && result.status !== undefined) return result.status
  return undefined
}

function commandSucceeded(result: CommandResult): boolean {
  const code = getExitCode(result)
  // A few injected connection implementations omit exitCode on success.
  return code === undefined || code === 0
}

function assertPort(port: number, name: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError(`${name} must be an integer between 1 and 65535`)
  }
}

function assertPositiveDuration(value: number, name: string): void {
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

function assertNoNul(value: string, name: string): void {
  if (value.includes('\u0000')) throw new TypeError(`${name} cannot contain NUL bytes`)
}

function quote(value: string): string {
  assertNoNul(value, 'Remote shell value')
  return shellQuote(value)
}

/**
 * Quote a path while retaining expansion for the two path spellings commonly
 * returned by bootstrap.ts (`~/.shogo-server/...` and `$HOME/...`).
 */
function quoteRemotePath(value: string): string {
  assertNoNul(value, 'Remote path')
  if (value.startsWith('~/')) {
    return `"$HOME/"${quote(value.slice(2))}`
  }
  if (value.startsWith('$HOME/')) {
    return `"$HOME/"${quote(value.slice('$HOME/'.length))}`
  }
  return quote(value)
}

function normalizePathValue(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new TypeError('remoteProjectDir is required')
  assertNoNul(trimmed, 'remoteProjectDir')
  return trimmed
}

function normalizeBootstrapResult(
  result: RemoteRuntimeBootstrapResult | { binaryPath: string } | string,
): string {
  const binaryPath = typeof result === 'string' ? result : result.binaryPath
  if (!binaryPath?.trim()) throw new Error('Remote runtime bootstrap did not return a binary path')
  return binaryPath.trim()
}

function parsePortPair(stdout: string): RemoteRuntimePorts | undefined {
  const fields = stdout.trim().split(/\s+/)
  if (fields.length < 2) return undefined
  const agentPort = Number(fields[0])
  const apiPort = Number(fields[1])
  try {
    assertPort(agentPort, 'Remote agent port')
    assertPort(apiPort, 'Remote API port')
  } catch {
    return undefined
  }
  if (agentPort === apiPort) return undefined
  return { agentPort, apiPort }
}

function buildRemotePortProbeCommand(start: number, end: number): string {
  const candidates: string[] = []
  for (let port = start; port < end; port += 2) {
    if (port + 1 <= end) candidates.push(`(${port}, ${port + 1})`)
  }
  const ports = candidates.join(', ')
  const python = [
    'import socket,sys',
    `pairs=[${ports}]`,
    'for a,b in pairs:',
    ' s=[]',
    ' try:',
    '  for p in (a,b):',
    '   x=socket.socket(); x.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); x.bind(("127.0.0.1",p)); s.append(x)',
    '  print(f"{a} {b}")',
    '  sys.exit(0)',
    ' except OSError:',
    '  [x.close() for x in s]',
    'sys.exit(1)',
  ].join('\n')
  const ncCandidates = candidates
    .map((pair) => {
      const [agent, api] = pair.replace(/[() ]/g, '').split(',')
      return `if ! nc -z 127.0.0.1 ${agent} 2>/dev/null && ! nc -z 127.0.0.1 ${api} 2>/dev/null; then printf '%s %s\\n' ${agent} ${api}; exit 0; fi`
    })
    .join(' ')
  return [
    'set -eu',
    `if command -v python3 >/dev/null 2>&1; then python3 -c ${quote(python)}`,
    `elif command -v python >/dev/null 2>&1; then python -c ${quote(python)}`,
    `elif command -v nc >/dev/null 2>&1; then ${ncCandidates}`,
    'fi',
    'exit 1',
  ].join('\n')
}

/**
 * Probe a remote high-port range for two adjacent free loopback ports.
 *
 * The probe is intentionally injectable through `portAllocator`; callers
 * that have a scheduler or a reserved remote port range can avoid probing.
 */
async function allocateRemotePorts(
  connection: RemoteRuntimeConnection,
  options: { start: number; end: number },
): Promise<RemoteRuntimePorts> {
  assertPort(options.start, 'Remote port range start')
  assertPort(options.end, 'Remote port range end')
  if (options.start >= options.end) throw new RangeError('Remote port range is empty')

  const result = await connection.exec(buildRemotePortProbeCommand(options.start, options.end))
  if (!commandSucceeded(result)) {
    throw new Error(
      `Unable to allocate remote agent/API ports in ${options.start}-${options.end}`,
    )
  }
  const ports = parsePortPair(result.stdout)
  if (!ports) {
    throw new Error(
      `Remote port allocator returned invalid ports in ${options.start}-${options.end}`,
    )
  }
  return ports
}

function parsePidfile(stdout: string): PidfileRecord | undefined {
  const text = stdout.trim()
  if (!text) return undefined
  if (text.startsWith('{')) {
    try {
      const metadata = JSON.parse(text) as Partial<PidfileRecord>
      const pid = Number(metadata.pid)
      if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
      return {
        pid,
        agentPort: typeof metadata.agentPort === 'number' ? metadata.agentPort : undefined,
        apiPort: typeof metadata.apiPort === 'number' ? metadata.apiPort : undefined,
        workspaceKey: typeof metadata.workspaceKey === 'string' ? metadata.workspaceKey : undefined,
        binaryPath: typeof metadata.binaryPath === 'string' ? metadata.binaryPath : undefined,
        projectDir: typeof metadata.projectDir === 'string' ? metadata.projectDir : undefined,
        startedAt: typeof metadata.startedAt === 'number' ? metadata.startedAt : undefined,
      }
    } catch {
      return undefined
    }
  }
  const lines = text.split(/\r?\n/)
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
      projectDir: typeof metadata.projectDir === 'string' ? metadata.projectDir : undefined,
      startedAt: typeof metadata.startedAt === 'number' ? metadata.startedAt : undefined,
    }
  } catch {
    // A PID-only pidfile is supported for compatibility with early launchers.
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

function localApiEnv(
  input: Record<string, string>,
  localApiBase: string,
): Record<string, string> {
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

function buildPidfileMetadata(
  ports: RemoteRuntimePorts,
  config: ResolvedConfig,
  binaryPath: string,
  startedAt: number,
): string {
  return JSON.stringify({
    agentPort: ports.agentPort,
    apiPort: ports.apiPort,
    workspaceKey: config.workspaceKey,
    binaryPath,
    projectDir: config.remoteProjectDir,
    startedAt,
  })
}

function buildLaunchCommand(
  ports: RemoteRuntimePorts,
  config: ResolvedConfig,
  binaryPath: string,
  startedAt: number,
): string {
  const key = config.workspaceKey
  const metadata = buildPidfileMetadata(ports, config, binaryPath, startedAt)
  const envArgs = Object.entries(config.env).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError(`Invalid remote environment variable name '${name}'`)
    }
    return quote(`${name}=${value}`)
  })

  return [
    'set -eu',
    `run_dir="$HOME/.shogo-server/run/${key}"`,
    'mkdir -p "$run_dir"',
    'pidfile="$run_dir/agent-runtime.pid"',
    'logfile="$run_dir/agent-runtime.log"',
    'rm -f "$pidfile"',
    `cd ${quoteRemotePath(config.remoteProjectDir)}`,
    `nohup env ${envArgs.join(' ')} ${quoteRemotePath(binaryPath)} >>"$logfile" 2>&1 </dev/null &`,
    'pid=$!',
    // The first line is intentionally the PID, so simple existing launchers
    // can still inspect the pidfile. The second line contains reattach data.
    `printf '%s\\n%s\\n' "$pid" ${quote(metadata)} >"$pidfile"`,
    'printf "%s\\n" "$pid"',
  ].join('\n')
}

function buildReadPidfileCommand(workspaceKey: string): string {
  return [
    'set -eu',
    `pidfile="$HOME/.shogo-server/run/${workspaceKey}/agent-runtime.pid"`,
    'if test -s "$pidfile"; then cat "$pidfile"; fi',
  ].join('\n')
}

function buildKillCommand(pid: number): string {
  return `kill -TERM ${pid} 2>/dev/null || true`
}

function buildRemovePidfileCommand(workspaceKey: string): string {
  return `rm -f "$HOME/.shogo-server/run/${workspaceKey}/agent-runtime.pid"`
}

function makeHealthUrl(localPort: number, healthPath: string): string {
  const path = healthPath.startsWith('/') ? healthPath : `/${healthPath}`
  return `http://127.0.0.1:${localPort}${path}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
}

export class RemoteRuntimeManager {
  readonly connection: RemoteRuntimeConnection
  readonly config: Readonly<RemoteRuntimeManagerOptions>

  private record: RuntimeRecord | undefined
  private lifecycle: RemoteRuntimeLifecycle = 'stopped'
  private startPromise: Promise<RemoteRuntimeStatus> | undefined
  private lastHealth: RemoteRuntimeHealth | undefined
  private lastError: string | undefined
  private lastActivityAt = 0
  private idleTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: RemoteRuntimeManagerOptions)
  constructor(
    connection: RemoteRuntimeConnection | SSHConnection,
    options: Omit<RemoteRuntimeManagerOptions, 'connection'>,
  )
  constructor(
    connectionOrOptions: RemoteRuntimeManagerOptions | RemoteRuntimeConnection | SSHConnection,
    maybeOptions?: Omit<RemoteRuntimeManagerOptions, 'connection'>,
  ) {
    const options =
      maybeOptions === undefined
        ? (connectionOrOptions as RemoteRuntimeManagerOptions)
        : { ...maybeOptions, connection: connectionOrOptions as RemoteRuntimeConnection }
    const connection = options.connection
    if (!connection) throw new TypeError('Remote SSH connection is required')
    // SSHConnection returns `exitCode: null` when a child never produced a
    // normal exit code; the narrow manager seam intentionally allows that
    // transport detail while bootstrap.ts normalizes it at its boundary.
    this.connection = connection as RemoteRuntimeConnection
    this.config = { ...options }
    // Validate eagerly so configuration mistakes fail before an SSH command.
    this.resolveConfig()
  }

  async start(overrides: RemoteRuntimeStartOverrides = {}): Promise<RemoteRuntimeStatus> {
    if (this.lifecycle === 'running' && this.record) return this.status()
    if (this.startPromise) return this.startPromise

    const promise = this.startInternal(overrides)
    this.startPromise = promise
    try {
      return await promise
    } finally {
      if (this.startPromise === promise) this.startPromise = undefined
    }
  }

  async stop(): Promise<void> {
    if (this.lifecycle === 'stopping') return
    this.lifecycle = 'stopping'
    const record = this.record
    let pid = record?.pid

    try {
      if (!pid) {
        const config = this.resolveConfig()
        const pidfile = await this.readPidfile(config)
        pid = pidfile?.pid
      }
      if (pid) {
        try {
          await this.connection.exec(buildKillCommand(pid))
        } catch {
          // The process may already have exited or the SSH session may be
          // closing; forward cleanup below is still required.
        }
      }
      try {
        await this.connection.exec(buildRemovePidfileCommand(this.resolveConfig().workspaceKey))
      } catch {
        // Best effort. A later start verifies kill -0 before reattaching.
      }
    } finally {
      this.clearIdleTimer()
      await this.closeForwards(record?.forwards)
      this.record = undefined
      this.lastHealth = undefined
      this.lifecycle = 'stopped'
    }
  }

  async restart(overrides: RemoteRuntimeStartOverrides = {}): Promise<RemoteRuntimeStatus> {
    await this.stop()
    return this.start(overrides)
  }

  async getHealth(): Promise<RemoteRuntimeHealth> {
    const record = this.record
    const localPort = record?.localAgentPort
    const url = localPort
      ? makeHealthUrl(localPort, '/health')
      : 'http://127.0.0.1:0/health'
    const checkedAt = Date.now()

    // During start(), the forwards and record are installed before the
    // readiness gate flips lifecycle from "starting" to "running".
    if (!localPort || !record) {
      const health: RemoteRuntimeHealth = {
        healthy: false,
        lastCheck: checkedAt,
        url,
        error: 'Remote runtime is not running',
      }
      this.lastHealth = health
      return health
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.resolveConfig().healthRequestTimeoutMs)
    try {
      const response = await this.resolveConfig().fetch(url, {
        method: 'GET',
        signal: controller.signal,
      })
      const health: RemoteRuntimeHealth = {
        healthy: response.ok,
        lastCheck: checkedAt,
        url,
        status: response.status,
        ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
      }
      this.lastHealth = health
      return health
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const health: RemoteRuntimeHealth = {
        healthy: false,
        lastCheck: checkedAt,
        url,
        error: message,
      }
      this.lastHealth = health
      return health
    } finally {
      clearTimeout(timer)
    }
  }

  /** Keep an active editor/chat request from being reaped by idle shutdown. */
  touch(): void {
    if (this.lifecycle !== 'running' || !this.record) return
    this.lastActivityAt = Date.now()
    this.scheduleIdleShutdown()
  }

  status(): RemoteRuntimeStatus {
    const config = this.resolveConfig()
    const record = this.record
    return {
      workspaceKey: config.workspaceKey,
      status: this.lifecycle,
      pid: record?.pid,
      agentPort: record?.localAgentPort,
      apiPort: record?.localApiPort ?? config.localApiPort,
      remoteAgentPort: record?.remotePorts.agentPort,
      remoteApiPort: record?.remotePorts.apiPort,
      url: record?.localAgentPort
        ? `http://127.0.0.1:${record.localAgentPort}`
        : undefined,
      startedAt: record?.startedAt,
      reattached: record?.reattached,
      lastHealthCheck: this.lastHealth,
      error: this.lastError,
    }
  }

  /** Alias useful to owners that treat the manager as a disposable resource. */
  async close(): Promise<void> {
    await this.stop()
  }

  private resolveConfig(overrides: RemoteRuntimeStartOverrides = {}): ResolvedConfig {
    const source = { ...this.config, ...overrides }
    const workspaceKey = assertWorkspaceKey(source.workspaceKey)
    const remoteProjectDir = normalizePathValue(
      source.remoteProjectDir ?? source.projectDir ?? source.workspaceDir ?? '',
    )
    const localApiPort =
      source.localApiPort ?? Number(process.env.API_PORT ?? DEFAULT_LOCAL_API_PORT)
    assertPort(localApiPort, 'Local API port')
    const localAgentPort = source.localAgentPort
    if (localAgentPort !== undefined) assertPort(localAgentPort, 'Local agent port')

    const remoteAgentPort = source.remoteAgentPort ?? source.agentPort
    const remoteApiPort = source.remoteApiPort ?? source.apiPort
    if (remoteAgentPort !== undefined) assertPort(remoteAgentPort, 'Remote agent port')
    if (remoteApiPort !== undefined) assertPort(remoteApiPort, 'Remote API port')

    const healthTimeoutMs = source.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
    const healthPollMs = source.healthPollMs ?? DEFAULT_HEALTH_POLL_MS
    const healthRequestTimeoutMs =
      source.healthRequestTimeoutMs ?? DEFAULT_HEALTH_REQUEST_TIMEOUT_MS
    const idleMs =
      source.idleMs ??
      Number(process.env.RUNTIME_LOCAL_IDLE_MS ?? String(DEFAULT_IDLE_MS))
    assertPositiveDuration(healthTimeoutMs, 'healthTimeoutMs')
    assertPositiveDuration(healthPollMs, 'healthPollMs')
    assertPositiveDuration(healthRequestTimeoutMs, 'healthRequestTimeoutMs')
    assertPositiveDuration(idleMs, 'idleMs')

    const bootstrap = source.bootstrap ?? source.bootstrapRuntime ?? bootstrapRemoteRuntime
    const portAllocator = source.portAllocator ?? source.allocatePorts
    return {
      workspaceKey,
      remoteProjectDir,
      env: { ...(source.env ?? {}) },
      localApiPort,
      localAgentPort,
      remoteAgentPort,
      remoteApiPort,
      runtimeAuthSecret: source.runtimeAuthSecret,
      runtimeBinaryPath: source.runtimeBinaryPath ?? source.binaryPath,
      runtimeVersion: source.runtimeVersion ?? source.version,
      bootstrapOptions: source.bootstrapOptions,
      bootstrap,
      portAllocator,
      healthTimeoutMs,
      healthPollMs,
      healthRequestTimeoutMs,
      idleMs,
      fetch: source.fetch ?? globalThis.fetch,
    }
  }

  private async startInternal(overrides: RemoteRuntimeStartOverrides): Promise<RemoteRuntimeStatus> {
    const config = this.resolveConfig(overrides)
    this.lifecycle = 'starting'
    this.lastError = undefined
    this.lastHealth = undefined

    let forwards: SSHForwardHandle[] = []
    let launchedPid: number | undefined
    try {
      const pidfile = await this.readPidfile(config)
      if (pidfile?.workspaceKey && pidfile.workspaceKey !== config.workspaceKey) {
        throw new Error(
          `Remote runtime pidfile belongs to workspace '${pidfile.workspaceKey}', not '${config.workspaceKey}'`,
        )
      }
      const reattach = pidfile ? await this.isAlive(pidfile.pid) : false

      let ports: RemoteRuntimePorts
      let binaryPath = config.runtimeBinaryPath ?? pidfile?.binaryPath
      let pid: number
      let startedAt = pidfile?.startedAt ?? Date.now()
      let reattached = false

      if (reattach) {
        if (!pidfile) throw new Error('Remote runtime pidfile disappeared while reattaching')
        ports = this.portsFromPidfile(pidfile, config)
        if (!binaryPath) {
          throw new Error(
            'Cannot reattach remote runtime: pidfile has no binary path and runtimeBinaryPath is unset',
          )
        }
        pid = pidfile.pid
        reattached = true
      } else {
        ports = await this.resolveRemotePorts(config)
        binaryPath = binaryPath ?? (await this.bootstrap(config))
        startedAt = Date.now()
        const launch = await this.connection.exec(
          buildLaunchCommand(
            ports,
            {
              ...config,
              env: this.buildRuntimeEnv(config, ports),
            },
            binaryPath,
            startedAt,
          ),
        )
        if (!commandSucceeded(launch)) {
          throw new Error(
            `Failed to start remote agent-runtime${launch.stderr ? `: ${launch.stderr.trim()}` : ''}`,
          )
        }
        pid = this.parseLaunchedPid(launch.stdout)
        launchedPid = pid
      }

      const localAgentPort = config.localAgentPort ?? (await this.allocateLocalPort())
      forwards = await this.openForwards(
        localAgentPort,
        ports,
        config.localApiPort,
      )
      this.record = {
        pid,
        remotePorts: ports,
        localAgentPort,
        localApiPort: config.localApiPort,
        startedAt,
        reattached,
        forwards,
        binaryPath,
      }

      await this.waitForHealth(config.healthTimeoutMs, config.healthPollMs)
      this.lifecycle = 'running'
      this.lastActivityAt = Date.now()
      this.scheduleIdleShutdown()
      return this.status()
    } catch (error) {
      await this.closeForwards(forwards)
      if (launchedPid) {
        try {
          await this.connection.exec(buildKillCommand(launchedPid))
        } catch {
          // The remote process may have exited while the readiness gate ran.
        }
        try {
          await this.connection.exec(buildRemovePidfileCommand(config.workspaceKey))
        } catch {
          // Best effort cleanup; the next start still verifies kill -0.
        }
      }
      this.record = undefined
      this.lifecycle = 'error'
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  private async readPidfile(config: ResolvedConfig): Promise<PidfileRecord | undefined> {
    try {
      const result = await this.connection.exec(buildReadPidfileCommand(config.workspaceKey))
      if (!commandSucceeded(result)) return undefined
      return parsePidfile(result.stdout)
    } catch {
      return undefined
    }
  }

  private async isAlive(pid: number): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    try {
      const result = await this.connection.exec(`kill -0 ${pid} 2>/dev/null`)
      return commandSucceeded(result)
    } catch {
      return false
    }
  }

  private portsFromPidfile(pidfile: PidfileRecord, config: ResolvedConfig): RemoteRuntimePorts {
    const agentPort = pidfile.agentPort ?? config.remoteAgentPort
    const apiPort = pidfile.apiPort ?? config.remoteApiPort
    if (agentPort === undefined || apiPort === undefined) {
      throw new Error(
        'Cannot reattach remote runtime: pidfile has no remote ports; configure remoteAgentPort and remoteApiPort',
      )
    }
    assertPort(agentPort, 'Remote agent port')
    assertPort(apiPort, 'Remote API port')
    return { agentPort, apiPort }
  }

  private async resolveRemotePorts(config: ResolvedConfig): Promise<RemoteRuntimePorts> {
    const agentPort = config.remoteAgentPort
    const apiPort = config.remoteApiPort
    if (agentPort !== undefined && apiPort !== undefined) {
      return { agentPort, apiPort }
    }
    if (agentPort !== undefined) {
      const adjacentApi = agentPort + 1
      assertPort(adjacentApi, 'Remote API port')
      return { agentPort, apiPort: adjacentApi }
    }
    if (apiPort !== undefined) {
      const adjacentAgent = apiPort - 1
      assertPort(adjacentAgent, 'Remote agent port')
      return { agentPort: adjacentAgent, apiPort }
    }
    const allocator = config.portAllocator ?? allocateRemotePorts
    return allocator(this.connection, {
      start: DEFAULT_REMOTE_PORT_START,
      end: DEFAULT_REMOTE_PORT_END,
    })
  }

  private async bootstrap(config: ResolvedConfig): Promise<string> {
    const version =
      config.bootstrapOptions?.version ??
      config.runtimeVersion ??
      process.env.SHOGO_AGENT_RUNTIME_VERSION ??
      process.env.SHOGO_RUNTIME_VERSION
    if (!version) {
      throw new Error(
        'runtimeVersion is required when runtimeBinaryPath is not provided',
      )
    }
    const options: RemoteRuntimeBootstrapOptions = {
      ...(config.bootstrapOptions ?? {}),
      version,
      fetch: config.bootstrapOptions?.fetch ?? config.fetch,
    }
    const connection: RemoteSshConnection = {
      exec: async (command) => {
        const result = await this.connection.exec(command)
        // bootstrap.ts treats an omitted exit code as success. SSHConnection
        // uses null for a process that never produced a normal exit code.
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          // bootstrap.ts uses an omitted exit code for wrappers that do not
          // report one. SSHConnection's null specifically means its local
          // ssh/scp process failed before producing an exit code, so preserve
          // that as a failure rather than accidentally treating it as success.
          exitCode: result.exitCode === null ? 1 : result.exitCode,
        }
      },
      upload: async (localPath, remotePath) => this.connection.upload(localPath, remotePath),
    }
    return normalizeBootstrapResult(await config.bootstrap(connection, options))
  }

  private buildRuntimeEnv(
    config: ResolvedConfig,
    ports: RemoteRuntimePorts,
  ): Record<string, string> {
    const localApiBase = `http://127.0.0.1:${ports.apiPort}`
    const env = localApiEnv(config.env, localApiBase)
    env.WORKSPACE_DIR = config.remoteProjectDir
    env.PROJECT_DIR = config.remoteProjectDir
    env.PORT = String(ports.agentPort)
    env.API_SERVER_PORT = String(ports.apiPort)
    env.SKILL_SERVER_PORT = String(ports.apiPort)
    // Keep workspace preview sidecars in a per-runtime range, matching the
    // worker manager's agent(+0), API(+1), sidecars(+2...) convention.
    env.WORKSPACE_API_PORT_BASE = String(ports.agentPort + 2)
    env.NODE_ENV ??= 'production'
    env.STARTUP_TIME = String(Date.now())
    env.HOST = '127.0.0.1'
    env.RUNTIME_AUTH_SECRET =
      config.runtimeAuthSecret ??
      env.RUNTIME_AUTH_SECRET ??
      deriveWorkspaceRuntimeToken(config.workspaceKey)
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

  private async allocateLocalPort(): Promise<number> {
    // Importing net at module load would make the launcher harder to embed in
    // runtimes that provide their own process shims. This path is only used
    // when a caller does not provide a stable local port.
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

  private async openForwards(
    localAgentPort: number,
    remotePorts: RemoteRuntimePorts,
    localApiPort: number,
  ): Promise<SSHForwardHandle[]> {
    const forwards: SSHForwardHandle[] = []
    try {
      forwards.push(
        await this.connection.forward(localAgentPort, `127.0.0.1:${remotePorts.agentPort}`),
      )
      forwards.push(await this.connection.reverseForward(remotePorts.apiPort, localApiPort))
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

  private async waitForHealth(timeoutMs: number, pollMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastError = 'unknown health error'
    while (Date.now() <= deadline) {
      const health = await this.getHealth()
      if (health.healthy) return
      lastError = health.error ?? `HTTP ${health.status ?? 'request failure'}`
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await sleep(Math.min(pollMs, remaining))
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
    const idleMs = this.resolveConfig().idleMs
    if (idleMs <= 0 || this.lifecycle !== 'running' || !this.record) return
    const expectedActivity = this.lastActivityAt
    const timer = setTimeout(() => {
      this.idleTimer = undefined
      if (
        this.lifecycle === 'running' &&
        this.record &&
        this.lastActivityAt === expectedActivity &&
        Date.now() - expectedActivity >= idleMs
      ) {
        void this.stop().catch((error) => {
          this.lastError = error instanceof Error ? error.message : String(error)
        })
      } else {
        this.scheduleIdleShutdown()
      }
    }, idleMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    this.idleTimer = timer
  }
}

export function createRemoteRuntimeManager(
  options: RemoteRuntimeManagerOptions,
): RemoteRuntimeManager
export function createRemoteRuntimeManager(
  connection: RemoteRuntimeConnection | SSHConnection,
  options: Omit<RemoteRuntimeManagerOptions, 'connection'>,
): RemoteRuntimeManager
export function createRemoteRuntimeManager(
  connectionOrOptions: RemoteRuntimeManagerOptions | RemoteRuntimeConnection | SSHConnection,
  maybeOptions?: Omit<RemoteRuntimeManagerOptions, 'connection'>,
): RemoteRuntimeManager {
  return maybeOptions === undefined
    ? new RemoteRuntimeManager(connectionOrOptions as RemoteRuntimeManagerOptions)
    : new RemoteRuntimeManager(
        connectionOrOptions as RemoteRuntimeConnection,
        maybeOptions,
      )
}

export {
  DEFAULT_LOCAL_API_PORT,
  DEFAULT_REMOTE_PORT_END,
  DEFAULT_REMOTE_PORT_START,
  DEFAULT_IDLE_MS,
  RUN_ROOT as REMOTE_RUNTIME_RUN_ROOT,
  allocateRemotePorts,
}
