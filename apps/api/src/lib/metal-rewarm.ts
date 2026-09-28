// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Rollout re-warm for the metal fleet.
 *
 * A release that rebuilds the runtime rootfs makes every suspended snapshot
 * stale (the host evicts local copies, the durable store rejects old ones), so
 * each project's next open cold-boots — about a minute. This job boots every
 * workspace runtime active in the last N hours on the new rootfs and suspends
 * it again, so those opens resume from a fresh snapshot instead.
 *
 * Runtimes are the two workspace forms: `ws:proj:<projectId>` (the anchored
 * runtime opening a project boots) and `ws:<workspaceId>` (a workspace chat
 * session). Boots go through the same resolvers a user open does, marked
 * `background` so they don't count as opens.
 *
 * Started automatically by `startMetalRewarmWatcher` once every live host in a
 * region reports the same new `rootfsSha`, or manually by a super-admin
 * (`/api/admin/metal/rewarm`). One job runs fleet-wide at a time (Redis lease).
 */

import { metrics } from '@opentelemetry/api'
import type { Redis } from 'ioredis'
import type { RuntimeHostStatus, StopResult } from './metal-warm-pool-controller'
import { getSharedRedis } from './tunnel-redis'

export type RewarmOutcome =
  | 'warmed'
  | 'warmed-api-not-ready'
  | 'already-warm'
  | 'in-use'
  | 'user-opened'
  | 'busy'
  | 'unknown-rootfs'
  | 'other-region'
  | 'recycle-aborted'
  | 'boot-failed'
  | 'suspend-failed'
  | 'skipped-bytes'
  | 'cancelled'

export interface RewarmCandidate {
  key: string
  kind: 'project' | 'workspace'
  workspaceId: string
  projectId?: string
  /** Workspace keys boot with this (most recent) session's attachments. */
  sessionId?: string
  lastActiveAt: number
}

export interface RewarmHost {
  hostId: string
  region: string
  rootfsSha?: string
  utilPct: number
  overWatermark: boolean
}

export interface RewarmItem {
  key: string
  outcome: RewarmOutcome
  hostId?: string
  detail?: string
  ms: number
  memBytes?: number
}

export type RewarmState = 'running' | 'paused' | 'done' | 'cancelled' | 'failed' | 'interrupted'

export interface RewarmStatus {
  jobId: string
  reason: string
  region: string | null
  state: RewarmState
  startedAt: number
  finishedAt?: number
  sinceHours: number
  concurrency: number
  total: number
  done: number
  counts: Partial<Record<RewarmOutcome, number>>
  bytesMem: number
  recent: RewarmItem[]
  /** Controller hit rates at start/end (this replica's cumulative view). */
  statsBefore?: Record<string, unknown>
  statsAfter?: Record<string, unknown>
  error?: string
}

export type RewarmControl = 'cancel' | 'pause' | null

/** Shared job state. Redis-backed in production, in-memory in tests/local. */
export interface RewarmStore {
  getStatus(): Promise<RewarmStatus | null>
  setStatus(s: RewarmStatus): Promise<void>
  getControl(): Promise<RewarmControl>
  setControl(c: RewarmControl): Promise<void>
  /** SET-NX lease; fails closed when the store is unreachable. */
  acquireLease(name: string, holder: string, ttlMs: number): Promise<boolean>
  releaseLease(name: string, holder: string): Promise<void>
  leaseHolder(name: string): Promise<string | null>
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlS?: number): Promise<void>
}

export interface RewarmDeps {
  listCandidates(sinceMs: number, maxRuntimes: number): Promise<RewarmCandidate[]>
  listHosts(): Promise<RewarmHost[]>
  /** Host-side state of a key; null when it isn't placed on any known host. */
  runtimeStatus(key: string): Promise<RuntimeHostStatus | null>
  recycle(key: string, reason: string): Promise<{ ok: boolean; error?: string }>
  /** Boot (or resume) through the user-open path; throws while still booting. */
  boot(c: RewarmCandidate): Promise<{ url: string }>
  /** Project keys: API server ready. Workspace keys: runtime answering. */
  ready(c: RewarmCandidate, url: string): Promise<boolean>
  stop(key: string): Promise<StopResult>
  controllerStats(): Promise<Record<string, unknown> | undefined>
  store: RewarmStore
  sleep(ms: number): Promise<void>
  now(): number
  log(msg: string): void
  metric(outcome: RewarmOutcome): void
}

