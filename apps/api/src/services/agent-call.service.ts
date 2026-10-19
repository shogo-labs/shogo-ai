// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Invoke a project's agent-runtime pod for one turn, outside of any chat
 * session. Two callers:
 *
 *   - `POST /api/internal/projects/:id/agent-call` (`apps/api/src/routes/
 *     internal.ts`) — backs the `project_call` tool (`project-tools.ts`).
 *     The route authenticates the caller against a runtime token first,
 *     then calls `callProjectAgent` with the workspace it already proved.
 *   - GitHub webhook handlers (`github.service.ts`) — `issues` /
 *     `issue_comment` / `pull_request_review` / `pull_request_review_comment`
 *     events wake the connected project's agent the same way a sibling
 *     project would via `project_call`. The API is the caller here (not an
 *     external runtime token holder), so it already knows `workspaceId`
 *     from a trusted `GitHubConnection` → `Project` lookup and skips the
 *     token-auth step.
 *
 * Resolves the target the same way the public agent-proxy does (pinned
 * Instance tunnel first, then cloud pod / host runtime) and forwards to the
 * runtime's `/agent/pipeline/call`, which is guarded by the runtime token
 * alone — workspace runtimes are never given a `WEBHOOK_TOKEN`, so the
 * external `/agent/hooks/*` path can't be reused here.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from 'hono'
import { PROJECT_CALL_MESSAGE_AGENT, runChatSessionId } from '@shogo/shared-runtime/project-call-chat'
import { linkAgentCallSession, putAgentCall, type AgentCallSessionLink } from '../lib/agent-call-store'
import type { TrackedStreamResult } from '../routes/project-chat'

export { runChatSessionId } from '@shogo/shared-runtime/project-call-chat'

export interface AgentCallRequest {
  message: string
  /** Pipeline correlation id, threaded into the callee's AgentCostMetric.metadata. */
  runId?: string
  /** Callee session key. Defaults to `run:<runId>` when a runId is given. */
  sessionId?: string
  /** Block for the reply (default true). */
  wait?: boolean
  /** Reply timeout in ms when waiting (default 5 min, max 20 min). */
  timeoutMs?: number
  /** With `wait: false`, record the outcome so `GET .../agent-call/:runId` can poll it. */
  track?: boolean
  callerProjectId?: string
  /** Signed requester ticket for the callee, so it can act as the person behind the call. */
  requesterTicket?: string
}

export interface AgentCallOutcome {
  status: number
  body: any
}

/**
 * `wait=true` blocks for the reply (bounded by `timeoutMs`, default 5 min,
 * max 20 min); otherwise the runtime acks with 202 and the turn runs in the
 * background. Never throws — failures come back as a `4xx`/`5xx` outcome so
 * callers (an HTTP route, or a webhook handler that must still ack GitHub)
 * can decide how to surface it.
 */
export async function callProjectAgent(
  c: Context,
  projectId: string,
  workspaceId: string,
  req: AgentCallRequest,
): Promise<AgentCallOutcome> {
  if (!req.message || !req.message.trim()) {
    return { status: 400, body: { error: { code: 'bad_request', message: 'message is required' } } }
  }
  const wait = req.wait !== false
  const timeoutMs = Math.min(Math.max(req.timeoutMs ?? 5 * 60_000, 10_000), 20 * 60_000)

  const forwardBody = JSON.stringify({
    message: req.message,
    runId: req.runId,
    sessionId: req.sessionId,
    wait,
    callerProjectId: req.callerProjectId,
  })

  return forwardToProjectRuntime(c, projectId, workspaceId, '/agent/pipeline/call', forwardBody, {
    ...(req.requesterTicket ? { headers: { 'X-Requester-Ticket': req.requesterTicket } } : {}),
    timeoutMs: wait ? timeoutMs + 5_000 : 15_000,
    timeoutMessage: `The target agent did not reply within ${Math.round(timeoutMs / 1000)}s. Re-issue with wait=false and poll, or raise timeoutMs.`,
  })
}

// ---------------------------------------------------------------------------
// Chat persistence for project_call
// ---------------------------------------------------------------------------

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

let dbOverride: any = null

/** Test seam: replace the Prisma client used to record call chats. */
export function setCallChatDb(db: any | null): void {
  dbOverride = db
}

async function callChatDb(): Promise<any> {
  if (dbOverride) return dbOverride
  const { prisma } = await import('../lib/prisma')
  return prisma as any
}

