// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Metal density soak — how many VMs one host carries before agent turns degrade.
 *
 * Runs ON the bare-metal host as root (see scripts/metal-agent/run-density-soak.sh)
 * and drives the node-agent's own HTTP API on loopback, the same contract the
 * control plane uses. It answers one question with data instead of a guess:
 * `METAL_MAX_VMS_PER_HOST` defaults to 80 on the belief that "an s3-large-x86
 * comfortably runs ~80 ~1 GB microVMs", while prod VMs are 2 vCPU / 2–4 GiB and
 * prod hosts were raised to 120. Nothing had measured it.
 *
 * What it does:
 *   1. Preflight: refuse unless the host is staging-registered, cordon it,
 *      record `/etc/metal-agent.env`, raise the VM cap and disable idle-suspend
 *      for the run, restart the agent so the env takes effect.
 *   2. Baseline: one VM runs the agent-turn workload 5× alone.
 *   3. Steps: grow to each N (VMs are kept between steps), assign roles by the
 *      prod mix, hold, and sample the host every 5 s while agent-role VMs loop
 *      turns and app-role VMs serve HTTP.
 *   4. Burst: at the highest passing N and at N=80, start a fraction of N turns
 *      inside a short window on top of the steady mix.
 *   5. Report: per-step table, both knees, and a recommendation.
 *   6. Teardown (trap/finally, including SIGINT): destroy every `soak-` VM,
 *      restore the env, restart the agent, uncordon.
 *
 * Safety: staging only, cordoned, abort guard on MemAvailable < 5% or any OOM
 * kill, and it never touches a project id that is not `soak-<runId>-*`.
 */

import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { HostSampler, oomKillsSince, percentile, type HostSample } from './density/host-sampler'
import { DEFAULT_MIX, allocateRoles, parseMix, roleCounts, type Mix, type Role } from './density/mix'
import { DEFAULT_BOUNDS, TURN_STEPS, computeKnees, ramCeilingsBySize, type Bounds, type StepMetrics, type TurnStep } from './density/knee'
import { primeWarmCache, runAgentTurn, seedTemplate, startAppLoad, type AppLoadHandle, type TurnTimings } from './density/guest-workload'
import { assertStagingHost, DEFAULT_STAGING_CONTROL_PLANES, DEFAULT_STAGING_HOSTS } from './density/staging-guard'
import { perVmRssMiB as perVmRssMiBFrom, writeReport, type BurstRow, type ReportInput, type RunEnv, type StepRow } from './density/report'
import { recomputeReport } from './density/recompute'

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export interface SoakOptions {
  host: string
  base: string
  envFile: string
  steps: number[]
  holdMs: number
  rampConcurrency: number
  mix: Mix
  burst: boolean
  burstWindowMs: number
  burstFraction: number
  memMiB?: number
  vcpus?: number
  outDir: string
  adminToken?: string
  assumeCordoned: boolean
  restartAgent: boolean
  probeResume: boolean
  sampleMs: number
  abortMemPct: number
  allowHosts: string[]
  allowControlPlanes: string[]
  bounds: Bounds
  dryRun: boolean
  /** Re-derive the report of an already-recorded run instead of soaking. */
  fromResults?: string
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** `10m`, `90s`, `2h`, `500ms` → ms. A bare number is ms. */
export function parseDuration(v: string | undefined, fallbackMs: number): number {
  if (!v) return fallbackMs
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(v.trim())
  if (!m) return fallbackMs
  const unit = (m[2] ?? 'ms').toLowerCase()
  const mult = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1
  return Math.round(Number(m[1]) * mult)
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): SoakOptions {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1]
    const eq = argv.find((a) => a.startsWith(`--${name}=`))
    return eq ? eq.slice(name.length + 3) : undefined
  }
  const has = (name: string) => argv.includes(`--${name}`) || argv.some((a) => a.startsWith(`--${name}=`))

  const steps = (get('steps') ?? '40,60,80,100,120,160')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b)

  return {
    host: get('host') ?? env.METAL_HOST_ID ?? '',
    base: get('base') ?? env.DENSITY_SOAK_BASE ?? 'http://127.0.0.1:9900',
    envFile: get('env-file') ?? env.DENSITY_SOAK_ENV_FILE ?? '/etc/metal-agent.env',
    steps,
    holdMs: get('hold-ms') ? num(get('hold-ms'), 10 * 60_000) : parseDuration(get('hold'), 10 * 60_000),
    rampConcurrency: num(get('ramp-concurrency'), 8),
    mix: get('mix') ? parseMix(get('mix')!) : DEFAULT_MIX,
    burst: has('burst'),
    burstWindowMs: get('burst-window-ms') ? num(get('burst-window-ms'), 60_000) : parseDuration(get('burst-window'), 60_000),
    burstFraction: num(get('burst-fraction'), 0.25),
    memMiB: get('mem-mib') ? num(get('mem-mib'), 0) : undefined,
    vcpus: get('vcpus') ? num(get('vcpus'), 0) : undefined,
    outDir: get('out') ?? join(import.meta.dir, 'results', `density-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`),
    adminToken: get('admin-token') ?? env.DENSITY_SOAK_ADMIN_TOKEN,
    assumeCordoned: has('assume-cordoned'),
    restartAgent: !has('no-restart-agent'),
    probeResume: !has('no-probe-resume'),
    sampleMs: num(get('sample-ms'), 5000),
    abortMemPct: num(get('abort-mem-pct'), 5),
    allowHosts: (get('allow-hosts') ?? env.DENSITY_SOAK_STAGING_HOSTS ?? DEFAULT_STAGING_HOSTS.join(',')).split(',').map((s) => s.trim()).filter(Boolean),
    allowControlPlanes: (get('allow-control-planes') ?? env.DENSITY_SOAK_STAGING_CONTROL_PLANES ?? DEFAULT_STAGING_CONTROL_PLANES.join(','))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    bounds: DEFAULT_BOUNDS,
    dryRun: has('dry-run'),
    fromResults: get('from-results'),
  }
}