export interface RewarmOptions {
  reason: string
  /** Only warm keys placed in this region (unplaced keys are always taken). */
  region?: string | null
  sinceHours: number
  concurrencyPerHost: number
  maxRuntimes: number
  /** Stop starting boots once this many snapshot bytes were written. 0 = off. */
  maxBytes?: number
  jobId?: string
}

const MAX_CONCURRENCY = 12
const IN_USE_IDLE_MS = 10 * 60_000
const BOOT_DEADLINE_MS = 180_000
const POLL_MS = 3_000
const SUSPEND_SETTLE_MS = 120_000
const CAPACITY_POLL_MS = 15_000
const PAUSE_POLL_MS = 10_000
const RECENT_ITEMS = 50

export const REWARM_JOB_LEASE = 'job'
const WATCHER_LEASE = 'watcher'
const OPENED_TTL_S = 6 * 60 * 60

function envInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] || '', 10)
  return Number.isFinite(n) ? n : fallback
}

export function rewarmConfig() {
  return {
    auto: process.env.METAL_REWARM_AUTO !== 'false',
    sinceHours: envInt('METAL_REWARM_SINCE_HOURS', 48),
    concurrencyPerHost: envInt('METAL_REWARM_CONCURRENCY_PER_HOST', 2),
    maxRuntimes: envInt('METAL_REWARM_MAX_RUNTIMES', 1000),
    maxBytes: envInt('METAL_REWARM_MAX_BYTES', 0),
    minIntervalMs: envInt('METAL_REWARM_MIN_INTERVAL_MS', 2 * 60 * 60_000),
    settleMs: envInt('METAL_REWARM_SETTLE_MS', 2 * 60_000),
    maxHostUtilPct: envInt('METAL_REWARM_MAX_HOST_UTIL_PCT', 75),
  }
}

// --- job -------------------------------------------------------------------

/**
 * Warm `candidates` (already listed) and return the final status. The caller
 * holds the job lease. Never throws for a single key; per-key failures are
 * outcomes.
 */
