// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared Docker-based worker pool for eval runners.
 *
 * Provides container lifecycle management, environment passthrough,
 * worker configuration via HTTP APIs, and signal-handler registration.
 * Used by both run-eval.ts and swe-bench.ts.
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, appendFileSync } from 'fs'
import { resolve, join } from 'path'
import { tmpdir } from 'os'
import { encodeSecurityPolicy } from '../permission-engine'
import { MODEL_ALIASES, inferProviderFromModel as catalogInferProvider } from '@shogo/model-catalog'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DockerWorker {
  id: number
  port: number
  dir: string
  containerName: string
}

export interface DockerWorkerConfig {
  image: string
  containerPrefix: string
  baseHostPort: number
  containerAgentPort: number
  extraPortMappings?: Array<{
    hostBase: number
    container: number
  }>
  model: string
  verbose: boolean
  envOverrides?: Record<string, string>
  /** Extra Docker networks to connect the container to (e.g. for Redis access). */
  extraNetworks?: string[]
  /** Override the Docker ENTRYPOINT — runs as `sh -c <entrypoint>`. Useful when
   *  the default entrypoint does workspace init that conflicts with pre-populated
   *  volumes (e.g. SWE-bench repo clones). */
  entrypoint?: string
}

// ---------------------------------------------------------------------------
// Shared eval worker config defaults (Redis cache, Docker networking)
// ---------------------------------------------------------------------------

const EVAL_REDIS_NETWORK = 'shogo-ai_shogo-network'
const EVAL_REDIS_URL = 'redis://shogo-ai-redis-1:6379'

/**
 * Build a DockerWorkerConfig with eval defaults baked in:
 *  - Connects to the shogo Docker network for Redis access
 *  - Sets WEB_CACHE_REDIS_URL so web responses are cached across runs
 *  - containerAgentPort defaults to 8080
 *
 * Callers override only what's specific to their benchmark.
 */
export function evalWorkerConfig(opts: {
  containerPrefix: string
  baseHostPort: number
  model: string
  verbose: boolean
  image?: string
  maxIterations?: number
  envOverrides?: Record<string, string>
  extraPortMappings?: DockerWorkerConfig['extraPortMappings']
  extraNetworks?: string[]
  entrypoint?: string
}): DockerWorkerConfig {
  return {
    image: opts.image || DEFAULT_RUNTIME_IMAGE,
    containerPrefix: opts.containerPrefix,
    baseHostPort: opts.baseHostPort,
    containerAgentPort: 8080,
    model: opts.model,
    verbose: opts.verbose,
    extraNetworks: [EVAL_REDIS_NETWORK, ...(opts.extraNetworks || [])],
    extraPortMappings: opts.extraPortMappings,
    entrypoint: opts.entrypoint,
    envOverrides: {
      AGENT_MAX_ITERATIONS: String(opts.maxIterations ?? 100),
      WEB_CACHE_REDIS_URL: EVAL_REDIS_URL,
      ...opts.envOverrides,
    },
  }
}

export interface WorkerSetupOptions {
  model?: string
  mode?: string
  promptProfile?: string
  evalLabel?: string
  mocks?: Record<string, unknown>
  verbose?: boolean
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

export const MODEL_MAP: Record<string, string> = { ...MODEL_ALIASES }

export const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  haiku: { input: 0.0000008, output: 0.000004, cacheRead: 0.00000008, cacheWrite: 0.000001 },
  sonnet: { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
  opus: { input: 0.000005, output: 0.000025, cacheRead: 0.0000005, cacheWrite: 0.00000625 },
  'gpt-5.4-mini': { input: 0.0000011, output: 0.0000044, cacheRead: 0.00000011, cacheWrite: 0.00000138 },
  'gpt54mini': { input: 0.0000011, output: 0.0000044, cacheRead: 0.00000011, cacheWrite: 0.00000138 },
}

/** Infer provider from a resolved model ID string. */
export function inferProvider(model: string): string {
  return catalogInferProvider(model, 'anthropic')
}

export const REPO_ROOT = resolve(import.meta.dir, '../../../..')
export const DEFAULT_RUNTIME_IMAGE = 'shogo-runtime:eval'

// ---------------------------------------------------------------------------
// CLI arg parser
// ---------------------------------------------------------------------------

export function getArg(argv: string[], name: string, defaultValue?: string): string | undefined {
  const eqArg = argv.find(a => a.startsWith(`--${name}=`))
  if (eqArg) return eqArg.split('=')[1]
  const idx = argv.indexOf(`--${name}`)
  if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1]
  return defaultValue
}

