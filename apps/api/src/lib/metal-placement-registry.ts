// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Shared placement registry for the metal substrate (Phase 5 / Phase 2 of the
 * NVMe-GC-cache plan).
 *
 * The API tier runs multiple replicas (k8s/base/api.yaml: replicas: 2). Each
 * previously kept host + placement state in per-process memory, so:
 *   - a node-agent heartbeat only updated the ONE replica it hit — sibling
 *     replicas didn't know the host existed (documented inconsistency);
 *   - `projectHost` stickiness was per-replica, so two replicas could resume
 *     the SAME project on two different hosts, both persisting `.git`/workspace
 *     to the same S3 keys (split brain).
 *
 * This module moves that state to the shared Redis this API tier already runs
 * (getSharedRedis, the same connection tunnel routing + pending-login use). It
 * provides:
 *   - host registry: every replica sees every live host + its disk/cache scalars;
 *   - placement map: projectId → {hostId, tier, lastAccessAt}, so routing prefers
 *     the host that actually holds the project's snapshot locally;
 *   - per-project lease: a short-TTL fencing token acquired before a resume, so
 *     exactly one host ever runs a project at once (anti split brain).
 *
 * When Redis is absent (SHOGO_LOCAL_MODE / init failure) it degrades to an
 * in-process implementation — correct for a single replica, matching the
 * fallback pattern in pending-login-store.ts. All methods are best-effort and
 * never throw into the request path.
 */

import type { Redis } from 'ioredis'
import { getSharedRedis } from './tunnel-redis'

export type PlacementTier = 'local' | 's3' | 'cold'

export interface HostScalars {
  hostId: string
  meshIp: string
  agentPort: number
  region: string
  arch: string
  capacity: { poolSize: number; memMiB: number; vcpus: number }
  load: { available: number; assigned: number; suspended: number; fcProcs?: number }
  /** NVMe cache scalars from the heartbeat (Phase 5). */
  disk?: { totalBytes: number; freeBytes: number; usedPct: number; cacheBytes: number; localCount: number }
  lastSeenAt: number
}

export interface Placement {
  hostId: string
  tier: PlacementTier
  lastAccessAt: number
}

/**
 * A burst host the fleet reconciler provisioned (hourly, above baseline). We
 * track these separately from baseline hosts so scale-down only ever destroys
 * reconciler-created capacity — never a monthly baseline host — and so it can
 * pick the NEWEST burst host to remove (shortest-lived = least sticky cache).
 */
export interface BurstHostRecord {
  hostId: string
  serverId: string
  region: string
  site: string
  createdAt: number
  /** Reconciler cordoned it and is waiting for it to drain before destroy. */
  drainingSince?: number
}

const HOST_TTL_MS = parseInt(process.env.METAL_HOST_TTL_MS || '90000', 10)
const PLACEMENT_TTL_S = parseInt(process.env.METAL_PLACEMENT_TTL_S || '86400', 10) // 24h
const LEASE_TTL_MS = parseInt(process.env.METAL_LEASE_TTL_MS || '60000', 10)

const HOST_KEY = 'metal:host:'
const HOST_SET = 'metal:hosts'
const PLACE_KEY = 'metal:place:'
const LEASE_KEY = 'metal:lease:'
const CORDON_SET = 'metal:cordoned'
const BURST_HASH = 'metal:burst' // hostId → BurstHostRecord JSON
const RECONCILE_LEASE_KEY = 'metal:reconcile:leader'
const SCALE_COOLDOWN_KEY = 'metal:burst:cooldown:' // + region → epoch ms of last scale action

// Compare-and-delete / compare-and-expire so only the lease holder can
// renew or release it (a stale holder must not free a re-acquired lease).
const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`
const RENEW_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`

/** Registry backed by shared Redis, with an in-process fallback. */
export class MetalPlacementRegistry {
  // In-process fallback state (used only when Redis is unavailable).
  private memHosts = new Map<string, HostScalars>()
  private memPlace = new Map<string, Placement>()
  private memLease = new Map<string, { holder: string; expiresAt: number }>()
  private memCordoned = new Set<string>()
  private memBurst = new Map<string, BurstHostRecord>()
  private memReconcileLease: { holder: string; expiresAt: number } | null = null
  private memCooldown = new Map<string, number>()

  constructor(private redisGetter: () => Redis | null = getSharedRedis) {}

  private redis(): Redis | null {
    try {
      return this.redisGetter()
    } catch {
      return null
    }
  }

  // --- host registry -------------------------------------------------------

  async upsertHost(h: HostScalars): Promise<void> {
    const r = this.redis()
    if (!r) {
      this.memHosts.set(h.hostId, h)
      return
    }
    try {
      const ttl = Math.ceil(HOST_TTL_MS / 1000)
      await r.set(`${HOST_KEY}${h.hostId}`, JSON.stringify(h), 'EX', ttl)
      await r.sadd(HOST_SET, h.hostId)
    } catch {
      this.memHosts.set(h.hostId, h)
    }
  }