export async function runRewarm(
  opts: RewarmOptions,
  deps: RewarmDeps,
  candidates: RewarmCandidate[],
  cfg: { maxHostUtilPct: number } = rewarmConfig(),
): Promise<RewarmStatus> {
  const region = opts.region ?? null
  const regionHosts = (await deps.listHosts()).filter((h) => !region || h.region === region)
  const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, opts.concurrencyPerHost * Math.max(1, regionHosts.length)))
  const status: RewarmStatus = {
    jobId: opts.jobId ?? `rewarm-${deps.now().toString(36)}`,
    reason: opts.reason,
    region,
    state: 'running',
    startedAt: deps.now(),
    sinceHours: opts.sinceHours,
    concurrency,
    total: candidates.length,
    done: 0,
    counts: {},
    bytesMem: 0,
    recent: [],
    statsBefore: await deps.controllerStats().catch(() => undefined),
  }
  await deps.store.setStatus(status)
  deps.log(`[MetalRewarm] job ${status.jobId} started: ${candidates.length} runtime(s), concurrency ${concurrency}, reason: ${opts.reason}`)

  const queue = [...candidates]
  let cancelled = false

  const record = async (item: RewarmItem) => {
    status.done++
    status.counts[item.outcome] = (status.counts[item.outcome] ?? 0) + 1
    if (item.memBytes) status.bytesMem += item.memBytes
    status.recent = [item, ...status.recent].slice(0, RECENT_ITEMS)
    deps.metric(item.outcome)
    await deps.store.setStatus(status).catch(() => {})
  }

  /** Blocks while paused. Returns false once cancelled. */
  const proceed = async (): Promise<boolean> => {
    while (true) {
      const control = await deps.store.getControl().catch(() => null)
      if (control === 'cancel') {
        cancelled = true
        return false
      }
      if (control !== 'pause') {
        if (status.state === 'paused') {
          status.state = 'running'
          await deps.store.setStatus(status).catch(() => {})
        }
        return true
      }
      if (status.state !== 'paused') {
        status.state = 'paused'
        await deps.store.setStatus(status).catch(() => {})
      }
      await deps.sleep(PAUSE_POLL_MS)
    }
  }

  /** Waits until some host in the region has room. Returns false once cancelled. */
  const capacity = async (): Promise<boolean> => {
    while (true) {
      const hosts = (await deps.listHosts().catch(() => [] as RewarmHost[])).filter((h) => !region || h.region === region)
      if (hosts.length === 0 || hosts.some((h) => !h.overWatermark && h.utilPct < cfg.maxHostUtilPct)) return true
      if (!(await proceed())) return false
      await deps.sleep(CAPACITY_POLL_MS)
    }
  }

  const warmOne = async (c: RewarmCandidate): Promise<Omit<RewarmItem, 'key' | 'ms'>> => {
    const st = await deps.runtimeStatus(c.key)
    if (region && st && st.region !== region) return { outcome: 'other-region', hostId: st.hostId }
    if (st?.state === 'assigned') {
      if (st.rootfsFresh === undefined) return { outcome: 'unknown-rootfs', hostId: st.hostId }
      if (st.rootfsFresh) return { outcome: 'already-warm', hostId: st.hostId }
      if ((st.activeStreams ?? 0) > 0 || (st.realIdleMs ?? 0) < IN_USE_IDLE_MS) {
        return { outcome: 'in-use', hostId: st.hostId }
      }
      const r = await deps.recycle(c.key, opts.reason)
      if (!r.ok) return { outcome: 'recycle-aborted', hostId: st.hostId, detail: r.error }
    } else if (st?.state === 'suspended' && st.rootfsFresh) {
      return { outcome: 'already-warm', hostId: st.hostId }
    }

    if (!(await capacity())) return { outcome: 'cancelled' }

    const bootStart = deps.now()
    let url: string | undefined
    let bootError = ''
    while (url === undefined && deps.now() - bootStart < BOOT_DEADLINE_MS) {
      try {
        url = (await deps.boot(c)).url
      } catch (err: any) {
        bootError = err?.message ?? String(err)
        await deps.sleep(POLL_MS)
      }
    }
    if (url === undefined) return { outcome: 'boot-failed', detail: bootError.slice(0, 300) }

    let ready = false
    while (!ready && deps.now() - bootStart < BOOT_DEADLINE_MS) {
      ready = await deps.ready(c, url).catch(() => false)
      if (!ready) await deps.sleep(POLL_MS)
    }

    // Someone opened it while we were booting: leave it running for them.
    const opened = Number((await deps.store.get(`opened:${c.key}`).catch(() => null)) ?? 0)
    if (opened >= bootStart) return { outcome: 'user-opened' }
    const after = await deps.runtimeStatus(c.key)
    if (after?.state === 'assigned') {
      const active = (after.activeStreams ?? 0) > 0
      const usedSinceBoot =
        after.lastRealActivityAt !== undefined &&
        after.assignedAt !== undefined &&
        after.lastRealActivityAt > after.assignedAt
      if (active || usedSinceBoot) return { outcome: 'user-opened', hostId: after.hostId }
    }

    const stopped = await deps.stop(c.key)
    if (stopped.busy) return { outcome: 'busy', hostId: after?.hostId }
    if (!stopped.suspended) {
      // The host keeps suspending after the control plane stops waiting.
      const stopWaitStart = deps.now()
      let settled = await deps.runtimeStatus(c.key).catch(() => null)
      while (settled?.state === 'assigned' && deps.now() - stopWaitStart < SUSPEND_SETTLE_MS) {
        await deps.sleep(POLL_MS)
        settled = await deps.runtimeStatus(c.key).catch(() => null)
      }
      if (settled?.state !== 'suspended' || settled.rootfsFresh !== true) {
        return { outcome: 'suspend-failed', hostId: after?.hostId }
      }
    }
    return {
      outcome: ready ? 'warmed' : 'warmed-api-not-ready',
      hostId: after?.hostId,
      memBytes: stopped.memBytes,
    }
  }

  const worker = async () => {
    while (queue.length > 0) {
      if (!(await proceed())) return
      const c = queue.shift()
      if (!c) return
      const started = deps.now()
      if (opts.maxBytes && opts.maxBytes > 0 && status.bytesMem >= opts.maxBytes) {
        await record({ key: c.key, outcome: 'skipped-bytes', ms: 0 })
        continue
      }
      let item: Omit<RewarmItem, 'key' | 'ms'>
      try {
        item = await warmOne(c)
      } catch (err: any) {
        item = { outcome: 'boot-failed', detail: (err?.message ?? String(err)).slice(0, 300) }
      }
      await record({ key: c.key, ms: deps.now() - started, ...item })
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, worker))
    if (cancelled && queue.length > 0) {
      status.counts.cancelled = (status.counts.cancelled ?? 0) + queue.length
      status.done += queue.length
      queue.length = 0
    }
    status.state = cancelled ? 'cancelled' : 'done'
  } catch (err: any) {
    status.state = 'failed'
    status.error = err?.message ?? String(err)
  }
  status.finishedAt = deps.now()
  status.statsAfter = await deps.controllerStats().catch(() => undefined)
  await deps.store.setStatus(status).catch(() => {})
  deps.log(`[MetalRewarm] ${JSON.stringify({ event: 'metal.rewarm.finished', ...summary(status) })}`)
  return status
}