// ---------------------------------------------------------------------------
// Env loading
// ---------------------------------------------------------------------------

export function loadEnvFromDisk(repoRoot: string): void {
  for (const envFile of ['.env.local', '.env']) {
    const envPath = resolve(repoRoot, envFile)
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eqIdx = trimmed.indexOf('=')
        if (eqIdx < 0) continue
        const key = trimmed.slice(0, eqIdx)
        const val = trimmed.slice(eqIdx + 1)
        if (!process.env[key]) process.env[key] = val
      }
      break
    }
  }
}

// ---------------------------------------------------------------------------
// Docker env file management
// ---------------------------------------------------------------------------

const ENV_PREFIXES = [
  'ANTHROPIC_', 'AI_PROXY_', 'OPENAI_', 'GOOGLE_API_KEY', 'AWS_', 'STRIPE_',
  'GITHUB_TOKEN', 'GITLAB_TOKEN', 'COMPOSIO_', 'SERPER_',
  'HUGGINGFACEHUB_', 'WEBARENA_', 'WEB_CACHE_',
]

let _envFilePath: string | null = null

export function writeDockerEnvFile(): string {
  const lines: string[] = []
  for (const [key, val] of Object.entries(process.env)) {
    if (!val) continue
    if (ENV_PREFIXES.some(p => key.startsWith(p))) {
      lines.push(`${key}=${val}`)
    }
  }
  const path = join(tmpdir(), `docker-eval-env-${process.pid}`)
  writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 })
  _envFilePath = path
  return path
}

export function cleanupDockerEnvFile(): void {
  if (_envFilePath && existsSync(_envFilePath)) {
    try { rmSync(_envFilePath) } catch {}
    _envFilePath = null
  }
}

// ---------------------------------------------------------------------------
// Image management
// ---------------------------------------------------------------------------

