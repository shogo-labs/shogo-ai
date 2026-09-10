/**
 * Local desktop project-open benchmark.
 *
 * This intentionally talks to the local API instead of driving a browser so
 * runtime seeding, dependency installation, agent boot, and readiness can be
 * measured independently from renderer noise. Use a packaged/dev desktop API:
 *
 *   bun scripts/bench/project-open.ts --scenario existing-warm --project-id <id>
 *   bun scripts/bench/project-open.ts --scenario new --runs 5 --cleanup \
 *     --workspace-id <workspace> --user-id <user>
 *
 * Readiness probes go through `/api/projects/:id/agent-proxy/*` (what the
 * renderer uses) rather than the runtime's direct port, which requires a
 * runtime token. `totalMs` is gesture→files-listing, the "responsive" budget.
 * `--cleanup` deletes projects created by `new` / `open-folder` runs.
 * `--cold-mode stop|kill|kill-pool` controls how `existing-cold` takes the
 * runtime down first (see `ColdMode`); `kill-pool` forces a true cold spawn.
 * `--pause-ms N` sleeps between runs so pools refill / grace windows expire.
 *
 * `SHOGO_BENCH_COOKIE` may supply an existing auth cookie. When it is
 * omitted, localhost APIs use the local-mode auto-sign-in endpoint by
 * default; set `SHOGO_BENCH_AUTO_SIGN_IN=0` to require an explicit cookie.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { hostname, platform, totalmem } from 'os'

type Scenario = 'new' | 'existing-cold' | 'existing-warm' | 'open-folder'
type Sample = {
  scenario: Scenario
  run: number
  projectId?: string
  createMs?: number
  sandboxMs?: number
  healthMs?: number | null
  gatewayMs?: number | null
  filesMs?: number | null
  chatMs?: number | null
  /** Gesture-to-responsive: create/stop start → files listing served. */
  totalMs?: number | null
  installMarker?: boolean | null
  /** existing-cold only: how the runtime was taken down before reopening. */
  coldMode?: ColdMode
  killedTarget?: boolean
  killedPool?: number
  /** True when the reopened runtime was one of the pre-existing pool ports. */
  servedByPool?: boolean | null
  runtimePort?: number | null
  error?: string
}

/**
 * How `existing-cold` takes the runtime down before timing the reopen.
 *
 * - `stop`: `POST /runtime/stop` only. This is what the UI does, but on
 *   pool-assigned runtimes it can be a no-op, leaving the run warm.
 * - `kill`: `stop`, then SIGKILL the process still serving `directUrl`.
 *   Reopen is usually served by an idle pool runtime (pool hit).
 * - `kill-pool`: `kill`, then SIGKILL every idle pool runtime (`/health`
 *   reports `poolMode: true`) so reopen must spawn from scratch (pool miss).
 */
type ColdMode = 'stop' | 'kill' | 'kill-pool'

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const scenario = (arg('scenario', 'existing-warm') as Scenario)
const runs = Math.max(1, Number(arg('runs', '3')))
const apiBase = (arg('api-url') || process.env.SHOGO_BENCH_API_URL || 'http://127.0.0.1:39100').replace(/\/+$/, '')
const projectIdArg = arg('project-id') || process.env.SHOGO_BENCH_PROJECT_ID
const workspaceId = arg('workspace-id') || process.env.SHOGO_BENCH_WORKSPACE_ID
const userId = arg('user-id') || process.env.SHOGO_BENCH_USER_ID
const folderPath = arg('folder') || process.env.SHOGO_BENCH_FOLDER
const sessionId = arg('session-id') || process.env.SHOGO_BENCH_SESSION_ID
const workspacesDir = arg('workspaces-dir') || process.env.WORKSPACES_DIR
/** Delete projects created by `new` / `open-folder` runs once measured. */
const cleanup = process.argv.includes('--cleanup')
const coldMode = arg('cold-mode', 'stop') as ColdMode
/** Idle gap between runs (lets pools refill / startup-grace windows expire). */
const pauseMs = Math.max(0, Number(arg('pause-ms', '0')))
let authCookie = process.env.SHOGO_BENCH_COOKIE