  async listHosts(): Promise<HostScalars[]> {
    const r = this.redis()
    if (!r) {
      const cutoff = Date.now() - HOST_TTL_MS
      return [...this.memHosts.values()].filter((h) => h.lastSeenAt >= cutoff)
    }
    try {
      const ids = await r.smembers(HOST_SET)
      if (ids.length === 0) return []
      const raw = await r.mget(...ids.map((id) => `${HOST_KEY}${id}`))
      const hosts: HostScalars[] = []
      const dead: string[] = []
      raw.forEach((v, i) => {
        if (!v) {
          dead.push(ids[i]) // key expired → prune from the set
          return
        }
        try {
          hosts.push(JSON.parse(v) as HostScalars)
        } catch {
          /* skip corrupt */
        }
      })
      if (dead.length) await r.srem(HOST_SET, ...dead).catch(() => {})
      return hosts
    } catch {
      const cutoff = Date.now() - HOST_TTL_MS
      return [...this.memHosts.values()].filter((h) => h.lastSeenAt >= cutoff)
    }
  }

  // --- cordon (admin drain) ------------------------------------------------
  // A cordoned host keeps heartbeating and serving its live projects but is
  // removed from NEW-placement candidates, so it drains as projects idle →
  // suspend → resume elsewhere. Shared so every API replica honors it. No TTL:
  // a cordon persists until an admin uncordons (or the host set is cleaned up).

  async setCordon(hostId: string, cordoned: boolean): Promise<void> {
    const r = this.redis()
    if (!r) {
      cordoned ? this.memCordoned.add(hostId) : this.memCordoned.delete(hostId)
      return
    }
    try {
      cordoned ? await r.sadd(CORDON_SET, hostId) : await r.srem(CORDON_SET, hostId)
    } catch {
      cordoned ? this.memCordoned.add(hostId) : this.memCordoned.delete(hostId)
    }
  }

  async listCordoned(): Promise<string[]> {
    const r = this.redis()
    if (!r) return [...this.memCordoned]
    try {
      return await r.smembers(CORDON_SET)
    } catch {
      return [...this.memCordoned]
    }
  }

  // --- placement -----------------------------------------------------------

  async setPlacement(projectId: string, hostId: string, tier: PlacementTier): Promise<void> {
    const p: Placement = { hostId, tier, lastAccessAt: Date.now() }
    const r = this.redis()
    if (!r) {
      this.memPlace.set(projectId, p)
      return
    }
    try {
      await r.set(`${PLACE_KEY}${projectId}`, JSON.stringify(p), 'EX', PLACEMENT_TTL_S)
    } catch {
      this.memPlace.set(projectId, p)
    }
  }

  async getPlacement(projectId: string): Promise<Placement | null> {
    const r = this.redis()
    if (!r) return this.memPlace.get(projectId) ?? null
    try {
      const v = await r.get(`${PLACE_KEY}${projectId}`)
      return v ? (JSON.parse(v) as Placement) : null
    } catch {
      return this.memPlace.get(projectId) ?? null
    }
  }

  async clearPlacement(projectId: string): Promise<void> {
    const r = this.redis()
    if (!r) {
      this.memPlace.delete(projectId)
      return
    }
    try {
      await r.del(`${PLACE_KEY}${projectId}`)
    } catch {
      this.memPlace.delete(projectId)
    }
  }

  // --- per-project lease (anti split brain) --------------------------------

  /** Acquire the lease iff free. Returns true on success. */
  async acquireLease(projectId: string, holder: string, ttlMs = LEASE_TTL_MS): Promise<boolean> {
    const r = this.redis()
    if (!r) {
      const cur = this.memLease.get(projectId)
      const now = Date.now()
      if (cur && cur.expiresAt > now && cur.holder !== holder) return false
      this.memLease.set(projectId, { holder, expiresAt: now + ttlMs })
      return true
    }
    try {
      // SET NX PX — atomic acquire. Re-acquire by the same holder also succeeds
      // (idempotent renewal on the acquire path).
      const ok = await r.set(`${LEASE_KEY}${projectId}`, holder, 'PX', ttlMs, 'NX')
      if (ok === 'OK') return true
      const cur = await r.get(`${LEASE_KEY}${projectId}`)
      if (cur === holder) {
        await r.pexpire(`${LEASE_KEY}${projectId}`, ttlMs)
        return true
      }
      return false
    } catch {
      return true // fail open: Redis blip shouldn't block resumes on the pilot
    }
  }