async function ensureCallSession(
  projectId: string,
  sessionId: string,
  name: string,
  message: string,
  runId: string,
): Promise<boolean> {
  try {
    const db = await callChatDb()
    const label = oneLine(`${name}: ${message}`, 120)
    await db.chatSession.upsert({
      where: { id: sessionId },
      update: { lastActiveAt: new Date() },
      create: { id: sessionId, inferredName: label, contextType: 'project', contextId: projectId },
    })
    await db.chatMessage.create({
      data: {
        sessionId,
        role: 'user',
        content: message,
        // The marker lets an open chat keep watching for the call's turn.
        parts: JSON.stringify([
          { type: 'text', text: message },
          { type: 'data-project-call', data: { runId, callerName: name } },
        ]),
        // Not 'technical': funnels treat that pair (role user + agent technical)
        // as a person. The list hook still returns this row in the technical thread.
        agent: PROJECT_CALL_MESSAGE_AGENT,
      },
    })
    await db.chatSession.update({
      where: { id: sessionId },
      data: { cachedMessageCount: { increment: 1 } },
    }).catch(() => {})
    return true
  } catch (err: any) {
    console.warn('[AgentCall] could not persist call chat:', err?.message ?? err)
    return false
  }
}

async function saveCallReply(sessionId: string, reply: string): Promise<void> {
  try {
    const db = await callChatDb()
    await db.chatMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        content: reply,
        parts: JSON.stringify([{ type: 'text', text: reply }]),
        agent: 'technical',
      },
    })
    await db.chatSession.update({
      where: { id: sessionId },
      data: { lastActiveAt: new Date(), cachedMessageCount: { increment: 1 } },
    })
  } catch (err: any) {
    console.warn('[AgentCall] could not save call reply:', err?.message ?? err)
  }
}

/**
 * Whether the call chat already ends with an assistant row for its newest
 * `project_call` prompt. This is the one idempotence gate for every writer of
 * a call reply (the stream tracker, the settle fallback, and the list hook's
 * reconcile), so one turn can never land twice.
 */
