// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The admission queue for channel agent replies.
 *
 * A slot means "an agent is actively working", not "a turn exists". A run that
 * is only blocked in `wait`, `exec_wait`, `agent_result`, a subagent or a slow
 * `exec` parks (gives its slot back) and the next tagged message starts; the
 * parked run unparks on its next content frame and re-takes a slot without
 * waiting in line. So a workspace full of CI waits no longer starves tags.
 *
 * One queue, two backends behind the same interface:
 *   - in-process, for desktop and any Redis-less dev server;
 *   - Redis, for the cloud, where waiters live in a ZSET scored by enqueue time
 *     so admission is FIFO across pods. Every entry carries a short lease the
 *     owning pod renews, so a pod that dies frees its slots and its waiters in
 *     about a lease instead of the old two hours.
 *
 * Positions and counts are published on the conversation bus as
 * `agent.capacity` (workspace) and `agent.delta` with `queue` (per reply), so
 * the thread's "Queued · #n in line" and the limit banner are live.
 */

import type Redis from 'ioredis'
import { getSharedRedis } from '../lib/tunnel-redis'
import { resolveAgentReplyCapacity } from './agent-reply-capacity'

type SlotRedis = Pick<Redis, 'eval' | 'zrem' | 'zadd'>

let redisOverride: SlotRedis | null | undefined

/** Test hook: swap the Redis client (null forces the in-process queue). */
export function _setAgentReplySlotsRedisForTests(redis: SlotRedis | null | undefined): void {
  redisOverride = redis
}

function redis(): SlotRedis | null {
  return redisOverride !== undefined ? redisOverride : (getSharedRedis() as SlotRedis | null)
}

/** A held slot is renewed this often, so a dead pod's slot frees in about one lease. */
const HOLDER_LEASE_MS = 120_000
const RENEW_MS = 30_000
/** How often a waiter asks to be admitted. */
const ADMISSION_POLL_MS = 300
/** One publish per workspace per second is as live as a queue needs to read. */
const EVENT_THROTTLE_MS = 1_000

export type AgentReplySlotState = 'queued' | 'running' | 'waiting'

/** Where a waiting run stands. */
export interface QueuedPosition {
  /** 1 is next in line. */
  position: number
  ahead: number
  running: number
  limit: number
}

export interface AgentReplySlot {
  /** Resolves when the slot is held; rejects if the run is stopped while waiting. */
  acquired: Promise<void>
  state(): AgentReplySlotState
  /** Where this run sits in line, or null when it is not waiting. */
  position(): number | null
  /** Give the slot back while the run is only waiting on something. */
  park(): void
  /** Take a slot back after parking: ahead of the queue, and allowed over the limit. */
  unpark(): void
  release(): void
}

export interface SlotSnapshot {
  limit: number
  /** Runs holding a slot (working). */
  running: number
  /** Runs parked (waiting on a tool); they hold no slot. */
  parked: number
  /** Runs waiting for a slot. */
  queued: number
  /** Waiting runs this pod knows about, and their 1-based place in line. */
  positions: Map<string, number>
}

// ─── Per-pod bookkeeping, shared by both backends ────────────────────────────

interface LocalWaiter {
  runId: string
  /** Take a slot: the same move the run makes when it is admitted on arrival. */
  admit: () => void
}

interface LocalBook {
  /** runId → parked? */
  holders: Map<string, { parked: boolean }>
  waiters: LocalWaiter[]
}

const books = new Map<string, LocalBook>()
/** runId → conversation, so a queue move can be published to the right thread. */
const replyConversations = new Map<string, string | null>()
/** runIds this pod is watching in a workspace's queue. */
const localRunIds = new Map<string, Set<string>>()
/** runId → state, for runs this pod owns on the Redis backend (holders live in Redis, not `books`). */
const redisRunStates = new Map<string, AgentReplySlotState>()

function book(workspaceId: string): LocalBook {
  let b = books.get(workspaceId)
  if (!b) {
    b = { holders: new Map(), waiters: [] }
    books.set(workspaceId, b)
  }
  return b
}

/** Holders that are working, not parked. */
function activeCount(b: LocalBook): number {
  let n = 0
  for (const holder of b.holders.values()) if (!holder.parked) n++
  return n
}

function abortError(): Error {
  const err = new Error('The run was stopped before it started')
  err.name = 'AbortError'
  return err
}

function trackRun(workspaceId: string, runId: string): void {
  let set = localRunIds.get(workspaceId)
  if (!set) {
    set = new Set()
    localRunIds.set(workspaceId, set)
  }
  set.add(runId)
}

