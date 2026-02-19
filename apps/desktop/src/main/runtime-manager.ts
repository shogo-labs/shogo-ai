import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app, safeStorage, session } from 'electron'

export type RuntimeStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'error'

export interface AgentRuntimeInfo {
  id: string
  port: number
  status: RuntimeStatus
  url: string
  startedAt: number
  error?: string
}

interface InternalRuntime extends AgentRuntimeInfo {
  process: ChildProcess | null
  logLines: string[]
}

interface RuntimeConfig {
  basePort: number
  maxRuntimes: number
  healthCheckIntervalMs: number
  agentsDir: string
}

const MAX_LOG_LINES = 2000

/**
 * Manages agent-runtime child processes on the local machine.
 *
 * Routes all LLM calls through the API server's AI proxy (same as cloud).
 * The raw ANTHROPIC_API_KEY is never passed to child processes — instead a
 * scoped proxy token is fetched from POST /api/ai/proxy/tokens.
 */
export class LocalAgentRuntimeManager {
  private config: RuntimeConfig
  private runtimes = new Map<string, InternalRuntime>()
  private usedPorts = new Set<number>()
  private healthTimers = new Map<string, ReturnType<typeof setInterval>>()
  private logListeners: ((projectId: string, line: string) => void)[] = []
  private _apiUrl = 'http://localhost:8002'

  constructor(overrides?: Partial<RuntimeConfig>) {
    const defaultAgentsDir = join(app.getPath('home'), 'shogo-agents')
    this.config = {
      basePort: 6200,
      maxRuntimes: 10,
      healthCheckIntervalMs: 30_000,
      agentsDir: defaultAgentsDir,
      ...overrides,
    }

    if (!existsSync(this.config.agentsDir)) {
      mkdirSync(this.config.agentsDir, { recursive: true })
    }
  }

  get apiUrl(): string {
    return this._apiUrl
  }

  setApiUrl(url: string): void {
    this._apiUrl = url
  }

  onLog(listener: (projectId: string, line: string) => void): () => void {
    this.logListeners.push(listener)
    return () => {
      this.logListeners = this.logListeners.filter((l) => l !== listener)
    }
  }

  private emitLog(projectId: string, line: string): void {
    for (const listener of this.logListeners) {
      try {
        listener(projectId, line)
      } catch {
        // ignore listener errors
      }
    }
  }