async function callReplyAlreadySaved(sessionId: string): Promise<boolean> {
  try {
    const db = await callChatDb()
    const findFirst = db?.chatMessage?.findFirst
    const count = db?.chatMessage?.count
    // A test/fake client without these can't be asked; assume nothing was saved.
    if (typeof findFirst !== 'function' || typeof count !== 'function') return false
    const prompt = await findFirst({
      where: { sessionId, role: 'user', agent: PROJECT_CALL_MESSAGE_AGENT },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    if (!prompt) return true
    const replies = await count({
      where: { sessionId, role: 'assistant', agent: 'technical', createdAt: { gte: prompt.createdAt } },
    })
    return replies > 0
  } catch (err: any) {
    console.warn('[AgentCall] could not check for an existing call reply:', err?.message ?? err)
    // Erring towards "saved" keeps a broken check from duplicating a reply.
    return true
  }
}

/** The row a call chat gets when its turn ended without any text to show. */
function noReplyRowText(status: string): string {
  return `The called agent's turn ended before its reply could be saved (${status}). The reply may still be in the caller's task result.`
}

/**
 * Terminal reply the callee runtime kept for a finished turn (Part C) — read
 * after the 30 s stream-buffer window, so a follower that missed the turn can
 * still persist what the agent said without re-running it.
 */
async function fetchTerminalTurnReply(projectId: string, chatSessionId: string): Promise<string | null> {
  try {
    const res = await fetchCalleeRuntime(projectId, `/agent/chat/${encodeURIComponent(chatSessionId)}/turn`)
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return null
    }
    const turn = (await res.json().catch(() => null)) as { status?: string; reply?: unknown } | null
    if (!turn || turn.status === 'active' || turn.status === 'unknown') return null
    return typeof turn.reply === 'string' && turn.reply.trim() ? turn.reply : null
  } catch {
    return null
  }
}

/**
 * Guarantee a finished call leaves an answer in its chat. The stream tracker
 * usually writes the assistant row itself; when it could not (empty turn, lost
 * buffer, a persist step that bailed), fall back to the text this side has,
 * then to the runtime's terminal turn record, and finally to an explicit
 * failure row — a call chat showing only the prompt is the bug.
 */
async function ensureCallReplyRow(
  projectId: string,
  chatSessionId: string,
  text: string | null,
  outcome: string,
): Promise<void> {
  try {
    if (await callReplyAlreadySaved(chatSessionId)) return
    const reply = text?.trim() ? text : await fetchTerminalTurnReply(projectId, chatSessionId)
    console.warn(
      `[AgentCall] no assistant row for ${chatSessionId} (status ${outcome}); writing ${
        reply ? 'the reply' : 'a failure row'
      }`,
    )
    await saveCallReply(chatSessionId, reply?.trim() ? reply : noReplyRowText(outcome))
  } catch (err: any) {
    console.warn('[AgentCall] could not write a fallback call reply:', err?.message ?? err)
  }
}

async function callerName(callerProjectId: string | undefined): Promise<string> {
  if (!callerProjectId) return 'Project call'
  try {
    const project = await (await callChatDb()).project.findUnique({ where: { id: callerProjectId }, select: { name: true } })
    return project?.name || 'Project call'
  } catch {
    return 'Project call'
  }
}

/**
 * Minimal stand-in for the request context, safe to use after the HTTP
 * response has been sent (the tunnel relay reads only the request signal and
 * the origin header).
 */
function detachedContext(c: Context): Context {
  const origin = typeof c?.req?.header === 'function' ? c.req.header('origin') : undefined
  return {
    req: { raw: { signal: undefined }, header: (name: string) => (name.toLowerCase() === 'origin' ? origin : undefined) },
  } as unknown as Context
}

/**
 * `callProjectAgent`, but the call is also recorded as a normal project chat
 * (one ChatSession per project + runId) so the UI can open it. The ChatSession
 * id is handed to the runtime as the session key, so the transcript the
 * runtime keeps matches the chat. Persistence failures never fail the call.
 *
 * With `wait: false` the caller gets a 202 straight away and the API follows
 * the callee's turn like any project chat (`followCallTurn`): the reply is
 * saved as it streams, with no time limit, and the turn reattach job picks it
 * up if this API pod goes away. Add `track: true` to also record the outcome
 * in the agent-call store, where `GET .../agent-call/:runId` can poll it from
 * any API replica.
 */
export async function callProjectAgentAsChat(
  c: Context,
  projectId: string,
  workspaceId: string,
  req: AgentCallRequest,
): Promise<AgentCallOutcome> {
  if (req.message && req.message.trim() && req.wait === false && req.track) {
    return startTrackedCall(c, projectId, workspaceId, req)
  }
  if (!req.message || !req.message.trim() || req.sessionId) {
    return callProjectAgent(c, projectId, workspaceId, req)
  }
  const runId = req.runId?.trim() || randomUUID()
  const chatSessionId = runChatSessionId(projectId, runId)
  const persisted = await ensureCallSession(projectId, chatSessionId, await callerName(req.callerProjectId), req.message, runId)
  if (!persisted) return callProjectAgent(c, projectId, workspaceId, { ...req, runId })

  const call = { ...req, runId, sessionId: chatSessionId }
  const withChat = (body: any) =>
    body && typeof body === 'object' && !Array.isArray(body) ? { ...body, chatSessionId } : body
  const replyOf = (outcome: AgentCallOutcome): string | null =>
    outcome.status >= 200 && outcome.status < 300 && typeof outcome.body?.reply === 'string' && outcome.body.reply.trim()
      ? outcome.body.reply
      : null

  if (req.wait === false) {
    const background = await startBackgroundCall(c, projectId, workspaceId, call, chatSessionId, null)
    if (background) {
      return background.status >= 200 && background.status < 300
        ? { status: 202, body: { status: 'accepted', runId, sessionId: chatSessionId, chatSessionId } }
        : { status: background.status, body: withChat(background.body) }
    }
    const detached = detachedContext(c)
    void callProjectAgent(detached, projectId, workspaceId, { ...call, wait: true, timeoutMs: 20 * 60_000 })
      .then(async (outcome) => {
        const reply = replyOf(outcome)
        if (reply) await saveCallReply(chatSessionId, reply)
        else console.warn(`[AgentCall] background call ${runId} ended without a reply (status ${outcome.status})`)
      })
      .catch((err) => console.warn('[AgentCall] background call failed:', err?.message ?? err))
    return { status: 202, body: { status: 'accepted', runId, sessionId: chatSessionId, chatSessionId } }
  }

  const outcome = await callProjectAgent(c, projectId, workspaceId, call)
  const reply = replyOf(outcome)
  if (reply) await saveCallReply(chatSessionId, reply)
  return { status: outcome.status, body: withChat(outcome.body) }
}

async function startTrackedCall(
  c: Context,
  projectId: string,
  workspaceId: string,
  req: AgentCallRequest,
): Promise<AgentCallOutcome> {
  const runId = req.runId?.trim() || randomUUID()
  let chatSessionId: string | undefined
  if (!req.sessionId) {
    const candidate = runChatSessionId(projectId, runId)
    if (await ensureCallSession(projectId, candidate, await callerName(req.callerProjectId), req.message, runId)) {
      chatSessionId = candidate
    }
  }
  const sessionId = req.sessionId ?? chatSessionId
  const startedAt = Date.now()
  await putAgentCall(projectId, { status: 'running', runId, sessionId, chatSessionId, startedAt, updatedAt: startedAt })
  const accepted: AgentCallOutcome = {
    status: 202,
    body: { status: 'accepted', tracked: true, runId, ...(sessionId ? { sessionId } : {}), ...(chatSessionId ? { chatSessionId } : {}) },
  }

  if (chatSessionId) {
    const link = { projectId, runId, startedAt }
    const background = await startBackgroundCall(c, projectId, workspaceId, { ...req, runId, sessionId: chatSessionId }, chatSessionId, link)
    if (background) {
      if (background.status < 200 || background.status >= 300) {
        const err = background.body?.error
        await putAgentCall(projectId, {
          status: 'failed',
          runId,
          sessionId,
          chatSessionId,
          error: {
            code: typeof err === 'object' && err ? err.code : undefined,
            message: (typeof err === 'string' ? err : err?.message) ?? `Project agent call failed (HTTP ${background.status})`,
          },
          startedAt,
          updatedAt: Date.now(),
        })
      }
      return accepted
    }
  }

  const detached = detachedContext(c)
  void callProjectAgent(detached, projectId, workspaceId, {
    ...req,
    runId,
    sessionId,
    wait: true,
    timeoutMs: 20 * 60_000,
  })
    .then(async (outcome) => {
      const ok = outcome.status >= 200 && outcome.status < 300
      const reply = ok && typeof outcome.body?.reply === 'string' ? outcome.body.reply : null
      if (reply?.trim() && chatSessionId) await saveCallReply(chatSessionId, reply)
      const err = outcome.body?.error
      await putAgentCall(projectId, {
        status: ok ? 'completed' : 'failed',
        runId,
        reply,
        sessionId: (typeof outcome.body?.sessionId === 'string' ? outcome.body.sessionId : undefined) ?? sessionId,
        chatSessionId,
        ...(ok
          ? {}
          : {
              error: {
                code: typeof err === 'object' && err ? err.code : undefined,
                message:
                  (typeof err === 'string' ? err : err?.message) ?? `Project agent call failed (HTTP ${outcome.status})`,
              },
            }),
        startedAt,
        updatedAt: Date.now(),
      })
    })
    .catch(async (err) => {
      console.warn('[AgentCall] tracked background call failed:', err?.message ?? err)
      await putAgentCall(projectId, {
        status: 'failed',
        runId,
        sessionId,
        chatSessionId,
        error: { code: 'agent_call_failed', message: err?.message ?? String(err) },
        startedAt,
        updatedAt: Date.now(),
      }).catch(() => {})
    })

  return accepted
}

// ---------------------------------------------------------------------------
// Background calls: follow the callee's turn like a project chat
// ---------------------------------------------------------------------------

/** Error code for a call whose callee turn ended without a reply this side saw. */
export const CALLEE_TURN_LOST = 'callee_turn_lost'

/** The runtime's clock and ours can disagree by this much. */
const TURN_CLOCK_SKEW_MS = 30_000

type CallTurnDeps = {
  track: typeof import('../routes/project-chat').trackUsageFromStream
  markTurnStarted: (chatSessionId: string) => Promise<string>
  markTurnEnded: (chatSessionId: string, turnId: string) => Promise<void>
  startTurnHeartbeat: (chatSessionId: string, turnId: string) => () => void
  /** How often to look for the callee's turn while it waits to start. */
  turnPollIntervalMs: number
  /** Give up on a callee turn that never starts after this long. */
  turnStartTimeoutMs: number
}

let callTurnDepsOverride: Partial<CallTurnDeps> | null = null

/** Test seam: replace the stream tracker, turn-state writes, or poll timing. */
export function setCallTurnDeps(deps: Partial<CallTurnDeps> | null): void {
  callTurnDepsOverride = deps
}

async function callTurnDeps(): Promise<CallTurnDeps> {
  const o = callTurnDepsOverride ?? {}
  const needsTurnState = !o.markTurnStarted || !o.markTurnEnded || !o.startTurnHeartbeat
  const turnState = needsTurnState ? await import('./chat-turn-state.service') : null
  return {
    track: o.track ?? (await import('../routes/project-chat')).trackUsageFromStream,
    markTurnStarted: o.markTurnStarted ?? ((id) => turnState!.markTurnStarted(id)),
    markTurnEnded: o.markTurnEnded ?? turnState!.markTurnEnded,
    startTurnHeartbeat: o.startTurnHeartbeat ?? ((id, turnId) => turnState!.startTurnHeartbeat(id, turnId)),
    turnPollIntervalMs: o.turnPollIntervalMs ?? 1_000,
    turnStartTimeoutMs: o.turnStartTimeoutMs ?? 15 * 60_000,
  }
}

type CalleeRuntime = { kind: 'url'; url: string } | { kind: 'tunnel' } | { kind: 'error'; outcome: AgentCallOutcome }

/**
 * The callee runtime's direct URL. A pinned Instance is only reachable
 * through the tunnel relay, which can't hold a long stream open.
 */
async function resolveCalleeRuntime(projectId: string): Promise<CalleeRuntime> {
  try {
    const overridden = runtimeUrlOverride ? await runtimeUrlOverride(projectId) : null
    if (overridden) return { kind: 'url', url: overridden }
    if (process.env.SHOGO_LOCAL_MODE === 'true') {
      const { resolveProjectPodUrl } = await import('../lib/resolve-pod-url')
      return { kind: 'url', url: (await resolveProjectPodUrl(projectId, { logTag: 'AgentCall' })).url }
    }
    const { resolveAgentProxyPodUrl } = await import('../lib/agent-proxy-resolver')
    const resolution = await resolveAgentProxyPodUrl(projectId, { logTag: 'AgentCall' })
    if (!resolution.ok) return { kind: 'error', outcome: { status: resolution.status, body: resolution.body } }
    if (resolution.kind === 'tunnel') return { kind: 'tunnel' }
    return { kind: 'url', url: resolution.url }
  } catch (err: any) {
    return {
      kind: 'error',
      outcome: { status: 502, body: { error: { code: 'agent_call_failed', message: err?.message ?? 'Failed to reach the target runtime' } } },
    }
  }
}

/** GET a path on the callee runtime, re-resolving each time so a moved runtime is still found. */
async function fetchCalleeRuntime(projectId: string, path: string): Promise<Response> {
  const { fetchFromProjectRuntime } = await import('../lib/chat-runtime-fetch')
  return fetchFromProjectRuntime(projectId, path, { method: 'GET' }, {
    resolveUrl: async (id) => {
      const target = await resolveCalleeRuntime(id)
      if (target.kind === 'url') return target.url
      throw new Error(target.kind === 'tunnel' ? 'callee runtime is only reachable through a tunnel' : 'callee runtime unavailable')
    },
  })
}

/**
 * Start the callee's turn without holding a request open for it, then follow
 * it in the background. Returns null when the callee can't be followed this
 * way (only reachable through an Instance tunnel); the caller then falls back
 * to holding the request.
 */
async function startBackgroundCall(
  c: Context,
  projectId: string,
  workspaceId: string,
  call: AgentCallRequest & { runId: string },
  chatSessionId: string,
  link: AgentCallSessionLink | null,
): Promise<AgentCallOutcome | null> {
  const target = await resolveCalleeRuntime(projectId)
  if (target.kind === 'tunnel') return null
  if (target.kind === 'error') return target.outcome

  const startedAt = link?.startedAt ?? Date.now()
  const ack = await forwardToProjectRuntime(
    c,
    projectId,
    workspaceId,
    '/agent/pipeline/call',
    JSON.stringify({ message: call.message, runId: call.runId, sessionId: chatSessionId, wait: false, callerProjectId: call.callerProjectId }),
    {
      runtimeUrl: target.url,
      timeoutMs: 15_000,
      ...(call.requesterTicket ? { headers: { 'X-Requester-Ticket': call.requesterTicket } } : {}),
    },
  )
  if (ack.status < 200 || ack.status >= 300) return ack

  if (link) await linkAgentCallSession(chatSessionId, link).catch(() => {})
  void followCallTurn(projectId, workspaceId, chatSessionId, startedAt, link).catch((err) =>
    console.warn(`[AgentCall] following call ${call.runId} failed:`, err?.message ?? err),
  )
  return ack
}

async function waitForCalleeTurn(projectId: string, chatSessionId: string, startedAt: number, deps: CallTurnDeps): Promise<boolean> {
  const deadline = Date.now() + deps.turnStartTimeoutMs
  for (;;) {
    const res = await fetchCalleeRuntime(projectId, `/agent/chat/${encodeURIComponent(chatSessionId)}/turn`).catch(() => null)
    if (res?.ok) {
      const turn = (await res.json().catch(() => null)) as { createdAt?: number } | null
      if (typeof turn?.createdAt === 'number' && turn.createdAt >= startedAt - TURN_CLOCK_SKEW_MS) return true
    } else {
      await res?.body?.cancel().catch(() => {})
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, deps.turnPollIntervalMs))
  }
}