function untrackRun(workspaceId: string, runId: string): void {
  localRunIds.get(workspaceId)?.delete(runId)
  replyConversations.delete(runId)
  redisRunStates.delete(runId)
}

// ─── Live queue events ───────────────────────────────────────────────────────

const pendingPublish = new Map<string, ReturnType<typeof setTimeout> | null>()
const lastPublish = new Map<string, number>()

/** Tell the thread and the banner that the queue moved. Throttled to 1/s per workspace. */
function notifyChange(workspaceId: string): void {
  if (pendingPublish.get(workspaceId)) return
  const since = Date.now() - (lastPublish.get(workspaceId) ?? 0)
  const timer = setTimeout(() => {
    pendingPublish.delete(workspaceId)
    lastPublish.set(workspaceId, Date.now())
    void publishSnapshot(workspaceId).catch((err: Error) => {
      console.warn('[AgentSlots] publishing the queue failed:', err.message)
    })
  }, Math.max(0, EVENT_THROTTLE_MS - since))
  ;(timer as any).unref?.()
  pendingPublish.set(workspaceId, timer)
}

async function publishSnapshot(workspaceId: string): Promise<void> {
  const snapshot = await slotSnapshot(workspaceId)
  const { publishConversationEvent } = await import('../lib/conversation-bus')
  publishConversationEvent(workspaceId, {
    type: 'agent.capacity',
    workspaceId,
    limit: snapshot.limit,
    running: snapshot.running,
    parked: snapshot.parked,
    queued: snapshot.queued,
  })
  for (const [runId, position] of snapshot.positions) {
    const conversationId = replyConversations.get(runId)
    if (!conversationId) continue
    publishConversationEvent(workspaceId, {
      type: 'agent.delta',
      conversationId,
      messageId: runId,
      text: '',
      tool: null,
      queue: { position, ahead: Math.max(0, position - 1), running: snapshot.running, limit: snapshot.limit },
    })
  }
}

/** The live queue for a workspace: counts, the limit in force, and known positions. */
export async function slotSnapshot(workspaceId: string): Promise<SlotSnapshot> {
  const limit = (await resolveAgentReplyCapacity(workspaceId).catch(() => null))?.limit ?? 1
  const b = book(workspaceId)
  const parked = [...b.holders.values()].filter((h) => h.parked).length
  const client = redis()
  if (!client) {
    const positions = new Map<string, number>()
    b.waiters.forEach((w, i) => positions.set(w.runId, i + 1))
    return { limit, running: activeCount(b), parked, queued: b.waiters.length, positions }
  }
  const watching = [...(localRunIds.get(workspaceId) ?? [])]
  const [running, queued, positions] = await Promise.all([
    countKey(client, holdersKey(workspaceId)),
    countWaiters(client, workspaceId),
    ranksOf(client, workspaceId, watching),
  ])
  return { limit, running, parked, queued, positions }
}

/** How a run is doing in the queue, for `agent_runs_list` and the thread's status. */
export async function agentReplySlotState(
  workspaceId: string,
  runId: string,
): Promise<{ state: AgentReplySlotState; position: number | null }> {
  const b = books.get(workspaceId)
  const holder = b?.holders.get(runId)
  if (holder) return { state: holder.parked ? 'waiting' : 'running', position: null }
  const client = redis()
  if (!client) {
    const i = b?.waiters.findIndex((w) => w.runId === runId) ?? -1
    return i >= 0 ? { state: 'queued', position: i + 1 } : { state: 'running', position: null }
  }
  const known = redisRunStates.get(runId)
  if (known && known !== 'queued') return { state: known, position: null }
  const positions = await ranksOf(client, workspaceId, [runId])
  const rank = positions.get(runId) ?? null
  // A run the queue has no record of is not waiting in it. Saying 'queued'
  // would leave an orphaned running row (a restart, a lost book) reading
  // "Queued · —" for as long as the row lives.
  return rank ? { state: 'queued', position: rank } : { state: 'running', position: null }
}

// ─── Redis keys and scripts ──────────────────────────────────────────────────

const waitersKey = (workspaceId: string) => `chat:slotq:${workspaceId}`
const aliveKey = (workspaceId: string) => `chat:slotq:${workspaceId}:alive`
const holdersKey = (workspaceId: string) => `chat:slots:${workspaceId}`

/**
 * One admission tick: drop expired holders and dead waiters, renew our own
 * waiter lease, admit from the head of the queue while there is room, then
 * report whether we hold a slot and where we stand.
 */