// ---------------------------------------------------------------------------
// Host env file
// ---------------------------------------------------------------------------

/** Parse a systemd EnvironmentFile (`KEY=value`, `#` comments, optional quotes). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const k = line.slice(0, eq).trim()
    let v = line.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[k] = v
  }
  return out
}

/** Render back to an EnvironmentFile, preserving key order. */
export function renderEnvFile(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Node-agent client
// ---------------------------------------------------------------------------

interface AgentResponse {
  ok: boolean
  status: number
  ms: number
  json: any
}

class AgentClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  async req(method: string, path: string, body?: unknown, timeoutMs = 240_000): Promise<AgentResponse> {
    const t0 = performance.now()
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
      const json = await res.json().catch(() => null)
      return { ok: res.ok, status: res.status, ms: +(performance.now() - t0).toFixed(1), json }
    } catch (err: any) {
      return { ok: false, status: 0, ms: +(performance.now() - t0).toFixed(1), json: { error: err?.message ?? String(err) } }
    }
  }

  assign(projectId: string, env: Record<string, string>) {
    return this.req('POST', '/assign', { projectId, env })
  }
  suspend(projectId: string) {
    return this.req('POST', '/suspend', { projectId })
  }
  destroy(projectId: string) {
    return this.req('POST', '/destroy', { projectId })
  }
  touch(projectId: string) {
    return this.req('POST', '/touch', { projectId }, 10_000)
  }
  vms() {
    return this.req('GET', '/vms', undefined, 30_000)
  }
  healthz() {
    return this.req('GET', '/healthz', undefined, 5_000)
  }
}

const ASSIGN_ENV = { RUNTIME_AUTH_SECRET: 'e2e', PROJECT_TIER: 'starter' }

/**
 * Turns measured on the lone baseline VM. `percentile` is nearest-rank, so p95
 * of 9 samples is just the max; 20 puts it on the second-highest instead.
 */
const BASELINE_TURNS = 20

/** Simultaneous destroys in teardown; the node-agent handles this fine. */
const TEARDOWN_CONCURRENCY = 8

/**
 * The N=1 baseline, as the statistic the bounds are actually applied to.
 *
 * `evaluateStep` compares each step's turn p95 against this number, so it has to
 * be a p95 as well: against a p50 baseline a host with no contention at all
 * fails on its own tail (soak #5: N=40 at 0.3% CPU PSI failed `install p95 2.68x`
 * because the baseline was the median of the same distribution).
 */
export function baselineFromTurns(turns: TurnTimings[]): Record<TurnStep, number> {
  const ok = turns.filter((t) => t.ok)
  const out = {} as Record<TurnStep, number>
  for (const s of TURN_STEPS) out[s] = +percentile(ok.map((t) => Number((t as any)[`${s}Ms`]) || 0), 95).toFixed(1)
  return out
}

/**
 * Rewrite an assign URL into one this host can actually reach.
 *
 * `/assign` returns the guest's *published* address (`METAL_PUBLIC_HOST:<dnat>`),
 * which is correct for a caller outside the host but unusable from the host
 * itself: the DNAT lives in PREROUTING, so a connection the host originates to
 * its own public IP never matches it and times out. (This is the bug that made
 * the first live run die at baseline with "Unable to connect".) The guest is on
 * a /30 behind a tap device, so we resolve the same DNAT rule and talk to the
 * guest's private address directly.
 */