/**
 * Persist the callee's turn into its call chat with the project chat tracker
 * (incremental saves, resume from the runtime buffer), then settle the call.
 */
async function followCallTurn(
  projectId: string,
  workspaceId: string,
  chatSessionId: string,
  startedAt: number,
  link: AgentCallSessionLink | null,
): Promise<void> {
  const deps = await callTurnDeps()
  const turnId = await deps.markTurnStarted(chatSessionId).catch((err) => {
    console.warn(`[AgentCall] could not mark call turn active for ${chatSessionId}:`, err?.message ?? err)
    return null
  })
  const stopHeartbeat = turnId ? deps.startTurnHeartbeat(chatSessionId, turnId) : () => {}
  let result: TrackedStreamResult | null = null
  try {
    if (await waitForCalleeTurn(projectId, chatSessionId, startedAt, deps)) {
      result = await trackCallTurn(projectId, workspaceId, chatSessionId, startedAt, deps)
    } else {
      console.warn(`[AgentCall] callee turn for ${chatSessionId} never started`)
    }
  } finally {
    stopHeartbeat()
    if (link) await settleAgentCallFromTurn(link, chatSessionId, result).catch(() => {})
    if (turnId) await deps.markTurnEnded(chatSessionId, turnId).catch(() => {})
  }
}