  private async isPortInUse(port: number): Promise<boolean> {
    try {
      await fetch(`http://localhost:${port}/`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(500),
      })
      return true
    } catch {
      return false
    }
  }

  private async allocatePort(): Promise<number> {
    const { basePort, maxRuntimes } = this.config
    for (let offset = 0; offset < maxRuntimes; offset++) {
      const port = basePort + offset
      if (!this.usedPorts.has(port) && !(await this.isPortInUse(port))) {
        this.usedPorts.add(port)
        return port
      }
    }
    throw new Error(`No available ports in range ${basePort}-${basePort + maxRuntimes - 1}`)
  }

  private releasePort(port: number): void {
    this.usedPorts.delete(port)
  }

  private ensureAgentDir(projectId: string): string {
    const agentDir = join(this.config.agentsDir, projectId)
    if (!existsSync(agentDir)) {
      mkdirSync(agentDir, { recursive: true })
    }
    return agentDir
  }

  private getAgentRuntimePath(): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'agent-runtime', 'server.js')
    }
    return join(__dirname, '../../../../packages/agent-runtime/src/server.ts')
  }

  private getMcpServerPath(): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'mcp', 'mcp-server.js')
    }
    return join(__dirname, '../../../../packages/agent-runtime/src/tools/mcp-server.ts')
  }

  private getRunCommand(): { cmd: string; args: string[] } {
    if (app.isPackaged) {
      return { cmd: 'node', args: [this.getAgentRuntimePath()] }
    }
    return { cmd: 'bun', args: ['run', this.getAgentRuntimePath()] }
  }

  /**
   * Fetch a session cookie string from Electron's cookie store for the API.
   */
  private async getSessionCookie(): Promise<string> {
    const cookies = await session.defaultSession.cookies.get({ url: this._apiUrl })
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  }

  /**
   * Fetch a project-scoped AI proxy token from the API server.
   * Uses the user's session cookie for authentication.
   */
  private async fetchProxyToken(projectId: string, workspaceId: string): Promise<string> {
    const cookie = await this.getSessionCookie()
    const res = await fetch(`${this._apiUrl}/api/ai/proxy/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        projectId,
        workspaceId,
        expiryHours: 168, // 7 days
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to get proxy token (${res.status}): ${text}`)
    }
    const data = await res.json() as { token: string }
    return data.token
  }

  /**
   * Look up the workspace that owns a project, via the API.
   */
  private async getProjectWorkspaceId(projectId: string): Promise<string> {
    try {
      const cookie = await this.getSessionCookie()
      const res = await fetch(`${this._apiUrl}/api/projects/${projectId}`, {
        headers: { Cookie: cookie },
      })
      if (res.ok) {
        const data = await res.json() as any
        const project = data.data ?? data
        return project.workspaceId ?? 'local-dev'
      }
    } catch {
      // fall through
    }
    return 'local-dev'
  }

  getAnthropicApiKey(): string | null {
    try {
      const encrypted = readFileSync(
        join(app.getPath('userData'), '.anthropic-key'),
      )
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(encrypted)
      }
    } catch {
      // no stored key
    }
    return process.env.ANTHROPIC_API_KEY ?? null
  }

  setAnthropicApiKey(key: string): void {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(key)
      writeFileSync(join(app.getPath('userData'), '.anthropic-key'), encrypted)
    }
  }

  async start(projectId: string): Promise<AgentRuntimeInfo> {
    const existing = this.runtimes.get(projectId)
    if (existing && existing.status === 'running') {
      throw new Error(`Agent ${projectId} is already running`)
    }

    const agentDir = this.ensureAgentDir(projectId)
    const port = await this.allocatePort()
    const url = `http://localhost:${port}`

    const runtime: InternalRuntime = {
      id: projectId,
      port,
      status: 'starting',
      url,
      startedAt: Date.now(),
      process: null,
      logLines: [],
    }
    this.runtimes.set(projectId, runtime)

    try {
      const { cmd, args } = this.getRunCommand()

      // Build base environment — never includes the raw ANTHROPIC_API_KEY
      const runtimeEnv: Record<string, string> = {
        ...process.env as Record<string, string>,
        PROJECT_ID: projectId,
        AGENT_DIR: agentDir,
        PORT: String(port),
        MCP_SERVER_PATH: this.getMcpServerPath(),
        NODE_ENV: 'development',
      }

      // Configure AI proxy — route all LLM calls through the API server
      const proxyUrl = `${this._apiUrl}/api/ai/v1`
      runtimeEnv.AI_PROXY_URL = proxyUrl

      try {
        const workspaceId = await this.getProjectWorkspaceId(projectId)
        const token = await this.fetchProxyToken(projectId, workspaceId)
        runtimeEnv.AI_PROXY_TOKEN = token
        this.emitLog(projectId, `[desktop] AI proxy configured → ${proxyUrl}`)
      } catch (err: any) {
        this.emitLog(projectId, `[desktop] WARNING: Failed to get proxy token: ${err.message}`)
        this.emitLog(projectId, `[desktop] Falling back to direct ANTHROPIC_API_KEY`)

        // Fallback: use local API key directly if proxy token fetch fails
        const apiKey = this.getAnthropicApiKey()
        if (!apiKey) {
          throw new Error(
            'Cannot start agent: proxy token fetch failed and no local Anthropic API key is configured.',
          )
        }
        runtimeEnv.ANTHROPIC_API_KEY = apiKey
        delete runtimeEnv.AI_PROXY_URL
      }

      // Strip raw platform keys when proxy is active
      if (runtimeEnv.AI_PROXY_TOKEN) {
        delete runtimeEnv.ANTHROPIC_API_KEY
        delete runtimeEnv.ANTHROPIC_BASE_URL
      }

      const agentProc = spawn(cmd, args, {
        cwd: agentDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: runtimeEnv,
      })

      runtime.process = agentProc

      const appendLog = (line: string) => {
        runtime.logLines.push(line)
        if (runtime.logLines.length > MAX_LOG_LINES) {
          runtime.logLines.shift()
        }
        this.emitLog(projectId, line)
      }

      agentProc.stdout?.on('data', (data: Buffer) => {
        for (const line of data.toString().split('\n')) {
          if (line.trim()) appendLog(line)
        }
      })

      agentProc.stderr?.on('data', (data: Buffer) => {
        for (const line of data.toString().split('\n')) {
          if (line.trim()) appendLog(`[stderr] ${line}`)
        }
      })

      agentProc.on('error', (err) => {
        runtime.status = 'error'
        runtime.error = err.message
        appendLog(`[error] Process error: ${err.message}`)
      })

      agentProc.on('exit', (code, signal) => {
        if (runtime.status !== 'stopping' && runtime.status !== 'stopped') {
          runtime.status = 'stopped'
        }
        this.releasePort(port)
        appendLog(`[exit] code=${code} signal=${signal}`)
      })

      await this.waitForReady(projectId, port, 30_000)
      runtime.status = 'running'
      this.startHealthCheck(projectId)

      return this.toPublic(runtime)
    } catch (err: any) {
      runtime.status = 'error'
      runtime.error = err.message
      this.releasePort(port)
      if (runtime.process) {
        runtime.process.kill('SIGTERM')
      }
      throw err
    }
  }

  async stop(projectId: string): Promise<void> {
    const runtime = this.runtimes.get(projectId)
    if (!runtime) return

    this.stopHealthCheck(projectId)
    runtime.status = 'stopping'

    if (runtime.process) {
      runtime.process.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (runtime.process && !runtime.process.killed) {
            runtime.process.kill('SIGKILL')
          }
          resolve()
        }, 5000)

        runtime.process?.on('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }

    runtime.status = 'stopped'
    this.releasePort(runtime.port)
    this.runtimes.delete(projectId)
  }

  async restart(projectId: string): Promise<AgentRuntimeInfo> {
    await this.stop(projectId)
    return this.start(projectId)
  }

  status(projectId: string): AgentRuntimeInfo | null {
    const runtime = this.runtimes.get(projectId)
    return runtime ? this.toPublic(runtime) : null
  }

  list(): AgentRuntimeInfo[] {
    return Array.from(this.runtimes.values()).map((r) => this.toPublic(r))
  }

  getLogs(projectId: string): string[] {
    return this.runtimes.get(projectId)?.logLines ?? []
  }

  getActiveProjects(): string[] {
    return Array.from(this.runtimes.entries())
      .filter(([, r]) => r.status === 'running' || r.status === 'starting')
      .map(([id]) => id)
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      Array.from(this.runtimes.keys()).map((id) =>
        this.stop(id).catch((err) =>
          console.error(`[Desktop] Failed to stop ${id}:`, err),
        ),
      ),
    )
  }

  private async waitForReady(
    projectId: string,
    port: number,
    timeoutMs: number,
  ): Promise<void> {
    const start = Date.now()
    const interval = 500

    while (Date.now() - start < timeoutMs) {
      const runtime = this.runtimes.get(projectId)
      if (runtime?.status === 'error') {
        throw new Error(runtime.error || 'Agent process failed to start')
      }

      try {
        const res = await fetch(`http://localhost:${port}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(2000),
        })
        if (res.ok) return
      } catch {
        // not ready yet
      }

      await new Promise((r) => setTimeout(r, interval))
    }

    throw new Error(
      `Timeout waiting for agent ${projectId} on port ${port} (${timeoutMs}ms)`,
    )
  }

  private startHealthCheck(projectId: string): void {
    const timer = setInterval(async () => {
      const runtime = this.runtimes.get(projectId)
      if (!runtime || runtime.status !== 'running') {
        this.stopHealthCheck(projectId)
        return
      }
      try {
        await fetch(`http://localhost:${runtime.port}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        })
      } catch {
        runtime.status = 'error'
        runtime.error = 'Health check failed'
        this.emitLog(projectId, '[health] Agent health check failed')
      }
    }, this.config.healthCheckIntervalMs)

    this.healthTimers.set(projectId, timer)
  }

  private stopHealthCheck(projectId: string): void {
    const timer = this.healthTimers.get(projectId)
    if (timer) {
      clearInterval(timer)
      this.healthTimers.delete(projectId)
    }
  }

  private toPublic(runtime: InternalRuntime): AgentRuntimeInfo {
    return {
      id: runtime.id,
      port: runtime.port,
      status: runtime.status,
      url: runtime.url,
      startedAt: runtime.startedAt,
      error: runtime.error,
    }
  }
}