if (!['new', 'existing-cold', 'existing-warm', 'open-folder'].includes(scenario)) {
  throw new Error(`Unknown --scenario ${scenario}`)
}
if (!['stop', 'kill', 'kill-pool'].includes(coldMode)) {
  throw new Error(`Unknown --cold-mode ${coldMode} (stop | kill | kill-pool)`)
}
if (scenario !== 'new' && scenario !== 'open-folder' && !projectIdArg) {
  throw new Error(`--project-id is required for ${scenario}`)
}
if (scenario === 'new' && (!workspaceId || !userId)) {
  throw new Error('--workspace-id and --user-id are required for new')
}
if (scenario === 'open-folder' && !folderPath) {
  throw new Error('--folder is required for open-folder')
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function headers(openAttemptId: string): HeadersInit {
  return {
    'content-type': 'application/json',
    'x-shogo-open-id': openAttemptId,
    ...(authCookie ? { cookie: authCookie } : {}),
  }
}

async function autoSignInLocal(): Promise<void> {
  if (authCookie || process.env.SHOGO_BENCH_AUTO_SIGN_IN === '0') return

  const host = new URL(apiBase).hostname
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return

  const response = await fetch(`${apiBase}/api/local/auto-sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`POST ${apiBase}/api/local/auto-sign-in -> ${response.status}: ${text}`)
  }

  const getSetCookie = (response.headers as Headers & {
    getSetCookie?: () => string[]
  }).getSetCookie
  const setCookies = getSetCookie
    ? getSetCookie.call(response.headers)
    : (response.headers.get('set-cookie') || '').split(/,(?=[^;,=]+=)/)
  authCookie = setCookies
    .map((value) => value.split(';', 1)[0].trim())
    .filter(Boolean)
    .join('; ')

  if (!authCookie) {
    throw new Error('local auto-sign-in succeeded without returning a session cookie')
  }
  console.log('[bench] acquired local auth session')
}

async function json<T>(url: string, init: RequestInit, openAttemptId: string): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...headers(openAttemptId), ...(init.headers || {}) },
  })
  const text = await response.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!response.ok) {
    throw new Error(`${init.method || 'GET'} ${url} -> ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`)
  }
  return body as T
}

async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 60_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const result = await fn()
      if (result != null) return result
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(intervalMs)
  }
  throw new Error(`timed out after ${timeoutMs}ms${lastError ? `: ${String(lastError)}` : ''}`)
}

async function stopRuntime(projectId: string, openAttemptId: string): Promise<void> {
  await json(`${apiBase}/api/projects/${encodeURIComponent(projectId)}/runtime/stop`, {
    method: 'POST',
    body: '{}',
  }, openAttemptId)
}

// ── Local process helpers (existing-cold --cold-mode kill | kill-pool) ──────

function run(cmd: string[]): string {
  const proc = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
  return new TextDecoder().decode(proc.stdout).trim()
}

function portOf(url: string | undefined): number | null {
  if (!url) return null
  try {
    const port = Number(new URL(url).port)
    return Number.isFinite(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

/** Every local agent-runtime process and the ports it listens on. */
function listAgentRuntimes(): Array<{ pid: number; ports: number[] }> {
  if (process.platform === 'win32') {
    // Windows PowerShell 5.1 compatible (no `-AsArray`): pass an explicit
    // array via -InputObject so a single match still serialises as a list.
    const out = run(['powershell', '-NoProfile', '-Command', [
      "$list = @(Get-CimInstance Win32_Process -Filter \"Name='bun.exe' OR Name='agent-runtime.exe' OR Name='node.exe'\"",
      "| Where-Object { $_.CommandLine -match 'agent-runtime' }",
      '| ForEach-Object { $p=$_.ProcessId; $ports=@(Get-NetTCPConnection -OwningProcess $p -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique); [pscustomobject]@{ pid=$p; ports=$ports } });',
      'ConvertTo-Json -InputObject $list -Compress -Depth 3',
    ].join(' ')])
    try {
      const parsed = JSON.parse(out || '[]') as
        | Array<{ pid: number; ports: number[] | number | null }>
        | { pid: number; ports: number[] | number | null }
      const list = Array.isArray(parsed) ? parsed : [parsed]
      return list.filter((p) => p && p.pid).map((p) => ({ pid: p.pid, ports: ([] as number[]).concat(p.ports ?? []) }))
    } catch {
      console.warn(`[bench] could not enumerate agent-runtime processes: ${out.slice(0, 200)}`)
      return []
    }
  }
  const pids = run(['sh', '-c', "pgrep -f 'agent-runtime' || true"]).split(/\s+/).map(Number).filter((n) => n > 0 && n !== process.pid)
  return pids.map((pid) => {
    const ports = run(['sh', '-c', `lsof -Pan -p ${pid} -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {sub(/.*:/, "", $9); print $9}' | sort -u`])
      .split(/\s+/).map(Number).filter((n) => n > 0)
    return { pid, ports }
  })
}