/** Stream the callee's turn buffer from the start into the call chat. */
async function trackCallTurn(
  projectId: string,
  workspaceId: string,
  chatSessionId: string,
  startedAt: number,
  deps: CallTurnDeps,
): Promise<TrackedStreamResult | null> {
  const streamPath = (fromSeq: number) => `/agent/chat/${encodeURIComponent(chatSessionId)}/stream?fromSeq=${fromSeq}`
  const res = await fetchCalleeRuntime(projectId, streamPath(0)).catch(() => null)
  if (!res || res.status !== 200 || !res.body) {
    await res?.body?.cancel().catch(() => {})
    return null
  }
  return deps.track(res.body, { chatSessionId }, { id: projectId, workspaceId }, {
    chatSessionId,
    suppressCompletionPush: true,
    expectedTurnStartedAt: startedAt,
    resume: async (fromSeq) => {
      try {
        return await fetchCalleeRuntime(projectId, streamPath(fromSeq))
      } catch {
        return null
      }
    },
  })
}

/**
 * Record a followed call's outcome. A turn this side didn't see finish (gone
 * buffer, superseded turn, never started) fails the call so the caller isn't
 * left waiting on it. Every terminal branch also makes sure the call chat got
 * an answer: the tracker writes it when it saw the turn, and when it didn't
 * (or its persist step bailed on an empty turn) the reply is recovered from
 * the runtime's turn record, or an explicit failure row is written.
 */
