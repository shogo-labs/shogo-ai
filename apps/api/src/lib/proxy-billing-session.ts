// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Proxy Billing Sessions
 *
 * Accumulates token usage across multiple AI proxy calls within a single
 * user-message turn, then charges once when the session closes.
 *
 * Problem: An agentic loop (user message → tool calls → more tool calls → final
 * response) makes N separate API calls through the AI proxy. Charging per-call
 * inflates cost because of per-call minimums and rounding.
 *
 * Solution: The caller (project-chat, /api/chat, agent-runtime) opens a billing
 * session before proxying. The AI proxy accumulates tokens against the session.
 * When the caller closes the session, we charge once based on the total.
 *
 * Keyed by `(projectId, chatSessionId)` so concurrent chat sessions on the
 * same project (multiple chat panels, multiple workspace members) bill
 * independently. When no chatSessionId is supplied (legacy callers, first
 * turn of a brand-new chat session before the id is known), the key falls
 * back to `projectId` alone for backwards compatibility.
 *
 * ── Cross-pod state (Redis) ─────────────────────────────────────────────────
 *
 * The cloud API tier runs multiple replicas behind a `Service` with NO
 * session affinity (see `k8s/base/api.yaml`), and long chat turns can need a
 * server-side stream resume (Knative's ~5 min idle/request timeout cuts the
 * SSE connection — see `project-chat.ts`'s `trackUsageFromStream` docstring).
 * A resumed leg is served by a random sibling pod. Before this module wrote
 * through to Redis, session state lived in a plain in-process `Map`, so:
 *
 *   pod A: openSession + accumulateUsage (leg 1)          → tokens land here
 *   pod B: leg 2 resumes, closeSession() on THIS pod       → sees 0 tokens
 *
 * pod B's `closeSession` found no local session and recorded a false
 * "zero-token / earlyFailure" row — even though the turn was still running
 * and real tokens had accumulated on pod A. Net effect: usage undercounting
 * (revenue leak) and a wildly overstated failure rate in `agent_cost_metrics`
 * (reproduced live 2026-09-13: a single turn split xvvwd→mxdjj→xvvwd→mxdjj,
 * two of its four legs closing "zero-token" while the turn kept succeeding).
 *
 * Fix: every mutating op writes through to the shared `ioredis` client from
 * `tunnel-redis.ts` (same client already used for cross-pod tunnel routing
 * and, via `pending-login-store.ts`, cross-pod CLI-login state — this module
 * follows that exact precedent). Redis is the source of truth in cloud mode:
 * no L1 caching, because pod B's close must see pod A's accumulated tokens
 * without delay. Numeric fields use atomic `HINCRBY`/`HINCRBYFLOAT` (guarded
 * by an existence check via a small Lua script) so concurrent legs on
 * different pods can never lose an update to a read-modify-write race.
 *
 * Modes:
 *   - `SHOGO_LOCAL_MODE=true` (single-process / Electron-bundled API): every
 *     op routes to the in-memory `sessions` Map. No Redis.
 *   - Cloud mode, Redis healthy: every op goes through Redis.
 *   - Cloud mode, Redis degraded/unreachable: ops fall back to the in-memory
 *     Map and log a loud warning. This is a correctness downgrade (the
 *     cross-pod bug above comes back until Redis recovers) but keeps a
 *     Redis blip from becoming a total billing outage — same tradeoff
 *     `pending-login-store.ts` makes for CLI login.
 *
 * ── Stream-usage fallback (defense in depth) ────────────────────────────────
 *
 * `closeSession`'s `fallbackUsage` option lets a caller pass the token
 * counts it parsed directly off the SSE stream's own `data-usage`/`finish`
 * event. If the session accumulator (Redis or local) comes up with zero
 * tokens but the stream itself reported real usage, we bill/record on the
 * stream's numbers instead of firing a false zero-token failure. This stays
 * in place permanently, even after the Redis fix above, as a safety net for
 * a Redis outage (which degrades back to the per-pod Map) and as a
 * continuous canary: any future regression that fragments a turn again will
 * show up as `usageSource: 'stream-fallback'` rows in `agent_cost_metrics`
 * instead of silently undercounting again.
 */

import { getSharedRedis } from './tunnel-redis'
import { calculateUsageCost, proxyModelToBillingModel } from './usage-cost'
import * as billingService from '../services/billing.service'
import { recordAgentCostMetric } from '../services/cost-analytics.service'

const SESSION_TIMEOUT_MS = 10 * 60 * 1000 // 10 min safety net (app-level staleness threshold)
// Redis-side hard TTL is longer than the app-level staleness threshold above
// so the periodic sweep (which flushes+bills stale sessions) gets a chance to
// run before Redis silently drops the key out from under it.
const REDIS_TTL_MS = SESSION_TIMEOUT_MS * 2

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'

// Every Redis op below is raced against this timeout. `tunnel-redis.ts`'s
// shared client retries connection failures FOREVER by design (a past
// incident: giving up on a redis-master reschedule latched every pod into a
// degraded state — see its `retryStrategy` comment), which is the right
// call for that module's long-lived pub/sub connection, but means a command
// queued against a client that is mid-reconnect can sit unresolved far
// longer than any chat request should ever wait on a billing side-channel.
// Without this bound, a Redis outage wouldn't just degrade to the local-map
// fallback (the intended behavior) — it would hang the request pipeline
// itself, which is strictly worse than the bug this module exists to fix.
const REDIS_OP_TIMEOUT_MS = 750

function withRedisTimeout<T>(promise: Promise<T>, ms: number = REDIS_OP_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Redis op timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * `agentType` for turns that died before the LLM produced any tokens.
 *
 * Kept distinct from `main-chat` on purpose: these rows exist to make silent
 * dropped turns countable, and folding them into `main-chat` would charge a
 * model's measured quality (and any active A/B experiment) for failures the
 * model was never involved in.
 */
export const FAILED_TURN_AGENT_TYPE = 'main-chat-failed'

export interface BillingSessionQualitySignals {
  success?: boolean
  hitMaxTurns?: boolean
  loopDetected?: boolean
  escalated?: boolean
  responseEmpty?: boolean
}

/**
 * Usage a caller parsed directly off the SSE stream's own `data-usage` /
 * `finish` event (see `trackUsageFromStream` in `project-chat.ts`). Used by
 * `closeSession` as a fallback ONLY when the session's own accumulator has
 * zero tokens — see the module docstring's "stream-usage fallback" section.
 */
export interface BillingSessionFallbackUsage {
  model?: string
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
}

interface BillingSession {
  projectId: string
  chatSessionId: string | null
  workspaceId: string
  userId: string
  model: string
  inputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  outputTokens: number
  requestCount: number
  imageRawUsd: number
  imageBilledUsd: number
  imageGenerationCount: number
  imageModels: string[]
  quality: BillingSessionQualitySignals
  openedAt: number
  lastActivityAt: number
}

// In-memory fallback. The source of truth in local mode (and during Redis
// outages in cloud mode) — see module docstring.
const sessions = new Map<string, BillingSession>()

/**
 * Compose the map/Redis key from project + chat session. Falls back to
 * projectId alone when no chatSessionId is available so legacy callers
 * (and the first turn of a brand-new chat) continue to bill correctly.
 */
function sessionKey(projectId: string, chatSessionId?: string | null): string {
  return chatSessionId ? `${projectId}:${chatSessionId}` : projectId
}

function redisOrNull() {
  if (isLocalMode) return null
  return getSharedRedis()
}

function redisHashKey(key: string): string {
  return `billing-session:${key}`
}
function redisModelsKey(key: string): string {
  return `billing-session-models:${key}`
}
/** Per-project index of open composite keys — lets `hasActiveSession` avoid a
 * cluster-wide SCAN on the hot per-call path (every AI proxy request). */
function redisIndexKey(projectId: string): string {
  return `billing-session-index:${projectId}`
}

function emptySession(projectId: string, chatSessionId: string | null, workspaceId: string, userId: string): BillingSession {
  return {
    projectId,
    chatSessionId,
    workspaceId,
    userId,
    model: 'sonnet',
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    requestCount: 0,
    imageRawUsd: 0,
    imageBilledUsd: 0,
    imageGenerationCount: 0,
    imageModels: [],
    quality: {},
    openedAt: Date.now(),
    lastActivityAt: Date.now(),
  }
}

function parseSessionHash(hash: Record<string, string>, imageModels: string[]): BillingSession | null {
  if (!hash || Object.keys(hash).length === 0) return null
  return {
    projectId: hash.projectId,
    chatSessionId: hash.chatSessionId || null,
    workspaceId: hash.workspaceId,
    userId: hash.userId,
    model: hash.model || 'sonnet',
    inputTokens: Number(hash.inputTokens || 0),
    cachedInputTokens: Number(hash.cachedInputTokens || 0),
    cacheWriteTokens: Number(hash.cacheWriteTokens || 0),
    outputTokens: Number(hash.outputTokens || 0),
    requestCount: Number(hash.requestCount || 0),
    imageRawUsd: Number(hash.imageRawUsd || 0),
    imageBilledUsd: Number(hash.imageBilledUsd || 0),
    imageGenerationCount: Number(hash.imageGenerationCount || 0),
    imageModels,
    quality: {
      success: hash['quality:success'] === undefined ? undefined : hash['quality:success'] === '1',
      hitMaxTurns: hash['quality:hitMaxTurns'] === '1',
      loopDetected: hash['quality:loopDetected'] === '1',
      escalated: hash['quality:escalated'] === '1',
      responseEmpty: hash['quality:responseEmpty'] === '1',
    },
    openedAt: Number(hash.openedAt || Date.now()),
    lastActivityAt: Number(hash.lastActivityAt || Date.now()),
  }
}

// Lua script: atomically bump numeric fields ONLY if the hash already
// exists. Guards against `HINCRBY` auto-vivifying a hash for a session that
// was never opened (or was already closed by a sibling pod) — without this
// check, an accumulate call landing just after a close would silently
// fabricate a phantom session. Returns 0 (no-op) or 1 (accumulated).
const ACCUMULATE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
redis.call('HSET', KEYS[1], 'model', ARGV[1])
redis.call('HINCRBY', KEYS[1], 'inputTokens', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'outputTokens', ARGV[3])
redis.call('HINCRBY', KEYS[1], 'cachedInputTokens', ARGV[4])
redis.call('HINCRBY', KEYS[1], 'cacheWriteTokens', ARGV[5])
redis.call('HINCRBY', KEYS[1], 'requestCount', 1)
redis.call('HSET', KEYS[1], 'lastActivityAt', ARGV[6])
redis.call('PEXPIRE', KEYS[1], ARGV[7])
return 1
`

const ACCUMULATE_IMAGE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
redis.call('HINCRBYFLOAT', KEYS[1], 'imageRawUsd', ARGV[1])
redis.call('HINCRBYFLOAT', KEYS[1], 'imageBilledUsd', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'imageGenerationCount', 1)
redis.call('SADD', KEYS[2], ARGV[3])
redis.call('HSET', KEYS[1], 'lastActivityAt', ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
redis.call('PEXPIRE', KEYS[2], ARGV[5])
return 1
`

const SET_QUALITY_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
for i = 1, #ARGV - 2, 2 do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])
end
redis.call('HSET', KEYS[1], 'lastActivityAt', ARGV[#ARGV - 1])
redis.call('PEXPIRE', KEYS[1], ARGV[#ARGV])
return 1
`

// ─── Local (in-process Map) implementation — source of truth in local mode
// and the fallback path during a Redis outage. Semantics are byte-for-byte
// the same as the pre-Redis version of this module. ──────────────────────────

function hasSessionLocal(projectId: string, chatSessionId?: string | null): boolean {
  return sessions.has(sessionKey(projectId, chatSessionId))
}

function hasActiveSessionLocal(projectId: string, chatSessionId?: string | null): boolean {
  if (lookupSessionLocal(projectId, chatSessionId)) return true
  for (const s of sessions.values()) {
    if (s.projectId === projectId) return true
  }
  return false
}

function lookupSessionLocal(projectId: string, chatSessionId?: string | null): BillingSession | undefined {
  if (chatSessionId) {
    const composite = sessions.get(sessionKey(projectId, chatSessionId))
    if (composite) return composite
  }
  return sessions.get(projectId)
}

function accumulateUsageLocal(
  projectId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  cacheWriteTokens: number,
  chatSessionId?: string | null,
): boolean {
  const session = lookupSessionLocal(projectId, chatSessionId)
  if (!session) return false
  session.inputTokens += inputTokens
  session.cachedInputTokens += cachedInputTokens
  session.cacheWriteTokens += cacheWriteTokens
  session.outputTokens += outputTokens
  session.requestCount += 1
  session.model = model
  session.lastActivityAt = Date.now()
  return true
}

function accumulateImageUsageLocal(
  projectId: string,
  model: string,
  rawUsd: number,
  billedUsd: number,
  chatSessionId?: string | null,
): boolean {
  const session = lookupSessionLocal(projectId, chatSessionId)
  if (!session) return false
  session.imageRawUsd += rawUsd
  session.imageBilledUsd += billedUsd
  session.imageGenerationCount += 1
  if (!session.imageModels.includes(model)) session.imageModels.push(model)
  session.lastActivityAt = Date.now()
  return true
}

function setQualitySignalsLocal(
  projectId: string,
  quality: BillingSessionQualitySignals,
  chatSessionId?: string | null,
): boolean {
  const session = lookupSessionLocal(projectId, chatSessionId)
  if (!session) return false
  session.quality = { ...session.quality, ...quality }
  session.lastActivityAt = Date.now()
  return true
}

/** Drains and returns the local session for (projectId, chatSessionId), or null. */
function popSessionLocal(projectId: string, chatSessionId?: string | null): BillingSession | null {
  let key = sessionKey(projectId, chatSessionId)
  let session = sessions.get(key)
  if (!session && chatSessionId) {
    key = projectId
    session = sessions.get(key)
  }
  if (!session) return null
  sessions.delete(key)
  return session
}

function openSessionLocal(
  projectId: string,
  workspaceId: string,
  userId: string,
  chatSessionId?: string | null,
): void {
  const key = sessionKey(projectId, chatSessionId)
  const existing = sessions.get(key)
  if (existing) {
    const log = chatSessionId ? console.error : console.warn
    log(`[BillingSession] Overwriting existing session for ${key} (${existing.requestCount} requests buffered)`)
    closeSession(projectId, { chatSessionId: chatSessionId ?? undefined, bookkeeping: true }).catch(() => {})
  }
  sessions.set(key, emptySession(projectId, chatSessionId ?? null, workspaceId, userId))
}

// ─── Redis implementation ───────────────────────────────────────────────────

async function hasSessionRedis(r: NonNullable<ReturnType<typeof redisOrNull>>, projectId: string, chatSessionId?: string | null): Promise<boolean> {
  const key = redisHashKey(sessionKey(projectId, chatSessionId))
  return (await r.exists(key)) === 1
}

async function hasActiveSessionRedis(r: NonNullable<ReturnType<typeof redisOrNull>>, projectId: string, chatSessionId?: string | null): Promise<boolean> {
  if (await hasSessionRedis(r, projectId, chatSessionId)) return true
  // Fall back to the legacy projectId-only key, matching lookupSession's order.
  if (chatSessionId && (await r.exists(redisHashKey(projectId))) === 1) return true
  // Sentinel/header-less callers: any open session for this project at all.
  const count = await r.scard(redisIndexKey(projectId))
  return count > 0
}

async function accumulateUsageRedis(
  r: NonNullable<ReturnType<typeof redisOrNull>>,
  projectId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  cacheWriteTokens: number,
  chatSessionId?: string | null,
): Promise<boolean> {
  const composite = chatSessionId ? redisHashKey(sessionKey(projectId, chatSessionId)) : null
  const legacy = redisHashKey(projectId)
  const now = Date.now()
  for (const key of composite ? [composite, legacy] : [legacy]) {
    const result = await r.eval(
      ACCUMULATE_SCRIPT, 1, key,
      model, String(inputTokens), String(outputTokens), String(cachedInputTokens), String(cacheWriteTokens),
      String(now), String(REDIS_TTL_MS),
    )
    if (result === 1) return true
  }
  return false
}

async function accumulateImageUsageRedis(
  r: NonNullable<ReturnType<typeof redisOrNull>>,
  projectId: string,
  model: string,
  rawUsd: number,
  billedUsd: number,
  chatSessionId?: string | null,
): Promise<boolean> {
  const composite = chatSessionId ? sessionKey(projectId, chatSessionId) : null
  const legacy = projectId
  const now = Date.now()
  for (const key of composite ? [composite, legacy] : [legacy]) {
    const result = await r.eval(
      ACCUMULATE_IMAGE_SCRIPT, 2, redisHashKey(key), redisModelsKey(key),
      String(rawUsd), String(billedUsd), model, String(now), String(REDIS_TTL_MS),
    )
    if (result === 1) return true
  }
  return false
}

async function setQualitySignalsRedis(
  r: NonNullable<ReturnType<typeof redisOrNull>>,
  projectId: string,
  quality: BillingSessionQualitySignals,
  chatSessionId?: string | null,
): Promise<boolean> {
  const fields: string[] = []
  for (const [k, v] of Object.entries(quality)) {
    if (v === undefined) continue
    fields.push(`quality:${k}`, v ? '1' : '0')
  }
  const now = Date.now()
  const composite = chatSessionId ? sessionKey(projectId, chatSessionId) : null
  const legacy = projectId
  for (const key of composite ? [composite, legacy] : [legacy]) {
    const result = await r.eval(SET_QUALITY_SCRIPT, 1, redisHashKey(key), ...fields, String(now), String(REDIS_TTL_MS))
    if (result === 1) return true
  }
  return false
}

async function openSessionRedis(
  r: NonNullable<ReturnType<typeof redisOrNull>>,
  projectId: string,
  workspaceId: string,
  userId: string,
  chatSessionId?: string | null,
): Promise<void> {
  const key = sessionKey(projectId, chatSessionId)
  const existing = await r.exists(redisHashKey(key))
  if (existing === 1) {
    const log = chatSessionId ? console.error : console.warn
    log(`[BillingSession] Overwriting existing Redis session for ${key}`)
    await closeSession(projectId, { chatSessionId: chatSessionId ?? undefined, bookkeeping: true }).catch(() => {})
  }
  const fresh = emptySession(projectId, chatSessionId ?? null, workspaceId, userId)
  await r
    .multi()
    .del(redisModelsKey(key))
    .hset(redisHashKey(key), {
      projectId: fresh.projectId,
      chatSessionId: fresh.chatSessionId ?? '',
      workspaceId: fresh.workspaceId,
      userId: fresh.userId,
      model: fresh.model,
      inputTokens: '0',
      cachedInputTokens: '0',
      cacheWriteTokens: '0',
      outputTokens: '0',
      requestCount: '0',
      imageRawUsd: '0',
      imageBilledUsd: '0',
      imageGenerationCount: '0',
      openedAt: String(fresh.openedAt),
      lastActivityAt: String(fresh.lastActivityAt),
    })
    .pexpire(redisHashKey(key), REDIS_TTL_MS)
    .sadd(redisIndexKey(projectId), key)
    .pexpire(redisIndexKey(projectId), REDIS_TTL_MS)
    .exec()
}

/** Atomically read-and-delete a Redis-backed session (composite key only). */
async function popSessionRedisAtKey(
  r: NonNullable<ReturnType<typeof redisOrNull>>,
  projectId: string,
  key: string,
): Promise<BillingSession | null> {
  const results = await r
    .multi()
    .hgetall(redisHashKey(key))
    .smembers(redisModelsKey(key))
    .del(redisHashKey(key))
    .del(redisModelsKey(key))
    .srem(redisIndexKey(projectId), key)
    .exec()
  if (!results) return null
  const [, hashRes] = results[0] as [Error | null, Record<string, string>]
  const [, modelsRes] = results[1] as [Error | null, string[]]
  return parseSessionHash(hashRes, modelsRes || [])
}

async function popSessionRedis(
  r: NonNullable<ReturnType<typeof redisOrNull>>,
  projectId: string,
  chatSessionId?: string | null,
): Promise<BillingSession | null> {
  const key = sessionKey(projectId, chatSessionId)
  const found = await popSessionRedisAtKey(r, projectId, key)
  if (found) return found
  if (chatSessionId) {
    return popSessionRedisAtKey(r, projectId, projectId)
  }
  return null
}

// ─── Periodic orphan sweep (crash recovery) ────────────────────────────────
// Runs on every pod. The atomic pop inside `closeSession` (Redis MULTI, or
// the local Map's single-threaded delete) means a stale session can only
// ever be flushed once even if several pods' sweeps race on the same key —
// every loser simply finds nothing to close.

setInterval(() => {
  const now = Date.now()
  for (const [key, session] of sessions) {
    if (now - session.lastActivityAt > SESSION_TIMEOUT_MS) {
      console.warn(`[BillingSession] Flushing orphaned session for ${key} (${session.requestCount} requests, ${session.inputTokens + session.outputTokens} tokens, ${session.imageGenerationCount} images $${session.imageBilledUsd.toFixed(4)})`)
      closeSession(session.projectId, { chatSessionId: session.chatSessionId ?? undefined }).catch(err =>
        console.error(`[BillingSession] Failed to flush orphaned session ${key}:`, err)
      )
    }
  }

  const r = redisOrNull()
  if (!r) return
  void withRedisTimeout(
    (async () => {
      let cursor = '0'
      do {
        const [next, keys]: [string, string[]] = await r.scan(cursor, 'MATCH', 'billing-session:*', 'COUNT', 200) as any
        cursor = next
        for (const fullKey of keys) {
          const lastActivityAtRaw = await r.hget(fullKey, 'lastActivityAt')
          if (!lastActivityAtRaw) continue
          if (now - Number(lastActivityAtRaw) <= SESSION_TIMEOUT_MS) continue
          const projectId = await r.hget(fullKey, 'projectId')
          if (!projectId) continue
          const chatSessionId = (await r.hget(fullKey, 'chatSessionId')) || undefined
          console.warn(`[BillingSession] Flushing orphaned Redis session ${fullKey}`)
          await closeSession(projectId, { chatSessionId }).catch(err =>
            console.error(`[BillingSession] Failed to flush orphaned Redis session ${fullKey}:`, err)
          )
        }
      } while (cursor !== '0')
    })(),
    // Background loop doing many round-trips against a potentially large
    // keyspace — give it a much longer budget than the per-request ops
    // above, but still bounded so a wedged client can't leak an
    // ever-growing pile of stuck sweep promises, one per tick forever.
    30_000,
  ).catch((err) => {
    console.warn('[BillingSession] Redis orphan sweep failed (will retry next tick):', (err as Error).message)
  })
}, 60_000)

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Open a billing session for a (project, chatSession) tuple. Subsequent AI
 * proxy calls for the same tuple will accumulate tokens here instead of
 * charging per-call.
 *
 * `chatSessionId` is optional for backwards compatibility — when omitted
 * the session is keyed by `projectId` alone and concurrent turns on the
 * same project will collide as before. Always pass it from new code paths.
 */
export async function openSession(
  projectId: string,
  workspaceId: string,
  userId: string,
  chatSessionId?: string | null,
): Promise<void> {
  const r = redisOrNull()
  if (r) {
    try {
      await withRedisTimeout(openSessionRedis(r, projectId, workspaceId, userId, chatSessionId))
      return
    } catch (err) {
      console.warn(`[BillingSession] Redis openSession failed, falling back to local map (cross-pod billing will break until Redis recovers):`, (err as Error).message)
    }
  }
  openSessionLocal(projectId, workspaceId, userId, chatSessionId)
}

/** Check if there's an active billing session for a (project, chatSession) tuple. */
export async function hasSession(projectId: string, chatSessionId?: string | null): Promise<boolean> {
  const r = redisOrNull()
  if (r) {
    try {
      return await withRedisTimeout(hasSessionRedis(r, projectId, chatSessionId))
    } catch (err) {
      console.warn(`[BillingSession] Redis hasSession failed, checking local map:`, (err as Error).message)
    }
  }
  return hasSessionLocal(projectId, chatSessionId)
}

/**
 * Check whether a turn is currently in flight for `projectId` — i.e. a billing
 * session was opened for it and hasn't been closed yet.
 *
 * Used by the AI proxy's per-call usage pre-flight to avoid killing an
 * already-admitted message mid-generation: a chat turn is gated for usage once
 * at turn start (project-chat / workspace-chat), then makes up to
 * AGENT_MAX_ITERATIONS proxied LLM/image calls. Re-running the 402 pre-flight
 * on those intermediate calls would drop the run halfway. If a session is
 * open, the turn already passed the start gate, so we let it finish.
 *
 * Resolution order:
 *   1. `lookupSession` (composite `(projectId, chatSessionId)` key, then the
 *      legacy projectId-only fallback).
 *   2. Any open session belonging to `projectId` (Redis: an index Set kept
 *      for O(1) lookup; local: a scan). Covers header-less/sentinel callers
 *      where the runtime dropped the `x-chat-session-id` header (gateway
 *      `isRealChatSession === false`), so the keyed lookups miss even though
 *      a turn is genuinely in flight.
 */
export async function hasActiveSession(projectId: string, chatSessionId?: string | null): Promise<boolean> {
  const r = redisOrNull()
  if (r) {
    try {
      return await withRedisTimeout(hasActiveSessionRedis(r, projectId, chatSessionId))
    } catch (err) {
      console.warn(`[BillingSession] Redis hasActiveSession failed, checking local map:`, (err as Error).message)
    }
  }
  return hasActiveSessionLocal(projectId, chatSessionId)
}

/**
 * Accumulate token usage from an AI proxy call. Returns true if tokens were
 * accumulated against an active session, false if no session exists (caller
 * should charge per-call).
 *
 * Looks up the session via the composite `(projectId, chatSessionId)` key
 * when chatSessionId is supplied, falling back to the legacy projectId-only
 * key if the composite lookup misses (covers calls from older runtimes that
 * don't yet forward the chat-session header).
 */
export async function accumulateUsage(
  projectId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number = 0,
  cacheWriteTokens: number = 0,
  chatSessionId?: string | null,
): Promise<boolean> {
  const r = redisOrNull()
  if (r) {
    try {
      return await withRedisTimeout(accumulateUsageRedis(r, projectId, model, inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, chatSessionId))
    } catch (err) {
      console.warn(`[BillingSession] Redis accumulateUsage failed, falling back to local map:`, (err as Error).message)
    }
  }
  return accumulateUsageLocal(projectId, model, inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, chatSessionId)
}

/**
 * Accumulate image-generation USD from an AI proxy image call. Returns true
 * if accumulated against an active session, false if no session exists
 * (caller should charge per-call).
 */
export async function accumulateImageUsage(
  projectId: string,
  model: string,
  rawUsd: number,
  billedUsd: number,
  chatSessionId?: string | null,
): Promise<boolean> {
  const r = redisOrNull()
  if (r) {
    try {
      return await withRedisTimeout(accumulateImageUsageRedis(r, projectId, model, rawUsd, billedUsd, chatSessionId))
    } catch (err) {
      console.warn(`[BillingSession] Redis accumulateImageUsage failed, falling back to local map:`, (err as Error).message)
    }
  }
  return accumulateImageUsageLocal(projectId, model, rawUsd, billedUsd, chatSessionId)
}

export async function setQualitySignals(
  projectId: string,
  quality: BillingSessionQualitySignals,
  chatSessionId?: string | null,
): Promise<boolean> {
  const r = redisOrNull()
  if (r) {
    try {
      return await withRedisTimeout(setQualitySignalsRedis(r, projectId, quality, chatSessionId))
    } catch (err) {
      console.warn(`[BillingSession] Redis setQualitySignals failed, falling back to local map:`, (err as Error).message)
    }
  }
  return setQualitySignalsLocal(projectId, quality, chatSessionId)
}

/**
 * Close a billing session and charge USD based on total accumulated tokens.
 * Returns the marked-up USD charged (0 if no tokens or session not found).
 *
 * When `discardPartial: true`, the session is dropped WITHOUT charging.
 * Used when the upstream stream EOF'd before the runtime emitted its
 * terminal `data-turn-complete` marker — we don't want to bill a user
 * for a half-finished turn that the auto-resuming-fetch client will
 * reconnect and finish on a subsequent request.
 *
 * When `bookkeeping: true`, the close is internal session-map maintenance
 * rather than a turn ending, so a zero-token close does not emit a
 * failed-turn metric row.
 *
 * `fallbackUsage` — see the module docstring's "stream-usage fallback"
 * section. Only consulted when the accumulated session has zero tokens AND
 * zero image USD, and is ignored for `discardPartial`/`bookkeeping` closes
 * (a discarded partial must stay unbilled; the client will retry and finish
 * the turn, and double-counting it later would overcharge).
 */
export async function closeSession(
  projectId: string,
  options: {
    discardPartial?: boolean
    chatSessionId?: string | null
    bookkeeping?: boolean
    fallbackUsage?: BillingSessionFallbackUsage
  } = {},
): Promise<{ billedUsd: number; rawUsd: number; totalTokens: number }> {
  const key = sessionKey(projectId, options.chatSessionId)

  let session: BillingSession | null = null
  const r = redisOrNull()
  if (r) {
    try {
      session = await withRedisTimeout(popSessionRedis(r, projectId, options.chatSessionId))
    } catch (err) {
      console.warn(`[BillingSession] Redis closeSession failed, falling back to local map:`, (err as Error).message)
    }
  }
  if (!session) {
    session = popSessionLocal(projectId, options.chatSessionId)
  }

  if (!session) {
    return { billedUsd: 0, rawUsd: 0, totalTokens: 0 }
  }

  let totalTokens = session.inputTokens + session.cachedInputTokens + session.cacheWriteTokens + session.outputTokens
  let usedStreamFallback = false

  if (
    totalTokens === 0 &&
    session.imageBilledUsd === 0 &&
    options.fallbackUsage &&
    !options.discardPartial &&
    !options.bookkeeping
  ) {
    const fb = options.fallbackUsage
    const fbInput = fb.inputTokens || 0
    const fbOutput = fb.outputTokens || 0
    const fbCachedInput = fb.cachedInputTokens || 0
    const fbCacheWrite = fb.cacheWriteTokens || 0
    const fbTotal = fbInput + fbOutput + fbCachedInput + fbCacheWrite
    if (fbTotal > 0) {
      session.inputTokens = fbInput
      session.outputTokens = fbOutput
      session.cachedInputTokens = fbCachedInput
      session.cacheWriteTokens = fbCacheWrite
      if (fb.model) session.model = fb.model
      totalTokens = fbTotal
      usedStreamFallback = true
      console.warn(
        `[BillingSession] Zero accumulated tokens for ${key} but the stream reported ${fbTotal} — ` +
        `using stream-reported usage instead of a false zero-token failure (likely cross-pod ` +
        `fragmentation during a Redis outage, or another accumulation gap; this is a canary — ` +
        `investigate if it fires often).`
      )
    }
  }

  if (totalTokens === 0 && session.imageBilledUsd === 0) {
    // Do not bill, but still record a metrics row so turns that die before
    // the LLM (pod unreachable, 402, stream abort with no tokens) are
    // countable. Skipping this made silent dropped turns invisible in
    // agent_cost_metrics.
    //
    // Two closes are deliberately silent:
    //   - `discardPartial` — the stream EOF'd before turn-complete, but the
    //     client reconnects and the turn finishes on a later request.
    //   - `bookkeeping` — session-map maintenance (an overwrite in
    //     `openSession`), not a turn ending at all.
    if (!options.discardPartial && !options.bookkeeping) {
      const durationMs = Date.now() - session.openedAt
      console.warn(
        `[BillingSession] Zero-token close for ${key} (turn died before LLM)` +
          `${session.chatSessionId ? ` chatSessionId=${session.chatSessionId}` : ''}`,
      )
      void recordAgentCostMetric({
        workspaceId: session.workspaceId,
        projectId: session.projectId,
        // NOT `main-chat`: the model never ran, so this must not land in the
        // per-model quality windows the recommendation gate reads, and must
        // not be attributed to an active A/B experiment for `main-chat`
        // (`maybeRecordExperimentRun` matches on agentType + model). A
        // distinct type keeps the failure countable without blaming a model
        // for an infrastructure fault. `session.model` is still recorded for
        // triage — it defaults to `sonnet` when the turn died pre-LLM.
        agentType: FAILED_TURN_AGENT_TYPE,
        model: session.model,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        toolCalls: 0,
        creditCost: 0,
        wallTimeMs: durationMs,
        success: false,
        hitMaxTurns: false,
        loopDetected: false,
        escalated: false,
        responseEmpty: true,
        metadata: {
          ...(session.chatSessionId ? { chatSessionId: session.chatSessionId } : {}),
          earlyFailure: true,
          reason: 'zero_tokens',
        },
      }).catch((err) => {
        console.warn('[BillingSession] Failed to record zero-token cost metric:', err?.message ?? err)
      })
    }
    return { billedUsd: 0, rawUsd: 0, totalTokens: 0 }
  }

  if (options.discardPartial) {
    console.log(
      `[BillingSession] Discarded partial session for ${key} ` +
      `(stream EOF'd before turn-complete) — ${session.inputTokens} in, ${session.outputTokens} out, ` +
      `${session.requestCount} request(s), ${session.imageGenerationCount} image(s) NOT charged.`
    )
    return { billedUsd: 0, rawUsd: 0, totalTokens }
  }

  const billingModel = proxyModelToBillingModel(session.model)
  // Bill on the *real* model id, not the collapsed `billingModel` bucket.
  // `calculateUsageCost` prefers a DB-defined model's own per-token pricing
  // (custom providers, admin-added models like "Hoshi 1.0" / mimo-v2.5) and
  // only falls back to the static family bucket for catalog models. Passing
  // `billingModel` here defeated that lookup and billed every DB model at the
  // `sonnet` bucket (the `getModelBillingModel` default for unknown ids).
  const tokenCost = calculateUsageCost(
    session.inputTokens, session.outputTokens, session.model,
    session.cachedInputTokens, session.cacheWriteTokens,
  )
  const rawUsd = tokenCost.rawUsd + session.imageRawUsd
  const billedUsd = tokenCost.billedUsd + session.imageBilledUsd
  const durationMs = Date.now() - session.openedAt
  const finalQuality = session.quality

  // Always record cost metrics, even if billing fails (e.g. no subscription/credits).
  // Fire-and-forget so a slow analytics DB does not tax the chat close path.
  //
  // Pass `creditCost: 0` and let `recordAgentCostMetric` recompute from tokens
  // server-side. We could pass `billedUsd` here, but this path runs before any
  // markup adjustment is finalized — using the canonical token→cost catalog
  // keeps analytics consistent with the catalog displayed in the UI.
  void recordAgentCostMetric({
    workspaceId: session.workspaceId,
    projectId: session.projectId,
    agentType: 'main-chat',
    // Record the real model id so the analytics recompute path
    // (`serverComputeCreditCost`) honors DB-defined per-token pricing too,
    // keeping cost analytics consistent with the wallet debit above.
    model: session.model,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    cachedInputTokens: session.cachedInputTokens,
    toolCalls: session.requestCount,
    creditCost: 0,
    wallTimeMs: durationMs,
    success: finalQuality.success === true,
    hitMaxTurns: finalQuality.hitMaxTurns ?? false,
    loopDetected: finalQuality.loopDetected ?? false,
    escalated: finalQuality.escalated ?? false,
    responseEmpty: finalQuality.responseEmpty ?? false,
    metadata: (session.chatSessionId || usedStreamFallback)
      ? {
          ...(session.chatSessionId ? { chatSessionId: session.chatSessionId } : {}),
          ...(usedStreamFallback ? { usageSource: 'stream-fallback' } : {}),
        }
      : undefined,
  }).catch((err) => {
    console.warn('[BillingSession] Failed to record main-chat cost metric:', err?.message ?? err)
  })

  try {
    const result = await billingService.consumeUsage({
      workspaceId: session.workspaceId,
      projectId: session.projectId,
      memberId: session.userId,
      actionType: 'chat_message',
      rawUsd,
      billedUsd,
      actionMetadata: {
        inputTokens: session.inputTokens,
        cachedInputTokens: session.cachedInputTokens,
        cacheWriteTokens: session.cacheWriteTokens,
        outputTokens: session.outputTokens,
        totalTokens,
        model: session.model,
        billingModel,
        rawUsd,
        tokenRawUsd: tokenCost.rawUsd,
        tokenBilledUsd: tokenCost.billedUsd,
        requestCount: session.requestCount,
        imageGenerationCount: session.imageGenerationCount,
        imageRawUsd: session.imageRawUsd,
        imageBilledUsd: session.imageBilledUsd,
        imageModels: session.imageModels,
        durationMs,
        ...(session.chatSessionId ? { chatSessionId: session.chatSessionId } : {}),
        ...(usedStreamFallback ? { usageSource: 'stream-fallback' } : {}),
      },
    })

    if (result.success) {
      console.log(
        `[BillingSession] Charged $${billedUsd.toFixed(4)} (raw $${rawUsd.toFixed(4)}) — ${session.inputTokens} in, ${session.cacheWriteTokens} cache-write, ${session.cachedInputTokens} cache-read, ${session.outputTokens} out (${totalTokens} total across ${session.requestCount} requests, model: ${billingModel}), ${session.imageGenerationCount} images $${session.imageBilledUsd.toFixed(4)} — remaining included: $${result.remainingIncludedUsd?.toFixed(4)}`
      )
    } else {
      console.warn(`[BillingSession] Could not charge usage: ${result.error}`)
    }
  } catch (err) {
    // P2003 = FK violation on the UsageEvent insert, which here means the
    // project (or workspace) was deleted before the session closed. There is
    // nothing to charge and nothing to fix, so don't log it as an error with a
    // full Prisma stack — that noise is what a single project delete produced.
    if ((err as any)?.code === 'P2003') {
      console.warn(`[BillingSession] Skipping usage charge for ${key}: project/workspace no longer exists`)
    } else {
      console.error(`[BillingSession] Failed to charge usage for ${key}:`, err)
    }
  }

  return { billedUsd, rawUsd, totalTokens }
}