function killPid(pid: number): void {
  if (process.platform === 'win32') {
    run(['taskkill', '/PID', String(pid), '/T', '/F'])
  } else {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
}

/** Runtime `/health` on a local port (no auth, no side effects), or null. */
async function runtimeHealth(port: number): Promise<{ projectId?: string; poolMode?: boolean } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_500) })
    if (!response.ok) return null
    return await response.json() as any
  } catch {
    return null
  }
}

async function isIdlePoolRuntime(port: number): Promise<boolean> {
  const body = await runtimeHealth(port)
  return body?.poolMode === true || body?.projectId === '__POOL__'
}

/** Ports of idle pool runtimes right now (used to classify pool hits later). */
async function idlePoolPorts(): Promise<number[]> {
  const ports: number[] = []
  for (const proc of listAgentRuntimes()) {
    for (const port of proc.ports) {
      if (await isIdlePoolRuntime(port)) ports.push(port)
    }
  }
  return ports
}

/**
 * Find the process currently serving `projectId`, by asking each local
 * agent-runtime's `/health`. Deliberately avoids `sandbox/url`, which starts
 * or pool-assigns a runtime as a side effect and would put the project inside
 * the controller's startup-grace window right before we kill it.
 */
async function findProjectRuntime(projectId: string): Promise<{ pid: number; port: number } | null> {
  for (const proc of listAgentRuntimes()) {
    for (const port of proc.ports) {
      const body = await runtimeHealth(port)
      if (body?.projectId === projectId) return { pid: proc.pid, port }
    }
  }
  return null
}

/**
 * Take the project's runtime down according to `--cold-mode`, returning what
 * was actually killed so the sample can say whether the reopen was a pool hit.
 */
async function takeDownRuntime(projectId: string, openAttemptId: string): Promise<{
  killedTarget: boolean
  killedPool: number
  poolPortsBefore: number[]
}> {
  await stopRuntime(projectId, openAttemptId)
  let killedTarget = false
  let killedPool = 0
  let poolPortsBefore: number[] = []

  if (coldMode !== 'stop') {
    const live = await findProjectRuntime(projectId)
    if (live) {
      console.log(`[bench] runtime/stop left ${projectId.slice(0, 8)} serving on :${live.port}; killing pid ${live.pid}`)
      killPid(live.pid)
      killedTarget = true
    }
    poolPortsBefore = await idlePoolPorts()
    if (coldMode === 'kill-pool') {
      for (const proc of listAgentRuntimes()) {
        for (const port of proc.ports) {
          if (poolPortsBefore.includes(port)) {
            console.log(`[bench] draining idle pool runtime pid ${proc.pid} on :${port}`)
            killPid(proc.pid)
            killedPool++
            break
          }
        }
      }
      poolPortsBefore = []
    }
    // Give the API's health checker a beat to notice the dead process so the
    // reopen below is attributed to the open, not to stale state.
    await Bun.sleep(500)
  }
  return { killedTarget, killedPool, poolPortsBefore }
}