export async function settleAgentCallFromTurn(
  link: AgentCallSessionLink,
  chatSessionId: string,
  result: TrackedStreamResult | null,
): Promise<void> {
  const base = { runId: link.runId, sessionId: chatSessionId, chatSessionId, startedAt: link.startedAt, updatedAt: Date.now() }
  // The tracker owns the assistant row when it persisted one.
  const replyRowWritten = result?.assistantMessageId != null
  if (result?.outcome === 'complete' && result.status !== 'failed') {
    await putAgentCall(link.projectId, { ...base, status: 'completed', reply: result.text })
    if (!replyRowWritten) await ensureCallReplyRow(link.projectId, chatSessionId, result.text, 'completed')
    return
  }
  if (result?.outcome === 'complete') {
    await putAgentCall(link.projectId, {
      ...base,
      status: 'failed',
      reply: result.text || null,
      error: { code: 'agent_turn_failed', message: 'The target agent turn failed.' },
    })
    if (!replyRowWritten) await ensureCallReplyRow(link.projectId, chatSessionId, result.text || null, 'agent_turn_failed')
    return
  }
  await putAgentCall(link.projectId, {
    ...base,
    status: 'failed',
    reply: result?.text || null,
    error: { code: CALLEE_TURN_LOST, message: 'The target agent turn ended before its reply could be read.' },
  })
  if (!replyRowWritten) await ensureCallReplyRow(link.projectId, chatSessionId, result?.text || null, CALLEE_TURN_LOST)
}