function summary(s: RewarmStatus) {
  return {
    jobId: s.jobId,
    reason: s.reason,
    region: s.region,
    state: s.state,
    total: s.total,
    counts: s.counts,
    bytesMem: s.bytesMem,
    durationMs: (s.finishedAt ?? Date.now()) - s.startedAt,
    statsBefore: s.statsBefore,
    statsAfter: s.statsAfter,
  }
}

export interface StartRewarmInput {
  reason: string
  region?: string | null
  sinceHours?: number
  concurrencyPerHost?: number
  maxRuntimes?: number
  maxBytes?: number
  dryRun?: boolean
  /** Manual runs: written to the `[admin-audit]` start/finish lines. */
  actor?: { id: string; email?: string }
}

/** Validate a `POST /api/admin/metal/rewarm` body. */
export function parseRewarmRequest(
  body: unknown,
  actor: { id: string; email?: string },
): { ok: true; input: StartRewarmInput } | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const num = (k: string, min: number, max: number): number | undefined | null => {
    if (b[k] === undefined || b[k] === null) return undefined
    const n = Number(b[k])
    return Number.isFinite(n) && n >= min && n <= max ? n : null
  }
  const sinceHours = num('sinceHours', 1, 24 * 14)
  const concurrencyPerHost = num('concurrency', 1, MAX_CONCURRENCY)
  const maxRuntimes = num('maxRuntimes', 1, 10_000)
  const maxBytes = num('maxBytes', 0, Number.MAX_SAFE_INTEGER)
  if (sinceHours === null) return { ok: false, error: 'sinceHours must be between 1 and 336' }
  if (concurrencyPerHost === null) return { ok: false, error: `concurrency must be between 1 and ${MAX_CONCURRENCY}` }
  if (maxRuntimes === null) return { ok: false, error: 'maxRuntimes must be between 1 and 10000' }
  if (maxBytes === null) return { ok: false, error: 'maxBytes must be a non-negative number' }
  if (b.region !== undefined && b.region !== null && typeof b.region !== 'string') {
    return { ok: false, error: 'region must be a string' }
  }
  const who = actor.email ?? actor.id
  return {
    ok: true,
    input: {
      reason: typeof b.reason === 'string' && b.reason.trim() ? b.reason.slice(0, 300) : `manual re-warm by ${who}`,
      region: (b.region as string | undefined) || null,
      sinceHours,
      concurrencyPerHost,
      maxRuntimes,
      maxBytes,
      dryRun: b.dryRun === true,
      actor,
    },
  }
}

export interface StartRewarmResult {
  started: boolean
  jobId?: string
  total: number
  dryRun?: boolean
  candidates?: RewarmCandidate[]
  /** Why it didn't start. */
  error?: 'already-running'
}

/**
 * List candidates and, unless `dryRun`, start a job in the background. Returns
 * immediately with the candidate count; progress is read with
 * `getRewarmStatus`.
 */