export async function ensureDockerImage(
  image: string,
  opts?: { build?: boolean; dockerfile?: string; context?: string },
): Promise<void> {
  if (opts?.build) {
    const dockerfile = opts.dockerfile || 'packages/agent-runtime/Dockerfile'
    const context = opts.context || REPO_ROOT
    console.log(`  Building Docker image ${image}...`)
    const start = Date.now()
    execSync(
      `docker build -t "${image}" -f "${dockerfile}" "${context}"`,
      { stdio: 'inherit', timeout: 600_000 },
    )
    console.log(`  Image built in ${((Date.now() - start) / 1000).toFixed(1)}s`)
    return
  }

  try {
    execSync(`docker image inspect "${image}" > /dev/null 2>&1`, { stdio: 'pipe' })
  } catch {
    throw new Error(
      `Docker image "${image}" not found. Run with --build to build it, or:\n` +
      `  docker build -t ${image} -f packages/agent-runtime/Dockerfile ${REPO_ROOT}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

export async function startDockerWorker(
  id: number,
  config: DockerWorkerConfig,
  opts?: {
    workspaceDir?: string
    imageOverride?: string
    extraVolumeMounts?: string[]
    containerWorkspaceDir?: string
  },
): Promise<DockerWorker> {
  const hostPort = config.baseHostPort + id
  const containerName = `${config.containerPrefix}-${id}`
  const dir = opts?.workspaceDir || resolve(tmpdir(), `${config.containerPrefix}-${id}`)

  console.log(`  Starting worker ${id} (${containerName}) on port ${hostPort}...`)

  // Remove stale container — retry to avoid "name already in use" race
  for (let i = 0; i < 5; i++) {
    try { execSync(`docker kill "${containerName}" 2>/dev/null`, { stdio: 'pipe', timeout: 15_000 }) } catch {}
    try { execSync(`docker rm -f "${containerName}" 2>/dev/null`, { stdio: 'pipe', timeout: 15_000 }) } catch {}
    try {
      execSync(`docker inspect "${containerName}" 2>/dev/null`, { stdio: 'pipe' })
      await Bun.sleep(2000)
    } catch {
      break // container is gone
    }
  }

  mkdirSync(dir, { recursive: true })

  const envFile = _envFilePath || writeDockerEnvFile()

  const portFlags = [`-p ${hostPort}:${config.containerAgentPort}`]
  if (config.extraPortMappings) {
    for (const m of config.extraPortMappings) {
      portFlags.push(`-p ${m.hostBase + id}:${m.container}`)
    }
  }

  const wsDir = opts?.containerWorkspaceDir || '/app/workspace'
  const envFlags = [
    `-e NODE_ENV=development`,
    `-e PORT=${config.containerAgentPort}`,
    `-e WORKSPACE_DIR=${wsDir}`,
    `-e AGENT_DIR=${wsDir}`,
    `-e PROJECT_DIR=${wsDir}`,
    `-e PROJECT_ID=${containerName}`,
    `-e AGENT_MODEL=${config.model}`,
    `-e SECURITY_POLICY=${encodeSecurityPolicy({ mode: 'full_autonomy' })}`,
  ]

  if (config.extraPortMappings) {
    for (const m of config.extraPortMappings) {
      // The container always forwards host:4100+id → container:3001
      // (CONTAINER_SKILL_PORT). PreviewManager reads `API_SERVER_PORT`
      // to override its default — match the published port so the
      // host's runtime checks reach the API server. Keep the legacy
      // SKILL_SERVER_PORT alias for any rolled-back binaries.
      envFlags.push(`-e API_SERVER_PORT=${m.container}`)
      envFlags.push(`-e SKILL_SERVER_PORT=${m.container}`)
    }
  }

  if (config.envOverrides) {
    for (const [k, v] of Object.entries(config.envOverrides)) {
      envFlags.push(`-e ${k}=${v}`)
    }
  }

  const networkFlags: string[] = []
  if (config.extraNetworks?.length) {
    networkFlags.push(`--network ${config.extraNetworks[0]}`)
  }

  const volumeFlags = [`-v "${dir}:/app/workspace"`]
  if (opts?.extraVolumeMounts) {
    for (const m of opts.extraVolumeMounts) {
      volumeFlags.push(`-v "${m}"`)
    }
  }

  const effectiveImage = opts?.imageOverride || config.image

  const parts = [
    'docker run -d',
    `--name "${containerName}"`,
    ...portFlags,
    ...networkFlags,
    ...volumeFlags,
    `--env-file "${envFile}"`,
    ...envFlags,
  ]

  if (config.entrypoint) {
    parts.push('--entrypoint sh')
  }

  parts.push(effectiveImage)

  if (config.entrypoint) {
    parts.push(`-c "${config.entrypoint}"`)
  }

  const cmd = parts.join(' ')

  try {
    execSync(cmd, { stdio: 'pipe', timeout: 30_000 })
  } catch (err: any) {
    throw new Error(`Failed to start container ${containerName}: ${err.message}`)
  }

  // Poll /health — wait for both the HTTP server AND the agent gateway to be ready.
  // The health response includes `gateway: { running: true }` once the gateway is up.
  // Without this check, we'd hit 503 "Agent gateway not running" on /agent/chat.
  const maxWait = 180_000
  const start = Date.now()
  let delay = 500

  while (Date.now() - start < maxWait) {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 3_000)
      const res = await fetch(`http://localhost:${hostPort}/health`, { signal: ctl.signal })
      clearTimeout(t)
      if (res.ok) {
        const body = await res.json().catch(() => null) as any
        const gatewayRunning = body?.gateway?.running === true
        if (!gatewayRunning) {
          if (config.verbose && Date.now() - start > 5_000) {
            console.log(`  Worker ${id} HTTP ok but gateway not ready yet (${Date.now() - start}ms)`)
          }
          await Bun.sleep(delay)
          delay = Math.min(delay * 1.2, 2_000)
          continue
        }
        console.log(`  Worker ${id} ready on port ${hostPort} (${Date.now() - start}ms)`)
        return { id, port: hostPort, dir, containerName }
      }
    } catch {
      // Check if container died
      try {
        const status = execSync(`docker inspect -f '{{.State.Running}}' "${containerName}"`, {
          encoding: 'utf-8', stdio: 'pipe',
        }).trim()
        if (status !== 'true') {
          const logs = execSync(`docker logs --tail 20 "${containerName}" 2>&1`, {
            encoding: 'utf-8', stdio: 'pipe',
          }).trim()
          throw new Error(`Container ${containerName} exited.\nLast logs:\n${logs}`)
        }
      } catch (inspectErr: any) {
        if (inspectErr.message.includes('exited')) throw inspectErr
      }
    }
    await Bun.sleep(delay)
    delay = Math.min(delay * 1.2, 2_000)
  }

  try { execSync(`docker rm -f "${containerName}"`, { stdio: 'pipe' }) } catch {}
  throw new Error(`Worker ${id} failed to start within ${maxWait}ms`)
}

export function stopDockerWorker(worker: DockerWorker): void {
  try { execSync(`docker rm -f "${worker.containerName}" 2>/dev/null`, { stdio: 'pipe' }) } catch {}
}