async function createProject(openAttemptId: string): Promise<{ projectId: string; ms: number }> {
  const start = now()
  const response = await json<any>(`${apiBase}/api/projects`, {
    method: 'POST',
    body: JSON.stringify({
      name: `perf-${Date.now()}`,
      workspaceId,
      createdBy: userId,
      tier: 'starter',
      status: 'draft',
      accessLevel: 'anyone',
      schemas: [],
      settings: JSON.stringify({ activeMode: 'canvas', techStackId: 'react-app' }),
    }),
  }, openAttemptId)
  const project = response?.data || response?.project || response
  const projectId = project?.id
  if (!projectId) throw new Error(`create response did not contain a project id: ${JSON.stringify(response)}`)
  return { projectId, ms: Math.round(now() - start) }
}

async function openFolder(openAttemptId: string): Promise<{ projectId: string; ms: number }> {
  const start = now()
  const response = await json<any>(`${apiBase}/api/local/projects/from-folders`, {
    method: 'POST',
    body: JSON.stringify({
      paths: [folderPath],
      workspaceId,
      name: `perf-folder-${Date.now()}`,
      acceptedGitRoot: true,
    }),
  }, openAttemptId)
  const project = response?.project || response?.data || response
  const projectId = project?.id
  if (!projectId) throw new Error(`open-folder response did not contain a project id: ${JSON.stringify(response)}`)
  return { projectId, ms: Math.round(now() - start) }
}

async function waitForSandbox(projectId: string, openAttemptId: string): Promise<{
  data: any
  ms: number
}> {
  const start = now()
  const data = await waitFor(async () => {
    const response = await fetch(`${apiBase}/api/projects/${encodeURIComponent(projectId)}/sandbox/url`, {
      headers: headers(openAttemptId),
    })
    if (!response.ok) return null
    const body = await response.json() as any
    return body?.ready === true ? body : null
  }, 180_000)
  return { data, ms: Math.round(now() - start) }
}

async function measureEndpoint(url: string, openAttemptId: string): Promise<number | null> {
  const start = now()
  try {
    await waitFor(async () => {
      const response = await fetch(url, { headers: headers(openAttemptId) })
      if (!response.ok) return null
      const body = await response.json().catch(() => null) as any
      return body?.ready === false ? null : body
    }, 60_000, 250)
    return Math.round(now() - start)
  } catch {
    return null
  }
}