export async function startRewarmJob(input: StartRewarmInput, deps?: RewarmDeps): Promise<StartRewarmResult> {
  const d = deps ?? (await defaultRewarmDeps())
  const cfg = rewarmConfig()
  const sinceHours = input.sinceHours ?? cfg.sinceHours
  const maxRuntimes = input.maxRuntimes ?? cfg.maxRuntimes
  const candidates = await d.listCandidates(d.now() - sinceHours * 60 * 60_000, maxRuntimes)
  if (input.dryRun) return { started: false, dryRun: true, total: candidates.length, candidates }

  const jobId = `rewarm-${d.now().toString(36)}`
  const holder = `${process.env.HOSTNAME || 'api'}:${jobId}`
  const leaseMs = 5 * 60_000
  if (!(await d.store.acquireLease(REWARM_JOB_LEASE, holder, leaseMs))) {
    return { started: false, total: candidates.length, error: 'already-running' }
  }
  await d.store.setControl(null)
  const renew = setInterval(() => {
    void d.store.acquireLease(REWARM_JOB_LEASE, holder, leaseMs).catch(() => {})
  }, 60_000)
  ;(renew as any).unref?.()

  const opts: RewarmOptions = {
    reason: input.reason,
    region: input.region ?? null,
    sinceHours,
    concurrencyPerHost: input.concurrencyPerHost ?? cfg.concurrencyPerHost,
    maxRuntimes,
    maxBytes: input.maxBytes ?? cfg.maxBytes,
    jobId,
  }
  const audit = (event: string, extra: Record<string, unknown>) => {
    if (!input.actor) return
    d.log(`[admin-audit] ${JSON.stringify({ event, actorId: input.actor.id, actorEmail: input.actor.email, ...extra })}`)
  }
  audit('admin.metal.rewarm.started', { jobId, reason: opts.reason, region: opts.region, sinceHours, total: candidates.length })
  void runRewarm(opts, d, candidates, cfg)
    .then((status) => audit('admin.metal.rewarm.finished', summary(status)))
    .catch((err) => d.log(`[MetalRewarm] job ${jobId} crashed: ${err?.message ?? err}`))
    .finally(() => {
      clearInterval(renew)
      void d.store.releaseLease(REWARM_JOB_LEASE, holder).catch(() => {})
    })
  return { started: true, jobId, total: candidates.length }
}

/** Latest job status; a running job whose lease lapsed is reported interrupted. */
export async function getRewarmStatus(store?: RewarmStore): Promise<(RewarmStatus & { control: RewarmControl }) | null> {
  const s = store ?? getRewarmStore()
  const status = await s.getStatus()
  if (!status) return null
  const control = await s.getControl()
  if ((status.state === 'running' || status.state === 'paused') && !(await s.leaseHolder(REWARM_JOB_LEASE))) {
    return { ...status, state: 'interrupted', control }
  }
  return { ...status, control }
}

/** Cancel, pause or resume the running job (any replica). */
export async function setRewarmControl(control: RewarmControl, store?: RewarmStore): Promise<void> {
  await (store ?? getRewarmStore()).setControl(control)
}

// --- "opened" marker ---------------------------------------------------------

const lastMarked = new Map<string, number>()

/**
 * Record that a user/integration resolved this runtime. The job leaves a
 * runtime running if it was opened during its warm boot. Throttled per key.
 */
export async function markRuntimeOpened(key: string, store?: RewarmStore, now = Date.now()): Promise<void> {
  const prev = lastMarked.get(key) ?? 0
  if (now - prev < 10_000) return
  lastMarked.set(key, now)
  if (lastMarked.size > 10_000) lastMarked.clear()
  await (store ?? getRewarmStore()).set(`opened:${key}`, String(now), OPENED_TTL_S)
}

// --- automatic trigger -----------------------------------------------------

export interface WatcherTickResult {
  region: string
  action: 'recorded' | 'started' | 'unchanged' | 'mixed' | 'settling' | 'min-interval' | 'busy'
  rootfsSha?: string
}

/**
 * One watcher pass. For each region whose live hosts all report the same
 * `rootfsSha`, start a job the first time that sha is seen after a previous
 * one. The very first observation only records it, so deploying the watcher
 * doesn't warm the whole fleet.
 */
