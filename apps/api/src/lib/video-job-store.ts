// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Video Job Store — cross-pod record of submitted `generate_video` jobs.
 *
 * A runtime submits a job (`POST /ai/v1/videos/generations`) on one API
 * replica and polls `GET /ai/v1/videos/:id` on whichever replica the load
 * balancer picks, so the record (fal queue URLs, owner, billing inputs) lives
 * in Redis. Local mode, and cloud mode while Redis is unreachable, use a
 * per-process Map instead.
 *
 * `claimVideoCharge` is the charge-once guard: the first status poll that
 * sees the job completed wins the `SET NX` and records usage; every later
 * poll (on any pod) sees the claim and skips billing.
 */

import { getSharedRedis } from './tunnel-redis'

export interface VideoJobRecord {
  id: string
  /** Which vendor owns the job; the status route dispatches on it. */
  provider: 'fal' | 'higgsfield'
  workspaceId: string
  projectId: string
  userId?: string
  chatSessionId?: string | null
  model: string
  endpoint: string
  /** Where to poll. Provider-specific; checked against the provider's base on read. */
  statusUrl: string
  /** fal's result URL. Absent for Higgsfield, whose status body carries the output. */
  responseUrl?: string
  /** Higgsfield request id, for cancel and support. */
  requestId?: string
  /** Price captured from `/estimate` at submit — what the completion is billed. */
  estimate?: { rawUsd: number; billedUsd: number; credits?: number }
  duration: number
  audio: boolean
  aspectRatio?: string
  resolution?: string
  /** True when a source clip is being edited (Genjutsu) rather than generated. */
  sourceVideo?: boolean
  imageToVideo: boolean
  createdAt: number
}

/** fal keeps results for a while; a day comfortably covers slow queues and late polls. */
export const VIDEO_JOB_TTL_SECONDS = 24 * 60 * 60

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'
const records = new Map<string, { record: VideoJobRecord; expiresAt: number }>()
const charged = new Map<string, number>()

function jobKey(id: string): string {
  return `video-job:${id}`
}
function chargeKey(id: string): string {
  return `video-job-charged:${id}`
}

function redisOrNull() {
  if (isLocalMode) return null
  return getSharedRedis()
}

function sweepLocal(now: number): void {
  for (const [k, entry] of records) if (entry.expiresAt <= now) records.delete(k)
  for (const [k, expiresAt] of charged) if (expiresAt <= now) charged.delete(k)
}

function putLocal(record: VideoJobRecord): void {
  const now = Date.now()
  sweepLocal(now)
  records.set(jobKey(record.id), { record, expiresAt: now + VIDEO_JOB_TTL_SECONDS * 1000 })
}

function getLocal(id: string): VideoJobRecord | undefined {
  const entry = records.get(jobKey(id))
  if (!entry || entry.expiresAt <= Date.now()) return undefined
  return entry.record
}

function claimLocal(id: string): boolean {
  const now = Date.now()
  sweepLocal(now)
  const k = chargeKey(id)
  if (charged.has(k)) return false
  charged.set(k, now + VIDEO_JOB_TTL_SECONDS * 1000)
  return true
}

export async function putVideoJob(record: VideoJobRecord): Promise<void> {
  const r = redisOrNull()
  if (!r) return putLocal(record)
  try {
    await r.set(jobKey(record.id), JSON.stringify(record), 'EX', VIDEO_JOB_TTL_SECONDS)
  } catch (err) {
    console.warn('[video-job-store] Redis SET failed, falling back to local map:', (err as Error).message)
    putLocal(record)
  }
}

export async function getVideoJob(id: string): Promise<VideoJobRecord | undefined> {
  const r = redisOrNull()
  if (!r) return getLocal(id)
  try {
    const raw = await r.get(jobKey(id))
    if (!raw) return getLocal(id)
    return JSON.parse(raw) as VideoJobRecord
  } catch (err) {
    console.warn('[video-job-store] Redis GET failed, falling back to local map:', (err as Error).message)
    return getLocal(id)
  }
}

/** True exactly once per job id: the caller that gets `true` records the charge. */
export async function claimVideoCharge(id: string): Promise<boolean> {
  const r = redisOrNull()
  if (!r) return claimLocal(id)
  try {
    const result = await r.set(chargeKey(id), String(Date.now()), 'EX', VIDEO_JOB_TTL_SECONDS, 'NX')
    return result === 'OK'
  } catch (err) {
    console.warn('[video-job-store] Redis SET NX failed, falling back to local set:', (err as Error).message)
    return claimLocal(id)
  }
}

/** Test seam — clears the in-memory fallback Maps between tests. */
export const _testing = { records, charged }