// ---------------------------------------------------------------------------
// Check if a running container is still healthy
// ---------------------------------------------------------------------------

export async function isWorkerHealthy(worker: DockerWorker): Promise<boolean> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 3_000)
    const res = await fetch(`http://localhost:${worker.port}/health`, { signal: ctl.signal })
    clearTimeout(t)
    if (!res.ok) return false
    const body = await res.json().catch(() => null) as any
    return body?.gateway?.running === true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Worker setup via HTTP APIs
// ---------------------------------------------------------------------------

export async function configureWorkerForTask(
  worker: DockerWorker,
  opts: WorkerSetupOptions,
  baseUrlOverride?: string,
): Promise<void> {
  const base = baseUrlOverride || `http://localhost:${worker.port}`

  if (opts.model) {
    const defaultModel = 'claude-sonnet-4-6'
    const resolved = MODEL_MAP[opts.model] || opts.model
    const provider = inferProvider(resolved)
    if (resolved !== defaultModel) {
      try {
        await fetch(`${base}/agent/config`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: { provider, name: resolved } }),
        })
        if (opts.verbose) console.log(`      [setup] Model set to ${provider}/${resolved}`)
      } catch (e: any) {
        console.warn(`      [setup] Model override failed: ${e.message}`)
      }
    } else if (opts.verbose) {
      console.log(`      [setup] Using default model: ${defaultModel}`)
    }
  }

  if (opts.evalLabel !== undefined) {
    if (opts.verbose) console.log(`      [setup] Resetting session...`)
    try {
      await fetch(`${base}/agent/session/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evalLabel: opts.evalLabel }),
      })
      // Wait for the gateway to be ready after reset (it restarts async)
      const deadline = Date.now() + 45_000
      while (Date.now() < deadline) {
        await Bun.sleep(2_000)
        try {
          const hres = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3_000) })
          if (hres.ok) {
            const hbody = await hres.json().catch(() => null) as any
            if (hbody?.gateway?.running === true) break
          }
        } catch {}
      }
    } catch (e: any) {
      console.warn(`      [setup] Session reset failed: ${e.message}`)
    }
  }

  if (opts.mode) {
    if (opts.verbose) console.log(`      [setup] Setting mode to ${opts.mode}...`)
    try {
      await fetch(`${base}/agent/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: opts.mode }),
      })
    } catch (e: any) {
      console.warn(`      [setup] Mode set failed: ${e.message}`)
    }
  }

  if (opts.promptProfile) {
    if (opts.verbose) console.log(`      [setup] Setting prompt profile to ${opts.promptProfile}...`)
    try {
      await fetch(`${base}/agent/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptProfile: opts.promptProfile }),
      })
    } catch (e: any) {
      console.warn(`      [setup] Prompt profile set failed: ${e.message}`)
    }
  }

  if (opts.mocks) {
    if (opts.verbose) console.log(`      [setup] Installing tool mocks...`)
    try {
      await fetch(`${base}/agent/tool-mocks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mocks: opts.mocks }),
      })
    } catch (e: any) {
      console.warn(`      [setup] Mock install failed: ${e.message}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Signal handlers / cleanup
// ---------------------------------------------------------------------------

export function registerCleanupHandlers(
  getWorkers: () => DockerWorker[],
  logFile: string,
  opts?: { stopWorker?: (w: DockerWorker) => void },
): void {
  const stopWorker = opts?.stopWorker ?? stopDockerWorker
  function doCleanup() {
    console.log('\nCleaning up workers...')
    for (const w of getWorkers()) {
      stopWorker(w)
    }
    cleanupDockerEnvFile()
  }

  function crashLog(label: string, err: any) {
    const msg = `[${new Date().toISOString()}] ${label}: ${err?.stack || err?.message || err}\n`
    console.error(msg)
    try { appendFileSync(join(tmpdir(), logFile), msg) } catch {}
  }

  process.on('SIGINT', () => { crashLog('SIGINT', 'interrupted'); doCleanup(); process.exit(130) })
  process.on('SIGTERM', () => { crashLog('SIGTERM', 'terminated'); doCleanup(); process.exit(143) })
  process.on('uncaughtException', (err) => { crashLog('UNCAUGHT EXCEPTION', err); doCleanup(); process.exit(1) })
  process.on('unhandledRejection', (reason) => { crashLog('UNHANDLED REJECTION', reason); doCleanup(); process.exit(1) })
  process.on('exit', (code) => { if (code !== 0 && code !== 130 && code !== 143) crashLog('EXIT', `code=${code}`) })
}