const TICK = `
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local lease = tonumber(ARGV[3])
local me = ARGV[4]
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
local ids = redis.call('ZRANGE', KEYS[1], 0, -1)
for i = 1, #ids do
  local exp = redis.call('ZSCORE', KEYS[2], ids[i])
  if (not exp) or tonumber(exp) < now then
    redis.call('ZREM', KEYS[1], ids[i])
    redis.call('ZREM', KEYS[2], ids[i])
  end
end
if redis.call('ZSCORE', KEYS[1], me) then
  redis.call('ZADD', KEYS[2], now + lease, me)
end
local running = redis.call('ZCARD', KEYS[3])
while running < limit do
  local head = redis.call('ZRANGE', KEYS[1], 0, 0)
  if #head == 0 then break end
  redis.call('ZREM', KEYS[1], head[1])
  redis.call('ZREM', KEYS[2], head[1])
  redis.call('ZADD', KEYS[3], now + lease, head[1])
  running = running + 1
end
local held = redis.call('ZSCORE', KEYS[3], me)
local rank = redis.call('ZRANK', KEYS[1], me)
return {(held and 1) or 0, rank or -1, running, redis.call('ZCARD', KEYS[1])}`

const RENEW = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
  return 1
end
return 0`

const RANKS = `
local out = {}
for i = 1, #ARGV do
  local rank = redis.call('ZRANK', KEYS[1], ARGV[i])
  if rank then out[i] = rank + 1 else out[i] = 0 end
end
return out`

/** Live members of a holder/waiting ZSET: expired entries are dropped first. */
async function countKey(client: SlotRedis, key: string): Promise<number> {
  const n = await client
    .eval(`redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
return redis.call('ZCARD', KEYS[1])`, 1, key, String(Date.now()))
    .catch(() => 0)
  return Number(n) || 0
}

/**
 * Waiters whose pod is still alive. The waiters ZSET is scored by enqueue time
 * (that is the FIFO order), so it cannot be pruned by score the way holders can:
 * liveness lives in the parallel `alive` ZSET whose score *is* a lease. Counting
 * the queue by score would delete the whole line every time someone looked at it.
 */
const COUNT_WAITERS = `
local now = tonumber(ARGV[1])
local n = 0
local ids = redis.call('ZRANGE', KEYS[1], 0, -1)
for i = 1, #ids do
  local exp = redis.call('ZSCORE', KEYS[2], ids[i])
  if exp and tonumber(exp) >= now then
    n = n + 1
  else
    redis.call('ZREM', KEYS[1], ids[i])
    redis.call('ZREM', KEYS[2], ids[i])
  end