export interface RemoteToolRequest {
  tool: string
  args: Record<string, unknown>
  callerProjectId?: string
  /** Signed requester ticket for the target, so its tool can act as the person behind the call. */
  requesterTicket?: string
  timeoutMs?: number
}

/**
 * Run one tool on the target project's own runtime (`/agent/remote/tool`).
 * Resolving here is what brings the target online: it wakes `ws:proj:<id>`
 * and never mounts the project anywhere else. Never throws.
 */
export async function callProjectRemoteTool(
  c: Context,
  projectId: string,
  workspaceId: string,
  req: RemoteToolRequest,
): Promise<AgentCallOutcome> {
  const timeoutMs = Math.min(Math.max(req.timeoutMs ?? 5 * 60_000, 10_000), 20 * 60_000)
  const resolved = await wakeRemoteTarget(projectId, 'RemoteTool')
  if ('status' in resolved) return resolved

  return forwardToProjectRuntime(
    c,
    projectId,
    workspaceId,
    '/agent/remote/tool',
    JSON.stringify({ tool: req.tool, args: req.args, callerProjectId: req.callerProjectId }),
    {
      runtimeUrl: resolved.url,
      timeoutMs,
      ...(req.requesterTicket ? { headers: { 'X-Requester-Ticket': req.requesterTicket } } : {}),
      timeoutMessage: `The target project did not finish ${req.tool} within ${Math.round(timeoutMs / 1000)}s.`,
    },
  )
}

export interface RemoteImportRequest {
  /** Base64 tar.gz built by the caller runtime (packages/agent-runtime/src/project-transfer.ts). */
  archive: string
  dest?: string
  overwrite?: boolean
  callerProjectId?: string
  requesterTicket?: string
}

/**
 * Unpack an archive inside the target project's own runtime
 * (`/agent/remote/import`, `copy_to_project`). Wakes it like
 * callProjectRemoteTool. Never throws.
 */
export async function callProjectRemoteImport(
  c: Context,
  projectId: string,
  workspaceId: string,
  req: RemoteImportRequest,
): Promise<AgentCallOutcome> {
  const timeoutMs = 3 * 60_000
  const resolved = await wakeRemoteTarget(projectId, 'RemoteImport')
  if ('status' in resolved) return resolved

  return forwardToProjectRuntime(
    c,
    projectId,
    workspaceId,
    '/agent/remote/import',
    JSON.stringify({
      archive: req.archive,
      ...(req.dest !== undefined ? { dest: req.dest } : {}),
      ...(req.overwrite ? { overwrite: true } : {}),
      callerProjectId: req.callerProjectId,
    }),
    {
      runtimeUrl: resolved.url,
      timeoutMs,
      ...(req.requesterTicket ? { headers: { 'X-Requester-Ticket': req.requesterTicket } } : {}),
      timeoutMessage: `The target project did not finish importing files within ${Math.round(timeoutMs / 1000)}s.`,
    },
  )
}