export function resolveGuestUrl(publicUrl: string | undefined, publicHost: string, natRules: () => string): string | undefined {
  if (!publicUrl) return publicUrl
  let u: URL
  try {
    u = new URL(publicUrl)
  } catch {
    return publicUrl
  }
  if (!publicHost || u.hostname !== publicHost || !u.port) return publicUrl
  const m = new RegExp(`--dport ${u.port}\\s.*--to-destination ([0-9.]+):(\\d+)`).exec(natRules())
  return m ? `http://${m[1]}:${m[2]}` : publicUrl
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const log = (step: string, msg: string) => console.log(`[density] ${step.padEnd(10)} ${msg}`)

interface SoakVm {
  projectId: string
  role: Role
  url?: string
  assigned: boolean
  /** The guest already has the template seeded (`seed`) or fully primed (`prime`). */
  seeded?: 'seed' | 'prime'
}

/**
 * Which guests still need the template written to them.
 *
 * Both working roles need it: an agent turn `cd`s into the template for every
 * step, and `startAppRoles` `cd`s into the same directory to run `app-server.ts`.
 * Only the agent role also needs the warm package cache and git repo that the
 * `install` and `git` steps measure, so the app role gets the files alone.
 *
 * Idle guests are never seeded: they must stay cold, and a turn on one is not
 * part of the workload.
 */
export function planSeeding(vms: SoakVm[]): { seed: SoakVm[]; prime: SoakVm[] } {
  const seed: SoakVm[] = []
  const prime: SoakVm[] = []
  for (const vm of vms) {
    if (!vm.assigned || !vm.url) continue
    if (vm.role === 'agent') {
      if (vm.seeded !== 'prime') prime.push(vm)
    } else if (vm.role === 'app') {
      if (!vm.seeded) seed.push(vm)
    }
  }
  return { seed, prime }
}

export class DensitySoak {
  private readonly agent: AgentClient
  private readonly sampler = new HostSampler()
  private readonly samples: HostSample[] = []
  private readonly turns: { n: number; role: string; projectId: string; t: Record<string, any> }[] = []
  private readonly vms: SoakVm[] = []
  private readonly probeIds: string[] = []
  private readonly runId = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
  private readonly startedAt = new Date().toISOString()
  private readonly startedMs = Date.now()
  private originalEnv: Record<string, string> | null = null
  /**
   * Host-wide Firecracker RSS before the soak added a single VM. `fcRssMiB` sums
   * every guest on the host, including the projects that were already resident,
   * so the soak's share of it is the delta from here.
   */
  private rssBeforeMiB = 0
  /** The env file exactly as it was, so teardown restores it byte-for-byte. */
  private originalEnvText: string | null = null
  private cordoned = false
  private agentRestarted = false
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  private sampleTimer: ReturnType<typeof setInterval> | null = null
  private appLoads: AppLoadHandle[] = []
  private abortReason: string | undefined
  private residentBefore: string[] = []
  private hostInfo: { model: string; kernel: string; fcVersion: string; threads: number; memMiB: number; gitSha: string } = {
    model: 'unknown',
    kernel: 'unknown',
    fcVersion: 'unknown',
    threads: 0,
    memMiB: 0,
    gitSha: 'unknown',
  }

  constructor(private readonly opts: SoakOptions) {
    const token = this.readToken()
    this.agent = new AgentClient(opts.base, token)
  }

  private readToken(): string {
    try {
      const env = parseEnvFile(readFileSync(this.opts.envFile, 'utf8'))
      return env.METAL_REGISTER_TOKEN ?? env.SHOGO_INTERNAL_SECRET ?? ''
    } catch {
      return process.env.METAL_REGISTER_TOKEN ?? ''
    }
  }

  private readHostEnv(): Record<string, string> {
    return parseEnvFile(readFileSync(this.opts.envFile, 'utf8'))
  }

  private sh(cmd: string, args: string[]): string {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return ''
    }
  }

  /** The address this host publishes guests on, so we can tell a local URL apart. */
  private guestUrl(publicUrl: string | undefined): string | undefined {
    return resolveGuestUrl(publicUrl, this.originalEnv?.METAL_PUBLIC_HOST ?? '', () => this.sh('iptables', ['-t', 'nat', '-S']))
  }

  private collectHostInfo(): void {
    const cpuinfo = (() => {
      try {
        return readFileSync('/proc/cpuinfo', 'utf8')
      } catch {
        return ''
      }
    })()
    const model = /model name\s*:\s*(.+)/.exec(cpuinfo)?.[1]?.trim() ?? 'unknown'
    const threads = (cpuinfo.match(/^processor\s*:/gm) ?? []).length
    const mem = this.sampler.sample()
    this.hostInfo = {
      model,
      kernel: this.sh('uname', ['-r']) || 'unknown',
      fcVersion: this.sh('/opt/fc-spike/bin/firecracker', ['--version']).split('\n')[0] || 'unknown',
      threads,
      memMiB: mem.mem?.totalMiB ?? 0,
      gitSha: this.sh('git', ['-C', join(import.meta.dir, '..', '..', '..'), 'rev-parse', '--short', 'HEAD']) || process.env.DENSITY_SOAK_GIT_SHA || 'unknown',
    }
  }

  // -- preflight ------------------------------------------------------------

  async preflight(): Promise<void> {
    log('preflight', `host=${this.opts.host || '(unset)'} base=${this.opts.base} env=${this.opts.envFile}`)

    if (!existsSync(this.opts.envFile)) {
      throw new Error(`env file ${this.opts.envFile} not found — run this on the host as root`)
    }
    this.originalEnvText = readFileSync(this.opts.envFile, 'utf8')
    this.originalEnv = parseEnvFile(this.originalEnvText)
    if (this.originalEnv.METAL_IDLE_SUSPEND_MS === '0') {
      throw new Error(
        `refusing to soak: ${this.opts.envFile} already has METAL_IDLE_SUSPEND_MS=0, so an earlier run was interrupted and left the host soaked. ` +
          'Restore it first (drop METAL_MAX_VMS_PER_HOST, set METAL_IDLE_SUSPEND_MS=1800000), restart metal-agent, then run.',
      )
    }
    // A run-scoped copy. A single shared `.pre-soak.bak` gets overwritten by the
    // *next* run's capture, which is how a host ends up with its "original" env
    // recorded as MAX=200 / IDLE=0.
    writeFileSync(`${this.opts.envFile}.pre-soak-${this.runId}.bak`, this.originalEnvText)
    log('preflight', `pre-run env saved to ${this.opts.envFile}.pre-soak-${this.runId}.bak`)
    const controlPlaneUrl = this.originalEnv.METAL_CONTROL_PLANE_URL ?? ''
    const region = this.originalEnv.METAL_REGION ?? ''

    const guard = await assertStagingHost({
      hostId: this.opts.host,
      controlPlaneUrl,
      region,
      allowHosts: this.opts.allowHosts,
      allowControlPlaneHosts: this.opts.allowControlPlanes,
      token: this.originalEnv.METAL_REGISTER_TOKEN ?? '',
    })
    if (!guard.ok) {
      throw new Error(`refusing to soak: ${guard.reasons.join('; ')}`)
    }
    log('preflight', `staging confirmed: ${this.opts.host} → ${controlPlaneUrl}`)

    const health = await this.agent.healthz()
    if (!health.ok) throw new Error(`node-agent not reachable at ${this.opts.base}: ${JSON.stringify(health.json)}`)

    this.collectHostInfo()
    log('preflight', `host: ${this.hostInfo.model}, ${this.hostInfo.threads} threads, ${this.hostInfo.memMiB} MiB, kernel ${this.hostInfo.kernel}`)

    // Record what is already resident. These are real staging projects: never
    // suspend, touch or destroy them.
    const vms = await this.agent.vms()
    const assigned: any[] = vms.json?.assigned ?? []
    const suspended: any[] = vms.json?.suspended ?? []
    this.residentBefore = [...assigned, ...suspended].map((v) => v.projectId).filter((p) => typeof p === 'string' && !p.startsWith('soak-'))
    log('preflight', `${this.residentBefore.length} real project(s) resident — will not be touched`)

    if (this.opts.dryRun) {
      log('preflight', 'dry run: stopping before cordon/env swap')
      return
    }

    await this.cordon(true)
    await this.swapEnv()
  }

  private async cordon(on: boolean): Promise<void> {
    if (this.opts.assumeCordoned) {
      log('cordon', on ? 'assuming the operator cordoned the host (--assume-cordoned)' : 'leaving cordon state alone (--assume-cordoned)')
      return
    }
    if (!this.opts.adminToken) {
      throw new Error('no admin token: set DENSITY_SOAK_ADMIN_TOKEN (a super-admin session) or pass --assume-cordoned after cordoning by hand')
    }
    const cp = (this.originalEnv?.METAL_CONTROL_PLANE_URL ?? '').replace(/\/+$/, '')
    const action = on ? 'cordon' : 'uncordon'
    const res = await fetch(`${cp}/api/admin/metal/hosts/${encodeURIComponent(this.opts.host)}/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.adminToken}` },
      signal: AbortSignal.timeout(20_000),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok || !(body as any)?.ok) throw new Error(`${action} failed (${res.status}): ${JSON.stringify(body)}`)
    this.cordoned = on
    log('cordon', `${action}ed ${this.opts.host}`)
  }

  private async swapEnv(): Promise<void> {
    const env = { ...this.originalEnv! }
    const top = Math.max(...this.opts.steps, 0)
    env.METAL_MAX_VMS_PER_HOST = String(Math.max(top + 20, 200))
    env.METAL_IDLE_SUSPEND_MS = '0'
    writeFileSync(this.opts.envFile, renderEnvFile(env))
    log('env', `raised METAL_MAX_VMS_PER_HOST to ${env.METAL_MAX_VMS_PER_HOST}, METAL_IDLE_SUSPEND_MS=0`)
    if (this.opts.restartAgent) await this.restartAgent()
  }

  private async restartAgent(): Promise<void> {
    log('agent', 'restarting metal-agent to pick up the env')
    this.sh('systemctl', ['restart', 'metal-agent'])
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const h = await this.agent.healthz()
      if (h.ok) {
        this.agentRestarted = true
        log('agent', 'metal-agent healthy again')
        return
      }
      await Bun.sleep(1000)
    }
    throw new Error('metal-agent did not come back healthy within 120s')
  }

  // -- sampling -------------------------------------------------------------

  private startSampling(): void {
    this.sampleTimer = setInterval(() => {
      const s = this.sampler.sample()
      this.samples.push(s)
      if (s.memAvailablePct !== null && s.memAvailablePct < this.opts.abortMemPct && !this.abortReason) {
        this.abortReason = `MemAvailable fell to ${s.memAvailablePct}% (abort floor ${this.opts.abortMemPct}%)`
        log('abort', this.abortReason)
      }
    }, this.opts.sampleMs)
  }

  private stopSampling(): void {
    if (this.sampleTimer) clearInterval(this.sampleTimer)
    this.sampleTimer = null
  }

  /** Touch every soak VM so the reaper cannot suspend an idle one mid-hold. */
  private startKeepAlive(): void {
    this.keepAliveTimer = setInterval(() => {
      for (const vm of this.vms) if (vm.assigned) void this.agent.touch(vm.projectId)
    }, 10_000)
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer)
    this.keepAliveTimer = null
  }

  private checkAbort(): void {
    if (this.abortReason) throw new Error(`aborted: ${this.abortReason}`)
    const oom = oomKillsSince(this.startedMs)
    if (oom > 0) {
      this.abortReason = `${oom} OOM kill(s) since the run started`
      throw new Error(`aborted: ${this.abortReason}`)
    }
  }

  // -- workload -------------------------------------------------------------

  private projectId(role: Role, index: number): string {
    return `soak-${this.runId}-${role}-${String(index).padStart(4, '0')}`
  }

  async growTo(n: number): Promise<void> {
    const roles = allocateRoles(n, this.opts.mix)
    const toAdd: { projectId: string; role: Role }[] = []
    for (let i = this.vms.length; i < n; i++) toAdd.push({ projectId: this.projectId(roles[i], i), role: roles[i] })

    let next = 0
    const worker = async () => {
      while (next < toAdd.length) {
        const item = toAdd[next++]
        const a = await this.agent.assign(item.projectId, ASSIGN_ENV)
        const vm: SoakVm = { projectId: item.projectId, role: item.role, url: this.guestUrl(a.json?.url), assigned: a.ok }
        this.vms.push(vm)
        if (!a.ok) log('ramp', `assign ${item.projectId} failed (${a.status}): ${JSON.stringify(a.json).slice(0, 160)}`)
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.opts.rampConcurrency, toAdd.length) }, worker))
    log('ramp', `at N=${this.vms.length} (${JSON.stringify(roleCounts(this.vms.length, this.opts.mix))})`)
  }

  private async runTurnsFor(role: Role, n: number, deadline: number, skipLlmWait = false): Promise<void> {
    const targets = this.vms.filter((v) => v.role === role && v.assigned && v.url)
    let next = 0
    const worker = async () => {
      while (next < targets.length && Date.now() < deadline && !this.abortReason) {
        const vm = targets[next++]
        try {
          const t = await runAgentTurn(vm.url!, { skipLlmWait })
          this.turns.push({ n, role, projectId: vm.projectId, t: { ...t } })
        } catch (err: any) {
          this.turns.push({ n, role, projectId: vm.projectId, t: { ok: false, error: err?.message ?? String(err) } })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(targets.length, 64) }, worker))
  }

  private async startAppRoles(): Promise<void> {
    for (const vm of this.vms) {
      if (vm.role !== 'app' || !vm.assigned || !vm.url) continue
      try {
        this.appLoads.push(await startAppLoad(vm.url, 2))
      } catch (err: any) {
        log('app', `${vm.projectId}: ${err?.message ?? err}`)
      }
    }
  }

  private stopAppRoles(): void {
    for (const a of this.appLoads) a.stop()
    this.appLoads = []
  }

  /** Resume latency for the dedicated probe projects, under the current load. */
  private async probeResume(): Promise<number[]> {
    if (!this.opts.probeResume) return []
    const out: number[] = []
    for (const pid of this.probeIds) {
      await this.agent.suspend(pid)
      const a = await this.agent.assign(pid, ASSIGN_ENV)
      if (a.ok) out.push(a.json?.readyMs ?? a.ms)
    }
    return out
  }

  private async apiLatency(): Promise<number[]> {
    const out: number[] = []
    for (let i = 0; i < 5; i++) {
      out.push((await this.agent.healthz()).ms)
      out.push((await this.agent.vms()).ms)
    }
    return out
  }

  private turnP95(n: number, role: string = 'agent'): Record<TurnStep, number> {
    const rows = this.turns.filter((t) => t.n === n && t.role === role && t.t.ok)
    const out = {} as Record<TurnStep, number>
    for (const s of TURN_STEPS) out[s] = +percentile(rows.map((r) => Number(r.t[`${s}Ms`]) || 0), 95).toFixed(1)
    return out
  }

  private turnP50(n: number, role: string = 'agent'): Record<TurnStep, number> {
    const rows = this.turns.filter((t) => t.n === n && t.role === role && t.t.ok)
    const out = {} as Record<TurnStep, number>
    for (const s of TURN_STEPS) out[s] = +percentile(rows.map((r) => Number(r.t[`${s}Ms`]) || 0), 50).toFixed(1)
    return out
  }

  private windowSamples(fromMs: number, toMs: number): HostSample[] {
    return this.samples.filter((s) => s.ts >= fromMs && s.ts <= toMs)
  }

  private avg(xs: number[]): number {
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
  }

  private stepMetrics(n: number, fromMs: number, toMs: number, resume: number[], api: number[]): StepMetrics {
    const win = this.windowSamples(fromMs, toMs)
    const last = win[win.length - 1]
    return {
      n,
      turnP95: this.turnP95(n),
      cpuPsiSomeAvg60: last?.cpuPressure?.some60 ?? 0,
      resumeP95Ms: +percentile(resume, 95).toFixed(1),
      oomKills: oomKillsSince(this.startedMs),
      swapInPagesPerSec: +this.avg(win.map((s) => s.swapInPagesPerSec ?? 0)).toFixed(1),
      memPsiFullAvg60: last?.memPressure?.full60 ?? 0,
      memAvailablePct: last?.memAvailablePct ?? 0,
    }
  }

  // -- main -----------------------------------------------------------------

  async run(): Promise<ReportInput> {
    await this.preflight()
    if (this.opts.dryRun) {
      return this.buildReport([], [], { cpuKnee: 0, ramKnee: 0, recommended: 0, verdicts: [] })
    }

    this.rssBeforeMiB = this.sampler.sample().fcRssMiB
    log('preflight', `FC RSS before the soak: ${this.rssBeforeMiB} MiB`)
    this.startSampling()
    this.startKeepAlive()

    // Probe projects: 3 dedicated ids, suspended between steps, used only to
    // measure resume latency under load.
    for (let i = 0; i < 3; i++) this.probeIds.push(`soak-${this.runId}-probe-${i}`)
    for (const pid of this.probeIds) await this.agent.assign(pid, ASSIGN_ENV)

    // Baseline: one VM, alone, turns with no llm wait.
    log('baseline', `N=1, ${BASELINE_TURNS} turns`)
    await this.growTo(1)
    const baseVm = this.vms[0]
    if (!baseVm?.url) throw new Error('baseline VM did not come up')
    await primeWarmCache(baseVm.url)
    const baselineTurns: TurnTimings[] = []
    for (let i = 0; i < BASELINE_TURNS; i++) {
      const t = await runAgentTurn(baseVm.url, { skipLlmWait: true })
      baselineTurns.push(t)
      this.turns.push({ n: 1, role: 'agent', projectId: baseVm.projectId, t: { ...t } })
    }
    if (baselineTurns.filter((t) => t.ok).length === 0) throw new Error('all baseline turns failed; cannot derive the N=1 baseline')
    const baseline = baselineFromTurns(baselineTurns)
    log('baseline', TURN_STEPS.map((s) => `${s} ${baseline[s]}ms p95`).join(' '))

    const rows: StepRow[] = []
    const burstRows: BurstRow[] = []
    const vcpus = this.opts.vcpus ?? Number(this.originalEnv?.METAL_VCPUS ?? 2)
    const memMiB = this.opts.memMiB ?? Number(this.originalEnv?.METAL_MEM_MIB ?? 1024)

    for (const n of this.opts.steps) {
      this.checkAbort()
      log('step', `growing to N=${n}`)
      await this.growTo(n)
      // Seed every working guest before the hold, so `install` measures CPU and
      // disk rather than the registry and the app role has a template to serve.
      const seeding = planSeeding(this.vms)
      for (const vm of seeding.seed) {
        try {
          await seedTemplate(vm.url!)
          vm.seeded = 'seed'
        } catch (err: any) {
          log('prime', `${vm.projectId}: ${err?.message ?? err}`)
        }
      }
      for (const vm of seeding.prime) {
        try {
          await primeWarmCache(vm.url!)
          vm.seeded = 'prime'
        } catch (err: any) {
          log('prime', `${vm.projectId}: ${err?.message ?? err}`)
        }
      }
      await this.startAppRoles()

      const from = Date.now()
      const deadline = from + this.opts.holdMs
      log('hold', `N=${n} for ${Math.round(this.opts.holdMs / 1000)}s`)
      const turnLoop = this.runTurnsFor('agent', n, deadline)
      const resume: number[] = []
      const api: number[] = []
      while (Date.now() < deadline) {
        this.checkAbort()
        resume.push(...(await this.probeResume()))
        api.push(...(await this.apiLatency()))
        await Bun.sleep(Math.min(30_000, Math.max(1000, deadline - Date.now())))
      }
      await turnLoop
      this.stopAppRoles()
      const to = Date.now()

      // Density is the number of VMs that actually came up, not the target. A
      // ramp that loses boots to `FC API socket never appeared` leaves the step
      // holding fewer guests than its N claims.
      const assigned = this.vms.filter((v) => v.assigned).length
      if (assigned === 0) {
        log('step', `target N=${n} skipped: no VM was assigned`)
        continue
      }

      const metrics = { ...this.stepMetrics(n, from, to, resume, api), n: assigned }
      const verdict = computeKnees([metrics], baseline, this.opts.bounds).verdicts[0]
      const win = this.windowSamples(from, to)
      const last = win[win.length - 1]
      rows.push({
        ...metrics,
        cpuOversubRatio: this.hostInfo.threads > 0 ? +((assigned * vcpus) / this.hostInfo.threads).toFixed(2) : 0,
        ramCommittedMiB: assigned * memMiB,
        ramPhysicalMiB: Math.max(0, (last?.fcRssMiB ?? 0) - this.rssBeforeMiB),
        ramPhysicalBasis: 'soak-delta',
        turnP50: this.turnP50(n),
        runDelayP95MsPerSec: last?.runDelayMsPerSec?.p95 ?? 0,
        apiP95Ms: +percentile(api, 95).toFixed(1),
        verdict,
      })
      log(
        'step',
        `target N=${n} measured N=${assigned} cpu=${verdict.cpuPass ? 'pass' : 'FAIL'} ram=${verdict.ramPass ? 'pass' : 'FAIL'} memAvail=${metrics.memAvailablePct}%`,
      )
    }

    // Burst: at the highest passing N and at N=80 for comparison.
    if (this.opts.burst) {
      const knees = computeKnees(rows, baseline, this.opts.bounds)
      const targets = [...new Set([knees.recommended, 80].filter((n) => n > 0 && n <= Math.max(...this.opts.steps)))]
      for (const n of targets) {
        this.checkAbort()
        if (this.vms.length < n) await this.growTo(n)
        const from = Date.now()
        const deadline = from + this.opts.burstWindowMs
        const started = Math.max(1, Math.round(n * this.opts.burstFraction))
        log('burst', `N=${n}: ${started} turns in ${Math.round(this.opts.burstWindowMs / 1000)}s`)
        // Agent VMs only. The burst is "many turns start at once", and the idle
        // and app guests are never primed with the template — a turn on one fails
        // at its first step (`cd: /app/workspace/... no such file`) and records
        // nothing. 15 of 20 burst turns were empty on the 2026-11-23 run.
        const targets2 = this.vms.filter((v) => v.role === 'agent' && v.assigned && v.url).slice(0, started)
        if (targets2.length < started) {
          log('burst', `N=${n}: only ${targets2.length} primed agent VM(s) available for ${started} burst turn(s)`)
        }
        await Promise.all(
          targets2.map(async (vm) => {
            try {
              const t = await runAgentTurn(vm.url!, { skipLlmWait: true })
              this.turns.push({ n, role: 'burst', projectId: vm.projectId, t: { ...t } })
            } catch (err: any) {
              this.turns.push({ n, role: 'burst', projectId: vm.projectId, t: { ok: false, error: err?.message ?? String(err) } })
            }
          }),
        )
        const to = Date.now()
        const metrics = this.stepMetrics(n, from, to, [], [])
        const verdict = computeKnees([metrics], baseline, this.opts.bounds).verdicts[0]
        burstRows.push({
          n,
          fraction: this.opts.burstFraction,
          windowMs: this.opts.burstWindowMs,
          turnsStarted: targets2.length,
          turnP95: this.turnP95(n, 'burst'),
          cpuPsiSomeAvg60: metrics.cpuPsiSomeAvg60,
          memAvailablePct: metrics.memAvailablePct,
          oomKills: metrics.oomKills,
          resumeP95Ms: metrics.resumeP95Ms,
          pass: verdict.cpuPass && verdict.ramPass,
        })
      }
    }

    return this.buildReport(rows, burstRows, computeKnees(rows, baseline, this.opts.bounds))
  }

  private buildReport(rows: StepRow[], burst: BurstRow[], knees: ReturnType<typeof computeKnees>): ReportInput {
    const vcpus = this.opts.vcpus ?? Number(this.originalEnv?.METAL_VCPUS ?? 2)
    const memMiB = this.opts.memMiB ?? Number(this.originalEnv?.METAL_MEM_MIB ?? 1024)
    const last = this.samples[this.samples.length - 1]
    const rssPerVmMiB = perVmRssMiBFrom(rows)
    const env: RunEnv = {
      hostId: this.opts.host,
      hostModel: this.hostInfo.model,
      kernel: this.hostInfo.kernel,
      firecrackerVersion: this.hostInfo.fcVersion,
      gitSha: this.hostInfo.gitSha,
      region: this.originalEnv?.METAL_REGION ?? '',
      controlPlaneUrl: this.originalEnv?.METAL_CONTROL_PLANE_URL ?? '',
      vcpus,
      memMiB,
      hostMemMiB: this.hostInfo.memMiB,
      hostThreads: this.hostInfo.threads,
      maxVmsPerHost: Number(this.originalEnv?.METAL_MAX_VMS_PER_HOST ?? 80),
      idleSuspendMs: Number(this.originalEnv?.METAL_IDLE_SUSPEND_MS ?? 0),
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      abortReason: this.abortReason,
    }
    const baseline = {} as Record<TurnStep, number>
    for (const s of TURN_STEPS) baseline[s] = rows.length > 0 ? rows[0].turnP50[s] : 0
    return {
      env,
      baseline,
      steps: rows,
      burst,
      knees,
      recommendation: {
        maxVmsPerHost: knees.recommended,
        cpuKnee: knees.cpuKnee,
        ramKnee: knees.ramKnee,
        bySize: rssPerVmMiB > 0 ? ramCeilingsBySize({ hostMemMiB: this.hostInfo.memMiB, perVmRssMiB: rssPerVmMiB, reservePct: this.opts.bounds.memAvailablePct }) : [],
        perVmRssMiB: rssPerVmMiB,
      },
      mix: this.opts.mix,
      notes: [
        `Resident before the run: ${this.residentBefore.length} real project(s), never touched.`,
        `Samples: ${this.samples.length} at ${this.opts.sampleMs}ms.`,
        last?.mem ? `Final MemAvailable ${last.mem.availableMiB} MiB of ${last.mem.totalMiB} MiB.` : '',
      ].filter(Boolean),
    }
  }

  // -- teardown -------------------------------------------------------------

  /** Destroy every soak VM, restore the env, restart the agent, uncordon. */
  async teardown(): Promise<void> {
    this.stopSampling()
    this.stopKeepAlive()
    this.stopAppRoles()

    const ids = [...this.vms.map((v) => v.projectId), ...this.probeIds]
    log('teardown', `destroying ${ids.length} soak VM(s)`)
    // Destroy only, in parallel. Suspending first uploads a snapshot per guest
    // (~90 s each, 160 guests = hours) and buys nothing: the VM is thrown away
    // either way.
    let next = 0
    const worker = async () => {
      while (next < ids.length) {
        const pid = ids[next++]
        await this.agent.destroy(pid).catch(() => {})
      }
    }
    await Promise.all(Array.from({ length: Math.min(TEARDOWN_CONCURRENCY, ids.length) }, worker))

    // Verify nothing of ours is left.
    const vms = await this.agent.vms()
    const left = [...(vms.json?.assigned ?? []), ...(vms.json?.suspended ?? [])]
      .map((v: any) => v.projectId)
      .filter((p: string) => typeof p === 'string' && p.startsWith(`soak-${this.runId}-`))
    if (left.length > 0) log('teardown', `WARNING: ${left.length} soak VM(s) still present: ${left.slice(0, 5).join(', ')}`)
    else log('teardown', '0 soak VMs left')

    if (this.originalEnvText !== null) {
      writeFileSync(this.opts.envFile, this.originalEnvText)
      log('teardown', 'env restored')
      if (this.opts.restartAgent && this.agentRestarted) await this.restartAgent().catch((err) => log('teardown', `agent restart failed: ${err?.message ?? err}`))
    }
    if (this.cordoned) await this.cordon(false).catch((err) => log('teardown', `uncordon failed: ${err?.message ?? err}`))
  }

  writeOutput(input: ReportInput): string {
    const { dir } = writeReport(this.opts.outDir, input, this.samples, this.turns)
    log('report', `wrote ${dir}`)
    return dir
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.fromResults) {
    const { report, path } = recomputeReport(opts.fromResults, opts.bounds)
    console.log(`\n===== DENSITY SOAK (recomputed) =====`)
    console.log(`CPU knee ${report.knees.cpuKnee} · RAM knee ${report.knees.ramKnee} · recommend METAL_MAX_VMS_PER_HOST=${report.recommendation.maxVmsPerHost}`)
    console.log(`report: ${path}`)
    return
  }
  const soak = new DensitySoak(opts)
  let report: ReportInput | null = null
  let failed: unknown = null

  const onSignal = async (sig: string) => {
    log('signal', `${sig} — tearing down`)
    try {
      await soak.teardown()
    } finally {
      process.exit(130)
    }
  }
  process.on('SIGINT', () => void onSignal('SIGINT'))
  process.on('SIGTERM', () => void onSignal('SIGTERM'))

  try {
    report = await soak.run()
  } catch (err) {
    failed = err
    log('error', String((err as any)?.message ?? err))
  } finally {
    try {
      await soak.teardown()
    } catch (err) {
      log('teardown', `failed: ${String((err as any)?.message ?? err)}`)
    }
  }

  if (report) {
    const dir = soak.writeOutput(report)
    console.log(`\n===== DENSITY SOAK =====`)
    console.log(`CPU knee ${report.knees.cpuKnee} · RAM knee ${report.knees.ramKnee} · recommend METAL_MAX_VMS_PER_HOST=${report.recommendation.maxVmsPerHost}`)
    console.log(`report: ${join(dir, 'report.md')}`)
  }
  if (failed) process.exit(1)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('[density] fatal:', err)
    process.exit(1)
  })
}