end
return n`

async function countWaiters(client: SlotRedis, workspaceId: string): Promise<number> {
  const n = await client
    .eval(COUNT_WAITERS, 2, waitersKey(workspaceId), aliveKey(workspaceId), String(Date.now()))
    .catch(() => 0)
  return Number(n) || 0
}

async function ranksOf(client: SlotRedis, workspaceId: string, runIds: string[]): Promise<Map<string, number>> {
  const positions = new Map<string, number>()
  if (!runIds.length) return positions
  const raw = await client.eval(RANKS, 1, waitersKey(workspaceId), ...runIds).catch(() => null)
  if (!Array.isArray(raw)) return positions
  runIds.forEach((runId, i) => {
    const rank = Number((raw as unknown[])[i]) || 0
    if (rank > 0) positions.set(runId, rank)
  })
  return positions
}

// ─── The queue ───────────────────────────────────────────────────────────────

/**
 * Admit local waiters while there is room. The limit is read fresh every time,
 * so a workspace whose limit was just raised drains without a restart.
 */
async function admitLocalWaiters(workspaceId: string): Promise<void> {
  const b = book(workspaceId)
  if (!b.waiters.length) return
  const limit = (await resolveAgentReplyCapacity(workspaceId).catch(() => null))?.limit ?? 1
  while (b.waiters.length && activeCount(b) < limit) {
    b.waiters.shift()!.admit()
  }
  notifyChange(workspaceId)
}

/**
 * Re-check the limit and admit whoever fits now. Called after the limit changes:
 * without it a local waiter would sit until some other run released its slot,
 * which is exactly the "change applies to the next admission" gap AC8 names.
 * Redis waiters do this themselves on their admission poll.
 */
export async function drainAgentReplyWaiters(workspaceId: string): Promise<void> {
  if (redis()) return
  await admitLocalWaiters(workspaceId)
}

export interface EnqueueAgentReplySlotInput {
  workspaceId: string
  /** The reply's message id: what the thread and the agent tools call the run. */
  runId: string
  conversationId?: string | null
  signal?: AbortSignal
}

/** A queued slot plus the promise that settles once it is known to be queued or admitted. */
interface SlotJoin {
  slot: AgentReplySlot
  ready: Promise<void>
}

/**
 * Join the workspace's queue for one agent-reply slot. A run with room is
 * admitted at once; otherwise its handle's `acquired` settles when it gets in.
 * By the time this resolves, `state()` is already `queued` or `running`, which
 * is what decides whether the reply needs its "Queued" placeholder.
 */
export async function enqueueAgentReplySlot(input: EnqueueAgentReplySlotInput): Promise<AgentReplySlot> {
  trackRun(input.workspaceId, input.runId)
  replyConversations.set(input.runId, input.conversationId ?? null)
  const client = redis()
  const { slot, ready } = client ? redisSlot(client, input) : localSlot(input)
  await ready.catch(() => {})
  notifyChange(input.workspaceId)
  return slot
}

function localSlot(input: EnqueueAgentReplySlotInput): SlotJoin {
  const { workspaceId, runId, signal } = input
  const b = book(workspaceId)
  let state: AgentReplySlotState = 'queued'
  let released = false
  let acquiredResolve!: () => void
  let acquiredReject!: (err: unknown) => void
  const acquired = new Promise<void>((resolve, reject) => {
    acquiredResolve = resolve
    acquiredReject = reject
  })
  // A stopped run nobody awaits must not surface as an unhandled rejection.
  acquired.catch(() => {})
  let readyResolve!: () => void
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve
  })

  const detach = () => signal?.removeEventListener('abort', onAbort)

  const take = () => {
    b.holders.set(runId, { parked: false })
    state = 'running'
    acquiredResolve()
    notifyChange(workspaceId)
  }

  const settle = () => {
    released = true
    const i = b.waiters.findIndex((w) => w.runId === runId)
    if (i >= 0) b.waiters.splice(i, 1)
    detach()
    untrackRun(workspaceId, runId)
    notifyChange(workspaceId)
    void pump()
  }

  function onAbort(): void {
    if (released) return
    const waiting = state === 'queued'
    settle()
    if (waiting) acquiredReject(abortError())
    b.holders.delete(runId)
  }

  const pump = () => admitLocalWaiters(workspaceId)

  if (signal?.aborted) {
    released = true
    untrackRun(workspaceId, runId)
    acquiredReject(abortError())
    readyResolve()
  } else {
    signal?.addEventListener('abort', onAbort, { once: true })
    // Admission is async because the limit is: ask for it before queueing.
    void resolveAgentReplyCapacity(workspaceId)
      .then(({ limit }) => {
        if (released || state !== 'queued') return
        if (activeCount(b) < limit) {
          take()
          return
        }
        b.waiters.push({ runId, admit: take })
        notifyChange(workspaceId)
      })
      .catch(() => {
        // A capacity lookup that fails must not strand the run: admit it.
        if (released || state !== 'queued') return
        take()
      })
      .finally(readyResolve)
  }

  return {
    slot: {
    acquired,
    state: () => state,
    position: () => {
      if (state !== 'queued') return null
      const i = b.waiters.findIndex((w) => w.runId === runId)
      return i >= 0 ? i + 1 : null
    },
    park: () => {
      const holder = b.holders.get(runId)
      if (!holder || holder.parked || released) return
      holder.parked = true
      state = 'waiting'
      notifyChange(workspaceId)
      void pump()
    },
    unpark: () => {
      const holder = b.holders.get(runId)
      if (!holder || released) return
      // Allowed over the limit: the runtime turn is already generating and cannot pause.
      holder.parked = false
      state = 'running'
      notifyChange(workspaceId)
    },
    release: () => {
      if (released) return
      const wasWaiting = state === 'queued'
      settle()
      b.holders.delete(runId)
      if (wasWaiting) acquiredReject(abortError())
    },
    },
    ready,
  }
}

function redisSlot(client: SlotRedis, input: EnqueueAgentReplySlotInput): SlotJoin {
  const { workspaceId, runId, signal } = input
  let state: AgentReplySlotState = 'queued'
  let released = false
  let poll: ReturnType<typeof setInterval> | null = null
  let renew: ReturnType<typeof setInterval> | null = null
  let rank: number | null = null
  let acquiredResolve!: () => void
  let acquiredReject!: (err: unknown) => void
  const acquired = new Promise<void>((resolve, reject) => {
    acquiredResolve = resolve
    acquiredReject = reject
  })
  acquired.catch(() => {})

  const stopPoll = () => {
    if (poll) clearInterval(poll)
    poll = null
  }
  const stopRenew = () => {
    if (renew) clearInterval(renew)
    renew = null
  }
  const startRenew = () => {
    if (renew) return
    renew = setInterval(() => {
      void client.eval(RENEW, 1, holdersKey(workspaceId), runId, String(Date.now() + HOLDER_LEASE_MS)).catch(() => {})
    }, RENEW_MS)
    ;(renew as any).unref?.()
  }

  const take = () => {
    state = 'running'
    redisRunStates.set(runId, 'running')
    rank = null
    stopPoll()
    startRenew()
    acquiredResolve()
    notifyChange(workspaceId)
  }

  const tick = async () => {
    if (released || state !== 'queued') return
    const limit = (await resolveAgentReplyCapacity(workspaceId).catch(() => null))?.limit ?? 1
    const out = await client
      .eval(
        TICK,
        3,
        waitersKey(workspaceId),
        aliveKey(workspaceId),
        holdersKey(workspaceId),
        String(Date.now()),
        String(limit),
        String(HOLDER_LEASE_MS),
        runId,
      )
      .catch(() => null)
    if (!out || released || state !== 'queued') return
    const [held, rawRank] = out as [number, number, number, number]
    if (held) return take()
    // TICK reports a zero-based ZRANK (-1 when absent); the thread says "#1".
    const next = Number(rawRank) >= 0 ? Number(rawRank) + 1 : null
    if (next !== rank) {
      rank = next
      notifyChange(workspaceId)
    }
  }

  const drop = () =>
    client
      .eval(
        `redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])`,
        3,
        waitersKey(workspaceId),
        aliveKey(workspaceId),
        holdersKey(workspaceId),
        runId,
      )
      .catch(() => {})

  const onAbort = () => {
    if (released) return
    const waiting = state === 'queued'
    released = true
    stopPoll()
    stopRenew()
    untrackRun(workspaceId, runId)
    if (waiting) acquiredReject(abortError())
    void drop().then(() => notifyChange(workspaceId))
  }

  let readyResolve!: () => void
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve
  })

  if (signal?.aborted) {
    released = true
    untrackRun(workspaceId, runId)
    acquiredReject(abortError())
    readyResolve()
  } else {
    signal?.addEventListener('abort', onAbort, { once: true })
    // Join the queue, then ask to be admitted until a slot is free. The waiter
    // is scored by enqueue time (that is the FIFO order); its liveness entry is
    // a lease, so it must be born in the future — an expired one would be swept
    // by the very next tick, taking the run out of the line it just joined.
    const joinedAt = Date.now()
    void client
      .eval(
        `redis.call('ZADD', KEYS[1], 'NX', ARGV[1], ARGV[3])
