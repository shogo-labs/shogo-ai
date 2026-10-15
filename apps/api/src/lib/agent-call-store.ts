// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Agent-Call Store — cross-pod status of tracked background `project_call`s.
 *
 * A runtime starts a tracked call (`POST /api/internal/projects/:id/agent-call`
 * with `wait: false, track: true`) on one API replica and long-polls
 * `GET .../agent-call/:runId` on whichever replica the load balancer picks,
 * so the record lives in Redis (shared ioredis client from `./tunnel-redis`).
 * Local mode, and cloud mode while Redis is unreachable, use a per-process
 * Map instead.
 */

import { getSharedRedis } from './tunnel-redis'

export type AgentCallStatus = 'running' | 'completed' | 'failed'

export interface AgentCallRecord {
  status: AgentCallStatus
  runId: string
  reply?: string | null
  sessionId?: string
  chatSessionId?: string
  error?: { code?: string; message: string }
  startedAt: number
  updatedAt: number
}

const TTL_SECONDS = 60 * 60
const POLL_INTERVAL_MS = 1_000

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'
const records = new Map<string, { record: AgentCallRecord; expiresAt: number }>()

function key(projectId: string, runId: string): string {
  return `agent-call:${projectId}:${runId}`
}

function redisOrNull() {
  if (isLocalMode) return null
  return getSharedRedis()
}

function putLocal(k: string, record: AgentCallRecord): void {
  const now = Date.now()
  for (const [rk, entry] of records) {
    if (entry.expiresAt <= now) records.delete(rk)
  }
  records.set(k, { record, expiresAt: now + TTL_SECONDS * 1000 })
}

function getLocal(k: string): AgentCallRecord | undefined {
  const entry = records.get(k)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    records.delete(k)
    return undefined
  }
  return entry.record
}

export async function putAgentCall(projectId: string, record: AgentCallRecord): Promise<void> {
  await storeAgentCall(projectId, record)
  if (record.status !== 'running') {
    const { emitTaskEvent } = await import('../services/background-tasks.service')
    await emitTaskEvent('project_call', `${projectId}:${record.runId}`, {
      status: record.status === 'completed' ? 'completed' : 'failed',
      line: record.reply?.trim() || record.error?.message,
      summary: record.status === 'completed' ? 'replied' : record.error?.message,
    })
  }
}

async function storeAgentCall(projectId: string, record: AgentCallRecord): Promise<void> {
  const k = key(projectId, record.runId)
  const r = redisOrNull()
  if (!r) {
    putLocal(k, record)
    return
  }
  try {
    await r.set(k, JSON.stringify(record), 'EX', TTL_SECONDS)
  } catch (err) {
    console.warn('[agent-call-store] Redis SET failed, falling back to local map:', (err as Error).message)
    putLocal(k, record)
  }
}

export async function getAgentCall(projectId: string, runId: string): Promise<AgentCallRecord | undefined> {
  const k = key(projectId, runId)
  const r = redisOrNull()
  if (!r) return getLocal(k)
  try {
    const raw = await r.get(k)
    if (!raw) return getLocal(k)
    return JSON.parse(raw) as AgentCallRecord
  } catch (err) {
    console.warn('[agent-call-store] Redis GET failed, falling back to local map:', (err as Error).message)
    return getLocal(k)
  }
}

/**
 * Resolve with the record once it is no longer `running`, or with the latest
 * record after `waitMs`. `undefined` means no call was ever tracked under
 * this runId (or it expired).
 */
export async function waitForAgentCall(
  projectId: string,
  runId: string,
  waitMs: number,
  opts: { pollIntervalMs?: number; signal?: AbortSignal } = {},
): Promise<AgentCallRecord | undefined> {
  const deadline = Date.now() + Math.max(0, waitMs)
  const interval = opts.pollIntervalMs ?? POLL_INTERVAL_MS
  let record = await getAgentCall(projectId, runId)
  while (record && record.status === 'running' && Date.now() < deadline && !opts.signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))))
    record = await getAgentCall(projectId, runId)
  }
  return record
}

/** Test seam — clears the in-memory fallback Map between tests. */
export const _testing = { records }
