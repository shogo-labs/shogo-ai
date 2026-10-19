// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Where a tracked `project_call` keeps its progress: one record per call
 * (`AgentCall`, keyed by project + runId) and one link per callee chat session
 * (`AgentCallSessionLink`).
 *
 * The caller polls `GET /api/internal/projects/:id/agent-call/:runId?waitMs=`,
 * the stream follower in `agent-call.service.ts` writes the record, and
 * `agent-call-reconcile.service.ts` reads it to repair a chat whose reply never
 * landed.
 *
 * Both surfaces run this one path against the database — SQLite on desktop,
 * Postgres in the cloud — because the record has to outlive the process that
 * wrote it. A restart used to lose an in-flight call entirely: the caller's
 * poll found nothing and the callee chat stayed a prompt with no answer.
 */
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

/** Which tracked call a callee chat session is running, so a reattach can complete it. */
export interface AgentCallSessionLink {
  projectId: string
  runId: string
  startedAt: number
}

/** Records are pruned by expiry, not by count: a week is plenty to reopen a chat. */
export const AGENT_CALL_TTL_SECONDS = 7 * 24 * 60 * 60

/**
 * How often the process that owns a running call refreshes `updatedAt`.
 * 15 s is short enough that a dead owner is noticed quickly and long enough
 * that it costs one small upsert per in-flight call per beat.
 */
export const AGENT_CALL_HEARTBEAT_MS = 15_000

/**
 * A `running` call whose `updatedAt` has not moved for this long is treated as
 * gone and failed with `interrupted`. It has to be comfortably larger than both
 * `AGENT_CALL_HEARTBEAT_MS` (6 missed beats) and the runtime's 60 s long-poll
 * (`AGENT_CALL_POLL_WAIT_MS` in `packages/agent-runtime/src/internal-api.ts`),
 * otherwise a slow but perfectly healthy call — one whose beat lands late, or
 * whose follower is merely busy — would be killed. Never shrink it below 90 s.
 */
export const AGENT_CALL_STALE_MS = 90_000

const POLL_INTERVAL_MS = 1_000

// ─── Database ────────────────────────────────────────────────────────────────

interface AgentCallRow {
  projectId: string
  runId: string
  status: AgentCallStatus
  reply: string | null
  error: string | null
  sessionId: string | null
  chatSessionId: string | null
  startedAt: Date | string
  updatedAt: Date | string
  expiresAt: Date | string
}

interface AgentCallLinkRow {
  chatSessionId: string
  projectId: string
  runId: string
  startedAt: Date | string
  expiresAt: Date | string
}

/** Just the two tables this store owns, so the prisma client stays opaque here. */
interface AgentCallDb {
  agentCall: {
    findUnique(args: any): Promise<AgentCallRow | null>
    upsert(args: any): Promise<unknown>
    delete(args: any): Promise<unknown>
    updateMany(args: any): Promise<{ count: number }>
  }
  agentCallSessionLink: {
    findUnique(args: any): Promise<AgentCallLinkRow | null>
    upsert(args: any): Promise<unknown>
    delete(args: any): Promise<unknown>
  }
}

let dbPromise: Promise<AgentCallDb | null> | null = null
let warnedDbFailure = false

function warnDbFailure(what: string, err: unknown): void {
  if (warnedDbFailure) return
  warnedDbFailure = true
  console.warn(`[agent-call-store] database ${what} failed; the call keeps running untracked:`, (err as Error)?.message ?? err)
}

/**
 * The app's Prisma client — the sqlite one on desktop, the Postgres one in the
 * cloud; `lib/prisma` picks it. Loaded lazily so this module stays importable
 * (and cheap) in tests that never touch a call.
 */
async function callDb(): Promise<AgentCallDb | null> {
  if (!process.env.SHOGO_APP_DATABASE_URL && !process.env.DATABASE_URL) return null
  if (!dbPromise) {
    dbPromise = import('./prisma')
      .then((mod) => (mod.prisma as unknown as AgentCallDb) ?? null)
      .catch((err) => {
        warnDbFailure('open', err)
        return null
      })
  }
  return dbPromise
}

function toMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