export async function rewarmWatcherTick(
  deps: RewarmDeps,
  cfg: ReturnType<typeof rewarmConfig> = rewarmConfig(),
  start: (input: StartRewarmInput) => Promise<StartRewarmResult> = (input) => startRewarmJob(input, deps),
): Promise<WatcherTickResult[]> {
  const hosts = await deps.listHosts()
  const byRegion = new Map<string, RewarmHost[]>()
  for (const h of hosts) byRegion.set(h.region, [...(byRegion.get(h.region) ?? []), h])

  const out: WatcherTickResult[] = []
  for (const [region, list] of byRegion) {
    const shas = new Set(list.map((h) => h.rootfsSha ?? ''))
    const sha = list[0]?.rootfsSha
    if (shas.size !== 1 || !sha) {
      out.push({ region, action: 'mixed' })
      continue
    }
    const last = await deps.store.get(`lastRootfs:${region}`)
    if (!last) {
      await deps.store.set(`lastRootfs:${region}`, sha)
      deps.log(`[MetalRewarm] region ${region}: recorded rootfs ${sha.slice(0, 12)} (first observation, no warm)`)
      out.push({ region, action: 'recorded', rootfsSha: sha })
      continue
    }
    if (last === sha) {
      out.push({ region, action: 'unchanged', rootfsSha: sha })
      continue
    }
    // A host stamps ROOTFS_SHA just before its agent restarts onto the new
    // image; wait until the region has reported it steadily for a while.
    const [pendingSha, pendingAt] = ((await deps.store.get(`pending:${region}`)) ?? '').split('|')
    if (pendingSha !== sha) {
      await deps.store.set(`pending:${region}`, `${sha}|${deps.now()}`, 24 * 60 * 60)
      out.push({ region, action: 'settling', rootfsSha: sha })
      continue
    }
    if (deps.now() - Number(pendingAt) < cfg.settleMs) {
      out.push({ region, action: 'settling', rootfsSha: sha })
      continue
    }
    const lastJobAt = Number((await deps.store.get(`lastJobAt:${region}`)) ?? 0)
    if (deps.now() - lastJobAt < cfg.minIntervalMs) {
      out.push({ region, action: 'min-interval', rootfsSha: sha })
      continue
    }
    const res = await start({ reason: `rootfs ${sha.slice(0, 12)} rollout in ${region}`, region })
    if (!res.started) {
      // Another job holds the lease; the sha stays unrecorded so we retry.
      out.push({ region, action: 'busy', rootfsSha: sha })
      continue
    }
    await deps.store.set(`lastRootfs:${region}`, sha)
    await deps.store.set(`lastJobAt:${region}`, String(deps.now()))
    deps.log(`[MetalRewarm] region ${region}: rootfs ${last.slice(0, 12)} -> ${sha.slice(0, 12)}, started ${res.jobId} (${res.total} runtimes)`)
    out.push({ region, action: 'started', rootfsSha: sha })
  }
  return out
}

let watcherTimer: ReturnType<typeof setInterval> | null = null

/** Leader-elected 60s watcher. No-op unless metal is enabled; METAL_REWARM_AUTO=false disables. */
export function startMetalRewarmWatcher(intervalMs = 60_000): void {
  if (watcherTimer) return
  const holder = `${process.env.HOSTNAME || 'api'}:${Math.random().toString(36).slice(2)}`
  const tick = async () => {
    const cfg = rewarmConfig()
    if (!cfg.auto) return
    try {
      const deps = await defaultRewarmDeps()
      if (!(await deps.store.acquireLease(WATCHER_LEASE, holder, intervalMs * 2))) return
      await rewarmWatcherTick(deps, cfg)
    } catch (err: any) {
      console.warn(`[MetalRewarm] watcher tick failed: ${err?.message ?? err}`)
    }
  }
  watcherTimer = setInterval(() => void tick(), intervalMs)
  ;(watcherTimer as any).unref?.()
  console.log(`[MetalRewarm] watcher started (every ${Math.round(intervalMs / 1000)}s, auto=${rewarmConfig().auto})`)
}

// --- store -----------------------------------------------------------------

const KEY = 'metal:rewarm:'

export class MemoryRewarmStore implements RewarmStore {
  private status: RewarmStatus | null = null
  private control: RewarmControl = null
  private leases = new Map<string, { holder: string; expiresAt: number }>()
  private kv = new Map<string, { value: string; expiresAt?: number }>()

  async getStatus() {
    return this.status ? structuredClone(this.status) : null
  }
  async setStatus(s: RewarmStatus) {
    this.status = structuredClone(s)
  }
  async getControl() {
    return this.control
  }
  async setControl(c: RewarmControl) {
    this.control = c
  }
  async acquireLease(name: string, holder: string, ttlMs: number) {
    const cur = this.leases.get(name)
    if (cur && cur.expiresAt > Date.now() && cur.holder !== holder) return false
    this.leases.set(name, { holder, expiresAt: Date.now() + ttlMs })
    return true
  }
  async releaseLease(name: string, holder: string) {
    if (this.leases.get(name)?.holder === holder) this.leases.delete(name)
  }
  async leaseHolder(name: string) {
    const cur = this.leases.get(name)
    return cur && cur.expiresAt > Date.now() ? cur.holder : null
  }
  async get(key: string) {
    const e = this.kv.get(key)
    if (!e) return null
    if (e.expiresAt !== undefined && e.expiresAt <= Date.now()) {
      this.kv.delete(key)
      return null
    }
    return e.value
  }
  async set(key: string, value: string, ttlS?: number) {
    this.kv.set(key, { value, expiresAt: ttlS ? Date.now() + ttlS * 1000 : undefined })
  }
}