/** Resolve (and so wake) the target project's own runtime, or the outcome to return instead. */
async function wakeRemoteTarget(projectId: string, logTag: string): Promise<{ url: string } | AgentCallOutcome> {
  try {
    const overridden = runtimeUrlOverride ? await runtimeUrlOverride(projectId) : null
    if (overridden) return { url: overridden }
    const { resolveProjectPodUrl } = await import('../lib/resolve-pod-url')
    return { url: (await resolveProjectPodUrl(projectId, { logTag })).url }
  } catch (err: any) {
    const { WorkspaceCapacityError, describeCapacityRefusal } = await import('../lib/workspace-compute-budget')
    if (err instanceof WorkspaceCapacityError) {
      const described = await describeCapacityRefusal(err).catch(() => null)
      return {
        status: 409,
        body: {
          error: 'workspace_capacity',
          message:
            described?.message ??
            'Your workspace is out of room for running projects. Stop a project or upgrade your instance size.',
          capacity: described,
        },
      }
    }
    console.warn(`[${logTag}] could not resolve runtime for ${projectId}: ${err?.message ?? err}`)
    return {
      status: 502,
      body: { error: { code: 'target_unavailable', message: `Project ${projectId} runtime is unavailable: ${err?.message ?? err}` } },
    }
  }
}

let runtimeUrlOverride: ((projectId: string) => Promise<string | null> | string | null) | null = null

/** Test seam: resolve project runtime URLs directly (null falls through to the real resolver). */
export function setProjectRuntimeUrlResolver(
  resolver: ((projectId: string) => Promise<string | null> | string | null) | null,
): void {
  runtimeUrlOverride = resolver
}

/**
 * POST `body` to a runtime-token-guarded path on the project's runtime
 * (pinned Instance tunnel first, then cloud pod / host runtime).
 */
export async function forwardToProjectRuntime(
  c: Context,
  projectId: string,
  workspaceId: string,
  agentPath: string,
  forwardBody: string,
  opts: {
    timeoutMs: number
    timeoutMessage?: string
    headers?: Record<string, string>
    /** Already-resolved runtime URL; skips the resolver below. */
    runtimeUrl?: string
  },
): Promise<AgentCallOutcome> {
  const extraHeaders = opts.headers ?? {}
  try {
    const { deriveProjectRuntimeToken } = await import('../lib/project-runtime-token')
    const runtimeToken = await deriveProjectRuntimeToken(projectId, { workspaceId })

    let runtimeUrl: string
    const overridden = opts.runtimeUrl ?? (runtimeUrlOverride ? await runtimeUrlOverride(projectId) : null)
    if (overridden) {
      runtimeUrl = overridden
    } else if (process.env.SHOGO_LOCAL_MODE === 'true') {
      // Desktop: every project runs on the host RuntimeManager. The tunnel /
      // Redis resolver below is cloud-only and stays out of the local bundle.
      const { resolveProjectPodUrl } = await import('../lib/resolve-pod-url')
      runtimeUrl = (await resolveProjectPodUrl(projectId, { logTag: 'AgentCall' })).url
    } else {
      const { resolveAgentProxyPodUrl } = await import('../lib/agent-proxy-resolver')
      const resolution = await resolveAgentProxyPodUrl(projectId, { logTag: 'AgentCall' })
      if (!resolution.ok) return { status: resolution.status, body: resolution.body }

      if (resolution.kind === 'tunnel') {
        const { relayAgentProxyViaTunnel } = await import('../lib/tunnel-relay')
        const res = await relayAgentProxyViaTunnel({
          c,
          instanceId: resolution.instanceId,
          workspaceId: resolution.workspaceId,
          projectId,
          agentPath,
          cleanPath: agentPath,
          method: 'POST',
          body: forwardBody,
          headers: { 'content-type': 'application/json', 'x-runtime-token': runtimeToken, ...extraHeaders },
        })
        const json = await res.json().catch(() => ({}))
        return { status: res.status, body: json }
      }
      runtimeUrl = resolution.url
    }

    const res = await fetch(`${runtimeUrl}${agentPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-runtime-token': runtimeToken, ...extraHeaders },
      body: forwardBody,
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, body: json }
  } catch (err: any) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    return {
      status: timedOut ? 504 : 502,
      body: {
        error: {
          code: timedOut ? 'agent_call_timeout' : 'agent_call_failed',
          message: timedOut
            ? (opts.timeoutMessage ?? `The target runtime did not reply within ${Math.round(opts.timeoutMs / 1000)}s.`)
            : (err?.message ?? 'Failed to reach the target runtime'),
        },
      },
    }
  }
}