async function deleteProject(projectId: string, openAttemptId: string): Promise<void> {
  try {
    await stopRuntime(projectId, openAttemptId).catch(() => {})
    await json(`${apiBase}/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }, openAttemptId)
  } catch (error) {
    console.warn(`[bench] cleanup failed for ${projectId}: ${String(error)}`)
    return
  }
  // The API delete removes the DB row but (at least through 1.14.x) leaves the
  // seeded workspace + node_modules on disk. Only touch dirs we created.
  if (workspacesDir && /^[0-9a-f-]{36}$/i.test(projectId)) {
    const dir = join(workspacesDir, projectId)
    try {
      // The runtime's background git layer may still hold files briefly after stop.
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 })
    } catch (error) {
      console.warn(`[bench] could not remove ${dir}: ${String(error)}`)
    }
  }
}

function markerFor(projectId: string): boolean | null {
  if (!workspacesDir) return null
  try {
    return existsSync(join(workspacesDir, projectId, 'node_modules', '.install-ok'))
  } catch {
    return null
  }
}

async function runOne(run: number): Promise<Sample> {
  const openAttemptId = `bench-${Date.now().toString(36)}-${run}`
  const sample: Sample = { scenario, run }
  let projectId = projectIdArg
  let poolPortsBefore: number[] = []
  let gestureStart = now()
  try {
    if (scenario === 'new') {
      const created = await createProject(openAttemptId)
      projectId = created.projectId
      sample.projectId = projectId
      sample.createMs = created.ms
    } else if (scenario === 'open-folder') {
      const opened = await openFolder(openAttemptId)
      projectId = opened.projectId
      sample.projectId = projectId
      sample.createMs = opened.ms
    } else if (scenario === 'existing-cold') {
      const down = await takeDownRuntime(projectId!, openAttemptId)
      sample.projectId = projectId
      sample.coldMode = coldMode
      sample.killedTarget = down.killedTarget
      sample.killedPool = down.killedPool
      poolPortsBefore = down.poolPortsBefore
      // The takedown is test setup, not part of the user's open gesture.
      gestureStart = now()
    } else {
      sample.projectId = projectId
    }

    const sandbox = await waitForSandbox(projectId!, openAttemptId)
    sample.sandboxMs = sandbox.ms
    sample.runtimePort = portOf(sandbox.data?.directUrl || sandbox.data?.url)
    if (scenario === 'existing-cold' && coldMode !== 'stop') {
      sample.servedByPool = sample.runtimePort != null && poolPortsBefore.includes(sample.runtimePort)
    }
    // Probe through the API's agent-proxy: it is what the renderer uses and it
    // accepts the session cookie. The direct runtime port (`directUrl`) gates
    // `/agent/*` behind a runtime token, so hitting it from here 401s forever.
    const proxyBase = (
      sandbox.data?.agentUrl
      || `${apiBase}/api/projects/${encodeURIComponent(projectId!)}/agent-proxy`
    ).replace(/\/+$/, '')
    sample.healthMs = await measureEndpoint(`${proxyBase}/health`, openAttemptId)
    sample.gatewayMs = await measureEndpoint(`${proxyBase}/ready/gateway`, openAttemptId)
    sample.filesMs = await measureEndpoint(`${proxyBase}/agent/workspace/tree`, openAttemptId)
    sample.totalMs = sample.filesMs == null ? null : Math.round(now() - gestureStart)
    if (sessionId) {
      const chatStart = now()
      try {
        const response = await fetch(`${proxyBase}/agent/chat`, {
          method: 'POST',
          headers: headers(openAttemptId),
          body: JSON.stringify({ sessionId, messages: [{ role: 'user', content: 'perf ping' }] }),
        })
        if (response.ok) {
          for await (const _ of response.body ? response.body : []) break
          sample.chatMs = Math.round(now() - chatStart)
        }
      } catch {
        sample.chatMs = null
      }
    }
    sample.installMarker = markerFor(projectId!)
    return sample
  } catch (error: any) {
    sample.error = error?.message ?? String(error)
    return sample
  } finally {
    if (cleanup && projectId && (scenario === 'new' || scenario === 'open-folder')) {
      await deleteProject(projectId, openAttemptId)
    }
  }
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!
}

const samples: Sample[] = []
await autoSignInLocal()
for (let run = 1; run <= runs; run++) {
  if (run > 1 && pauseMs > 0) await Bun.sleep(pauseMs)
  const sample = await runOne(run)
  samples.push(sample)
  console.log(JSON.stringify(sample))
}

const metricNames = ['createMs', 'sandboxMs', 'healthMs', 'gatewayMs', 'filesMs', 'chatMs', 'totalMs'] as const
const summary = Object.fromEntries(metricNames.map((metric) => {
  const values = samples.map((s) => s[metric]).filter((value): value is number => typeof value === 'number')
  return [metric, { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length ? Math.max(...values) : null }]
}))
const result = {
  generatedAt: new Date().toISOString(),
  host: hostname(),
  platform: platform(),
  memoryGB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
  apiBase,
  scenario,
  runs,
  samples,
  summary,
}
const outputDir = arg('output-dir', 'bench-results')!
mkdirSync(outputDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const jsonPath = join(outputDir, `${platform()}-${scenario}-${stamp}.json`)
const markdownPath = join(outputDir, `${platform()}-${scenario}-${stamp}.md`)
writeFileSync(jsonPath, JSON.stringify(result, null, 2))
writeFileSync(markdownPath, [
  `# Project open benchmark: ${scenario}`,
  '',
  `Host: ${hostname()} (${platform()}, ${result.memoryGB} GB)`,
  '',
  '| Metric | Samples | p50 | p95 | Max |',
  '|---|---:|---:|---:|---:|',
  ...metricNames.map((metric) => {
    const s = summary[metric]
    return `| ${metric} | ${s.count} | ${s.p50 ?? 'n/a'} | ${s.p95 ?? 'n/a'} | ${s.max ?? 'n/a'} |`
  }),
  '',
].join('\n'))
console.log(`Wrote ${jsonPath}`)
console.log(`Wrote ${markdownPath}`)
