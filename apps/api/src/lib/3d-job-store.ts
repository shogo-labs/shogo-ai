// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * 3D Job Store — cross-pod record of submitted Tripo3D tasks.
 *
 * A runtime submits a job (`POST /ai/v1/3d/generations`) on one API replica
 * and polls `GET /ai/v1/3d/:id` on whichever replica the load balancer picks,
 * so the record (Tripo task id, owner, billing inputs) lives in Redis. Local
 * mode, and cloud mode while Redis is unreachable, use a per-process Map.
 *
 * `claim3dCharge` is the charge-once guard: the first status poll that sees
 * the task succeed wins the `SET NX` and records usage; every later poll (on
 * any pod) sees the claim and skips billing.
 */

import { getSharedRedis } from './tunnel-redis'

export interface ThreeDJobRecord {
  id: string
  workspaceId: string
  projectId: string
  userId?: string
  chatSessionId?: string | null
  /** Shogo model id (`tripo-v3.1`, `tripo-p1`, ...). */
  model: string
  /** Which Tripo operation this job submitted (`TRIPO_OPS` key). */
  op: string
  /** Tripo's own task id (a UUID), used for every status poll. */
  taskId: string
  input: 'text' | 'image' | 'images' | 'model'
  texture?: boolean
  textureQuality?: string
  /** Advisory price shown at submit; billing follows `credits_consumed`. */
  estimatedCredits?: number
  createdAt: number
}

/** Tripo keeps task results for a while; a day covers slow queues and late polls. */
export const THREE_D_JOB_TTL_SECONDS = 24 * 60 * 60

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'
const records = new Map<string, { record: ThreeDJobRecord; expiresAt: number }>()
const charged = new Map<string, number>()

function jobKey(id: string): string {
  return `3d-job:${id}`
}
function chargeKey(id: string): string {
  return `3d-job-charged:${id}`
}

function redisOrNull() {
  if (isLocalMode) return null
  return getSharedRedis()
}

function sweepLocal(now: number): void {
  for (const [k, entry] of records) if (entry.expiresAt <= now) records.delete(k)
  for (const [k, expiresAt] of charged) if (expiresAt <= now) charged.delete(k)
}

function putLocal(record: ThreeDJobRecord): void {
  const now = Date.now()
  sweepLocal(now)
  records.set(jobKey(record.id), { record, expiresAt: now + THREE_D_JOB_TTL_SECONDS * 1000 })
}

function getLocal(id: string): ThreeDJobRecord | undefined {
  const entry = records.get(jobKey(id))
  if (!entry || entry.expiresAt <= Date.now()) return undefined
  return entry.record
}

function claimLocal(id: string): boolean {
  const now = Date.now()
  sweepLocal(now)
  const k = chargeKey(id)
  if (charged.has(k)) return false
  charged.set(k, now + THREE_D_JOB_TTL_SECONDS * 1000)
  return true
}

export async function put3dJob(record: ThreeDJobRecord): Promise<void> {
  const r = redisOrNull()
  if (!r) return putLocal(record)
  try {
    await r.set(jobKey(record.id), JSON.stringify(record), 'EX', THREE_D_JOB_TTL_SECONDS)
  } catch (err) {
    console.warn('[3d-job-store] Redis SET failed, falling back to local map:', (err as Error).message)
    putLocal(record)
  }
}

export async function get3dJob(id: string): Promise<ThreeDJobRecord | undefined> {
  const r = redisOrNull()
  if (!r) return getLocal(id)
  try {
    const raw = await r.get(jobKey(id))
    if (!raw) return getLocal(id)
    return JSON.parse(raw) as ThreeDJobRecord
  } catch (err) {
    console.warn('[3d-job-store] Redis GET failed, falling back to local map:', (err as Error).message)
    return getLocal(id)
  }
}

/** True exactly once per job id: the caller that gets `true` records the charge. */
export async function claim3dCharge(id: string): Promise<boolean> {
  const r = redisOrNull()
  if (!r) return claimLocal(id)
  try {
    const result = await r.set(chargeKey(id), String(Date.now()), 'EX', THREE_D_JOB_TTL_SECONDS, 'NX')
    return result === 'OK'
  } catch (err) {
    console.warn('[3d-job-store] Redis SET NX failed, falling back to local set:', (err as Error).message)
    return claimLocal(id)
  }
}

/** Test seam — clears the in-memory fallback Maps between tests. */
export const _testing = { records, charged }