  async renewLease(projectId: string, holder: string, ttlMs = LEASE_TTL_MS): Promise<boolean> {
    const r = this.redis()
    if (!r) {
      const cur = this.memLease.get(projectId)
      if (cur && cur.holder === holder) {
        cur.expiresAt = Date.now() + ttlMs
        return true
      }
      return false
    }
    try {
      const res = (await r.eval(RENEW_LUA, 1, `${LEASE_KEY}${projectId}`, holder, String(ttlMs))) as number
      return res === 1
    } catch {
      return false
    }
  }

  async releaseLease(projectId: string, holder: string): Promise<void> {
    const r = this.redis()
    if (!r) {
      const cur = this.memLease.get(projectId)
      if (cur && cur.holder === holder) this.memLease.delete(projectId)
      return
    }
    try {
      await r.eval(RELEASE_LUA, 1, `${LEASE_KEY}${projectId}`, holder)
    } catch {
      /* best-effort; TTL will reclaim it */
    }
  }

  async leaseHolder(projectId: string): Promise<string | null> {
    const r = this.redis()
    if (!r) {
      const cur = this.memLease.get(projectId)
      return cur && cur.expiresAt > Date.now() ? cur.holder : null
    }
    try {
      return await r.get(`${LEASE_KEY}${projectId}`)
    } catch {
      return null
    }
  }

  // --- burst hosts (reconciler-provisioned, hourly) ------------------------

  async recordBurstHost(rec: BurstHostRecord): Promise<void> {
    const r = this.redis()
    if (!r) {
      this.memBurst.set(rec.hostId, rec)
      return
    }
    try {
      await r.hset(BURST_HASH, rec.hostId, JSON.stringify(rec))
    } catch {
      this.memBurst.set(rec.hostId, rec)
    }
  }

  async listBurstHosts(): Promise<BurstHostRecord[]> {
    const r = this.redis()
    if (!r) return [...this.memBurst.values()]
    try {
      const all = await r.hgetall(BURST_HASH)
      const out: BurstHostRecord[] = []
      for (const v of Object.values(all)) {
        try {
          out.push(JSON.parse(v) as BurstHostRecord)
        } catch {
          /* skip corrupt */
        }
      }
      return out
    } catch {
      return [...this.memBurst.values()]
    }
  }

  async removeBurstHost(hostId: string): Promise<void> {
    const r = this.redis()
    if (!r) {
      this.memBurst.delete(hostId)
      return
    }
    try {
      await r.hdel(BURST_HASH, hostId)
    } catch {
      this.memBurst.delete(hostId)
    }
  }

  // --- reconciler leader election ------------------------------------------
  // Only ONE API replica should actuate the fleet per tick (else N replicas
  // each provision a burst host). A short-TTL SET-NX lease elects a leader;
  // it lapses if the holder dies, so leadership fails over automatically.

  async acquireReconcileLease(holder: string, ttlMs: number): Promise<boolean> {
    const r = this.redis()
    if (!r) {
      const now = Date.now()
      const cur = this.memReconcileLease
      if (cur && cur.expiresAt > now && cur.holder !== holder) return false
      this.memReconcileLease = { holder, expiresAt: now + ttlMs }
      return true
    }
    try {
      const ok = await r.set(RECONCILE_LEASE_KEY, holder, 'PX', ttlMs, 'NX')
      if (ok === 'OK') return true
      const cur = await r.get(RECONCILE_LEASE_KEY)
      if (cur === holder) {
        await r.pexpire(RECONCILE_LEASE_KEY, ttlMs)
        return true
      }
      return false
    } catch {
      // Fail CLOSED: a Redis blip must not let every replica actuate at once.
      return false
    }
  }

  // --- per-region scale cooldown (anti-flap) -------------------------------

  async getLastScaleAt(region: string): Promise<number> {
    const r = this.redis()
    if (!r) return this.memCooldown.get(region) ?? 0
    try {
      const v = await r.get(`${SCALE_COOLDOWN_KEY}${region}`)
      return v ? parseInt(v, 10) : 0
    } catch {
      return this.memCooldown.get(region) ?? 0
    }
  }

  async setLastScaleAt(region: string, ts: number): Promise<void> {
    const r = this.redis()
    if (!r) {
      this.memCooldown.set(region, ts)
      return
    }
    try {
      await r.set(`${SCALE_COOLDOWN_KEY}${region}`, String(ts))
    } catch {
      this.memCooldown.set(region, ts)
    }
  }
}

let registry: MetalPlacementRegistry | null = null

export function getMetalPlacementRegistry(): MetalPlacementRegistry {
  if (!registry) registry = new MetalPlacementRegistry()
  return registry
}

/** Test-only: inject a registry (e.g. with a fake redis getter) or reset. */
export function _setMetalPlacementRegistry(r: MetalPlacementRegistry | null): void {
  registry = r
}

export const _leaseTtlMs = LEASE_TTL_MS