function parseErrorColumn(raw: string | null): AgentCallRecord['error'] {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed.message === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

function rowToRecord(row: AgentCallRow): AgentCallRecord {
  const record: AgentCallRecord = {
    status: row.status,
    runId: row.runId,
    startedAt: toMillis(row.startedAt),
    updatedAt: toMillis(row.updatedAt),
  }
  if (row.reply != null) record.reply = row.reply
  if (row.sessionId) record.sessionId = row.sessionId
  if (row.chatSessionId) record.chatSessionId = row.chatSessionId
  const error = parseErrorColumn(row.error)
  if (error) record.error = error
  return record
}

const INTERRUPTED = { code: 'interrupted', message: 'The call stopped reporting in, so its reply was lost.' }

/**
 * A `running` record that has not been refreshed inside the staleness window
 * belongs to a process that is gone (a restart, a crash, an evicted pod).
 * Nothing will ever finish it here, so fail it — otherwise the caller waits out
 * its whole budget and the callee chat keeps a prompt with no answer.
 *
 * Conditional update: if another replica refreshed or finished the record in
 * the same instant, the update matches nothing and the fresh row wins.
 */
async function failIfStale(db: AgentCallDb, row: AgentCallRow): Promise<AgentCallRow> {
  if (row.status !== 'running') return row
  const cutoff = new Date(Date.now() - AGENT_CALL_STALE_MS)
  if (toMillis(row.updatedAt) > cutoff.getTime()) return row
  const where = { projectId: row.projectId, runId: row.runId }
  await db.agentCall.updateMany({
    where: { ...where, status: 'running', updatedAt: { lt: cutoff } },
    data: { status: 'failed', error: JSON.stringify(INTERRUPTED) },
  })
  const fresh = await db.agentCall.findUnique({ where: { projectId_runId: where } })
  return fresh ?? row
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/** One upsert, no reads: this runs on every status change of every call. */
export async function putAgentCall(projectId: string, record: AgentCallRecord): Promise<void> {
  const db = await callDb()
  if (db) {
    const now = Date.now()
    const fields = {
      status: record.status,
      reply: record.reply ?? null,
      error: record.error ? JSON.stringify(record.error) : null,
      sessionId: record.sessionId ?? null,
      chatSessionId: record.chatSessionId ?? null,
      startedAt: new Date(record.startedAt || now),
      expiresAt: new Date(now + AGENT_CALL_TTL_SECONDS * 1000),
    }
    try {
      await db.agentCall.upsert({
        where: { projectId_runId: { projectId, runId: record.runId } },
        create: { projectId, runId: record.runId, ...fields },
        update: fields,
      })
    } catch (err) {
      warnDbFailure('write', err)
    }
  }
  if (record.status !== 'running') {
    const { emitTaskEvent } = await import('../services/background-tasks.service')
    await emitTaskEvent('project_call', `${projectId}:${record.runId}`, {
      status: record.status === 'completed' ? 'completed' : 'failed',
      line: record.reply?.trim() || record.error?.message,
      summary: record.status === 'completed' ? 'replied' : record.error?.message,
    })
  }
}

/**
 * Heartbeat for the process that owns a running call: one unchanged record
 * write, which is what `getAgentCall` uses to tell a live call from a dead one.
 * Returns the stop function; safe to call without ever awaiting anything.
 */
export function startAgentCallHeartbeat(projectId: string, runId: string): () => void {
  let stopped = false
  let inFlight = false
  const timer = setInterval(() => {
    if (stopped || inFlight) return
    inFlight = true
    void touchAgentCall(projectId, runId).finally(() => {
      inFlight = false
    })
  }, AGENT_CALL_HEARTBEAT_MS)
  timer.unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/** Refresh a running call's lease. A no-op once the call is terminal. */
export async function touchAgentCall(projectId: string, runId: string): Promise<void> {
  const db = await callDb()
  if (!db) return
  const now = new Date()
  try {
    await db.agentCall.updateMany({
      where: { projectId, runId, status: 'running' },
      data: { updatedAt: now, expiresAt: new Date(now.getTime() + AGENT_CALL_TTL_SECONDS * 1000) },
    })
  } catch (err) {
    warnDbFailure('heartbeat', err)
  }
}

export async function linkAgentCallSession(chatSessionId: string, link: AgentCallSessionLink): Promise<void> {
  const db = await callDb()
  if (!db) return
  const now = Date.now()
  const fields = {
    projectId: link.projectId,
    runId: link.runId,
    startedAt: new Date(link.startedAt || now),
    expiresAt: new Date(now + AGENT_CALL_TTL_SECONDS * 1000),
  }
  try {
    await db.agentCallSessionLink.upsert({
      where: { chatSessionId },
      create: { chatSessionId, ...fields },
      update: fields,
    })
  } catch (err) {
    warnDbFailure('link write', err)
  }
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * The call as the caller should see it. `undefined` means no call was ever
 * tracked under this runId in this project, or the record has expired.
 */
export async function getAgentCall(projectId: string, runId: string): Promise<AgentCallRecord | undefined> {
  const db = await callDb()
  if (!db) return undefined
  const where = { projectId_runId: { projectId, runId } }
  try {
    const row = await db.agentCall.findUnique({ where })
    if (!row) return undefined
    if (toMillis(row.expiresAt) <= Date.now()) {
      await db.agentCall.delete({ where }).catch(() => {})
      return undefined
    }
    return rowToRecord(await failIfStale(db, row))
  } catch (err) {
    warnDbFailure('read', err)
    return undefined
  }
}

export async function getAgentCallSessionLink(chatSessionId: string): Promise<AgentCallSessionLink | undefined> {
  const db = await callDb()
  if (!db) return undefined
  const where = { chatSessionId }
  try {
    const row = await db.agentCallSessionLink.findUnique({ where })
    if (!row) return undefined
    if (toMillis(row.expiresAt) <= Date.now()) {
      await db.agentCallSessionLink.delete({ where }).catch(() => {})
      return undefined
    }
    return { projectId: row.projectId, runId: row.runId, startedAt: toMillis(row.startedAt) }
  } catch (err) {
    warnDbFailure('link read', err)
    return undefined
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