const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`

/** Redis-backed store; degrades to in-process state when Redis is absent. */
export class RedisRewarmStore implements RewarmStore {
  private mem = new MemoryRewarmStore()

  constructor(private redisGetter: () => Redis | null) {}

  private redis(): Redis | null {
    try {
      return this.redisGetter()
    } catch {
      return null
    }
  }

  async getStatus() {
    const r = this.redis()
    if (!r) return this.mem.getStatus()
    const v = await r.get(`${KEY}status`).catch(() => null)
    try {
      return v ? (JSON.parse(v) as RewarmStatus) : null
    } catch {
      return null
    }
  }
  async setStatus(s: RewarmStatus) {
    const r = this.redis()
    if (!r) return this.mem.setStatus(s)
    await r.set(`${KEY}status`, JSON.stringify(s), 'EX', 7 * 24 * 60 * 60)
  }
  async getControl(): Promise<RewarmControl> {
    const r = this.redis()
    if (!r) return this.mem.getControl()
    const v = await r.get(`${KEY}control`)
    return v === 'cancel' || v === 'pause' ? v : null
  }
  async setControl(c: RewarmControl) {
    const r = this.redis()
    if (!r) return this.mem.setControl(c)
    if (c) await r.set(`${KEY}control`, c, 'EX', 24 * 60 * 60)
    else await r.del(`${KEY}control`)
  }
  async acquireLease(name: string, holder: string, ttlMs: number) {
    const r = this.redis()
    if (!r) return this.mem.acquireLease(name, holder, ttlMs)
    try {
      const key = `${KEY}lease:${name}`
      if ((await r.set(key, holder, 'PX', ttlMs, 'NX')) === 'OK') return true
      if ((await r.get(key)) === holder) {
        await r.pexpire(key, ttlMs)
        return true
      }
      return false
    } catch {
      return false
    }
  }
  async releaseLease(name: string, holder: string) {
    const r = this.redis()
    if (!r) return this.mem.releaseLease(name, holder)
    await r.eval(RELEASE_LUA, 1, `${KEY}lease:${name}`, holder).catch(() => {})
  }
  async leaseHolder(name: string) {
    const r = this.redis()
    if (!r) return this.mem.leaseHolder(name)
    return r.get(`${KEY}lease:${name}`).catch(() => null)
  }
  async get(key: string) {
    const r = this.redis()
    if (!r) return this.mem.get(key)
    return r.get(`${KEY}${key}`).catch(() => null)
  }
  async set(key: string, value: string, ttlS?: number) {
    const r = this.redis()
    if (!r) return this.mem.set(key, value, ttlS)
    if (ttlS) await r.set(`${KEY}${key}`, value, 'EX', ttlS)
    else await r.set(`${KEY}${key}`, value)
  }
}

let store: RewarmStore | null = null

export function getRewarmStore(): RewarmStore {
  if (!store) store = new RedisRewarmStore(getSharedRedis)
  return store
}

/** Test-only: replace the store singleton. */
export function _setRewarmStore(s: RewarmStore | null): void {
  store = s
}

// --- default wiring ----------------------------------------------------------

const meter = metrics.getMeter('shogo-metal-rewarm')
const outcomeCounter = meter.createCounter('metal.rewarm', {
  description: 'Rollout re-warm outcomes per runtime',
})

/** Candidates from the database: runtimes with chat activity since `sinceMs`. */
export async function listRewarmCandidatesFromDb(sinceMs: number, maxRuntimes: number): Promise<RewarmCandidate[]> {
  const { prisma } = await import('./prisma')
  const { isMetalEligibleProject } = await import('./metal-eligibility')
  const since = new Date(sinceMs)

  const [byMessage, projectSessions, workspaceSessions] = await Promise.all([
    prisma.project.findMany({
      where: { lastMessageAt: { gte: since } },
      select: { id: true, lastMessageAt: true },
    }),
    prisma.chatSession.findMany({
      where: { lastActiveAt: { gte: since }, contextId: { not: null }, contextType: { in: ['project', 'workspace'] } },
      select: { contextId: true, lastActiveAt: true },
    }),
    prisma.chatSession.findMany({
      where: { lastActiveAt: { gte: since }, contextType: 'workspace', contextId: null, workspaceId: { not: null } },
      select: { id: true, workspaceId: true, lastActiveAt: true },
      orderBy: { lastActiveAt: 'desc' },
    }),
  ])

  const projectActivity = new Map<string, number>()
  const bump = (id: string | null | undefined, at: Date | null | undefined) => {
    if (!id || !at) return
    projectActivity.set(id, Math.max(projectActivity.get(id) ?? 0, at.getTime()))
  }
  for (const p of byMessage) bump(p.id, p.lastMessageAt)
  for (const s of projectSessions) bump(s.contextId, s.lastActiveAt)

  const out: RewarmCandidate[] = []
  const ids = [...projectActivity.keys()]
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await prisma.project.findMany({
      where: { id: { in: ids.slice(i, i + 500) }, runtimeEnabled: true, workingMode: 'managed' },
      select: { id: true, workspaceId: true },
    })
    for (const p of rows) {
      if (!isMetalEligibleProject(p.id)) continue
      out.push({
        key: `ws:proj:${p.id}`,
        kind: 'project',
        projectId: p.id,
        workspaceId: p.workspaceId,
        lastActiveAt: projectActivity.get(p.id) ?? 0,
      })
    }
  }

  const seenWorkspaces = new Set<string>()
  for (const s of workspaceSessions) {
    if (!s.workspaceId || seenWorkspaces.has(s.workspaceId)) continue
    seenWorkspaces.add(s.workspaceId)
    out.push({
      key: `ws:${s.workspaceId}`,
      kind: 'workspace',
      workspaceId: s.workspaceId,
      sessionId: s.id,
      lastActiveAt: s.lastActiveAt.getTime(),
    })
  }

  return out.sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, Math.max(0, maxRuntimes))
}

/** The real controller, resolvers and Redis, wired for the job and watcher. */
export async function defaultRewarmDeps(): Promise<RewarmDeps> {
  const ctl = await import('./metal-warm-pool-controller')
  const controller = ctl.getMetalWarmPoolController()
  const { deriveWorkspaceRuntimeToken } = await import('./workspace-runtime-token')
  return {
    listCandidates: listRewarmCandidatesFromDb,
    listHosts: async () =>
      (await controller.getFleetStatus()).hosts.map((h) => ({
        hostId: h.hostId,
        region: h.region,
        rootfsSha: h.rootfsSha,
        utilPct: h.utilPct,
        overWatermark: h.overWatermark,
      })),
    runtimeStatus: (key) => controller.getRuntimeHostStatus(key),
    recycle: async (key, reason) => {
      const r = await controller.recycleRuntime(key, { reason: `rewarm: ${reason}` })
      return { ok: r.ok, error: r.error ?? r.report?.steps?.find((s) => !s.ok)?.detail }
    },
    boot: async (c) => {
      if (c.kind === 'project' && c.projectId) {
        const { resolveProjectPodUrl } = await import('./resolve-pod-url')
        return { url: (await resolveProjectPodUrl(c.projectId, { logTag: 'MetalRewarm', background: true })).url }
      }
      if (!c.sessionId) throw new Error(`workspace candidate ${c.key} has no session`)
      const { readWorkspaceSessionRuntimeArgs } = await import('./workspace-runtime-args')
      const { resolveWorkspaceRuntimeUrl } = await import('./resolve-workspace-runtime-url')
      const args = await readWorkspaceSessionRuntimeArgs(c.workspaceId, c.sessionId)
      const resolved = await resolveWorkspaceRuntimeUrl(c.workspaceId, {
        attachedProjectIds: args.attachedProjectIds,
        ...args.extra,
        logTag: 'MetalRewarm',
        background: true,
      })
      return { url: resolved.url }
    },
    ready: async (c, url) => {
      const base = url.replace(/\/+$/, '')
      if (c.kind === 'workspace') {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })
        return res.ok
      }
      const res = await fetch(`${base}/preview/status`, {
        headers: { 'x-runtime-token': deriveWorkspaceRuntimeToken(c.workspaceId) },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return false
      const body = (await res.json().catch(() => ({}))) as { apiReady?: boolean }
      return body.apiReady === true
    },
    stop: (key) => controller.stopProject(key),
    controllerStats: async () => {
      const s = controller.getStatus().stats
      return { snapshotHitRate: s.snapshotHitRate, warmHitRate: s.warmHitRate, coldMiss: s.coldMiss, resumed: s.resumed }
    },
    store: getRewarmStore(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (msg) => console.log(msg),
    metric: (outcome) => outcomeCounter.add(1, { outcome }),
  }
}