redis.call('ZADD', KEYS[2], 'NX', ARGV[2], ARGV[3])`,
        2,
        waitersKey(workspaceId),
        aliveKey(workspaceId),
        String(joinedAt),
        String(joinedAt + HOLDER_LEASE_MS),
        runId,
      )
      .catch(() => {})
      .then(async () => {
        await tick()
        if (released || state !== 'queued') return
        poll = setInterval(() => void tick(), ADMISSION_POLL_MS)
        ;(poll as any).unref?.()
      })
      .finally(readyResolve)
  }

  return {
    slot: {
      acquired,
      state: () => state,
      position: () => (state === 'queued' ? rank : null),
      park: () => {
        if (released || state !== 'running') return
        state = 'waiting'
        redisRunStates.set(runId, 'waiting')
        stopRenew()
        void client.zrem(holdersKey(workspaceId), runId).catch(() => {})
        notifyChange(workspaceId)
      },
      unpark: () => {
        if (released || state !== 'waiting') return
        state = 'running'
        redisRunStates.set(runId, 'running')
        // Ahead of the queue and allowed over the limit: the turn is already generating.
        void client.zadd(holdersKey(workspaceId), Date.now() + HOLDER_LEASE_MS, runId).catch(() => {})
        startRenew()
        notifyChange(workspaceId)
      },
      release: () => {
        if (released) return
        const waiting = state === 'queued'
        released = true
        signal?.removeEventListener('abort', onAbort)
        stopPoll()
        stopRenew()
        untrackRun(workspaceId, runId)
        if (waiting) acquiredReject(abortError())
        void drop().then(() => notifyChange(workspaceId))
      },
    },
    ready,
  }
}

/** Test hook: forget every queue, position and pending publish. */
export function _resetAgentReplySlotsForTests(): void {
  for (const timer of pendingPublish.values()) if (timer) clearTimeout(timer)
  pendingPublish.clear()
  lastPublish.clear()
  books.clear()
  localRunIds.clear()
  redisRunStates.clear()
  replyConversations.clear()
  redisOverride = undefined
}
