// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Running one workspace-agent turn from a background job, outside any
 * client request: recurring schedules (`run-agent-schedule-dispatch.ts`) and
 * workspace event deliveries (`run-event-delivery-dispatch.ts`).
 */

import { prisma } from '../lib/prisma'
import { workspaceChatRoutes } from '../routes/workspace-chat'

export type RuntimeManager = Parameters<typeof workspaceChatRoutes>[0]['runtimeManager']

export class AgentTurnError extends Error {
  constructor(
    message: string,
    public readonly kind: 'failed' | 'forbidden' | 'timed_out',
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'AgentTurnError'
  }
}

export function abortError(signal: AbortSignal, fallback = 'The run was aborted'): AgentTurnError {
  return signal.reason instanceof AgentTurnError
    ? signal.reason
    : new AgentTurnError(fallback, 'failed')
}

export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export type TurnOutcome = { loopPattern: string | null }

/** Reads the runtime's `data-usage` frame, which reports a loop-detector abort. */
function readUsageFrame(line: string, outcome: TurnOutcome): void {
  if (!line.startsWith('data:')) return
  const payload = line.slice(5).trim()
  if (!payload.includes('"data-usage"')) return
  try {
    const frame = JSON.parse(payload)
    if (frame?.type === 'data-usage' && frame.data?.loopDetected === true) {
      outcome.loopPattern = typeof frame.data.loopPattern === 'string'
        ? frame.data.loopPattern
        : 'repeated tool calls without progress'
    }
  } catch {
    // Ignore frames that are not JSON.
  }
}

export async function consumeResponse(response: Response, signal: AbortSignal, label = 'Agent'): Promise<TurnOutcome> {
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    let message = body || `${label} request failed with HTTP ${response.status}`
    try {
      const payload = JSON.parse(body)
      message = payload?.error?.message || payload?.message || message
    } catch {
      // Keep the raw response when it is not JSON.
    }
    const forbidden = response.status === 401 || response.status === 403
    throw new AgentTurnError(message, forbidden ? 'forbidden' : 'failed', response.status)
  }
  const outcome: TurnOutcome = { loopPattern: null }
  if (!response.body) return outcome
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const cancel = () => void reader.cancel(signal.reason).catch(() => {})
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      const next = await untilAborted(reader.read(), signal)
      if (next.done) break
      buffered += decoder.decode(next.value, { stream: true })
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) readUsageFrame(line, outcome)
    }
    buffered += decoder.decode()
    if (buffered) readUsageFrame(buffered, outcome)
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
  return outcome
}

/**
 * Hold a claim on a row while its run is in flight. `runningAt` is the lease
 * token: `renew(current, next)` must swap it only if it still equals
 * `current`, so a reclaimed or deleted row is detected instead of overwritten.
 */
export function startLease(
  runningAt: Date,
  renew: (current: Date, next: Date) => Promise<boolean>,
  onLost: () => void,
  intervalMs = 60_000,
  label = 'lease',
) {
  let current = runningAt
  let lost = false
  let pending: Promise<void> = Promise.resolve()
  const timer = setInterval(() => {
    pending = pending
      .then(async () => {
        if (lost) return
        const next = new Date()
        if (await renew(current, next)) {
          current = next
        } else {
          lost = true
          onLost()
        }
      })
      .catch((error) => {
        console.error(`[AgentTurn] Failed to heartbeat ${label}:`, error)
      })
  }, intervalMs)
  ;(timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()

  return {
    get lost() {
      return lost
    },
    async release(): Promise<Date> {
      clearInterval(timer)
      await pending
      return current
    },
  }
}

/** A workspace chat session for a background job, reused while it stays valid. */
export async function ensureWorkspaceChatSession(input: {
  workspaceId: string
  existingSessionId: string | null
  name: string
  persist: (sessionId: string) => Promise<unknown>
}): Promise<string> {
  if (input.existingSessionId) {
    const existing = await prisma.chatSession.findUnique({
      where: { id: input.existingSessionId },
      select: { contextType: true, workspaceId: true },
    })
    if (existing?.contextType === 'workspace' && existing.workspaceId === input.workspaceId) {
      return input.existingSessionId
    }
  }
  const session = await prisma.chatSession.create({
    data: {
      inferredName: input.name.slice(0, 120),
      contextType: 'workspace',
      workspaceId: input.workspaceId,
    },
    select: { id: true },
  })
  await input.persist(session.id)
  return session.id
}

/**
 * What the agent said after its last tool call: the answer, without the "let me check…" it said along
 * the way. A report posted to a channel should read as one message. Falls back to the whole text.
 */
export function finalAnswerOf(parts: unknown, content: string | null | undefined): string | null {
  try {
    const list = typeof parts === 'string' ? JSON.parse(parts) : parts
    if (Array.isArray(list)) {
      let lastTool = -1
      list.forEach((part: any, i: number) => { if (typeof part?.type === 'string' && /^(tool-|dynamic-tool)/.test(part.type)) lastTool = i })
      const after = list
        .slice(lastTool + 1)
        .filter((part: any) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim())
        .map((part: any) => part.text.trim())
      if (after.length) return after.join('\n\n')
    }
  } catch {}
  return content?.trim() || null
}

export async function latestAssistantSummary(sessionId: string, after: Date, finalOnly = false): Promise<string | null> {
  const message = await prisma.chatMessage.findFirst({
    where: {
      sessionId,
      role: 'assistant',
      createdAt: { gt: after },
    },
    orderBy: { createdAt: 'desc' },
    select: { content: true, parts: true },
  })
  if (finalOnly) return finalAnswerOf(message?.parts, message?.content)
  return message?.content?.trim() || null
}

/** Run one workspace-agent turn as `userId` and wait for it to finish streaming. */
export async function executeWorkspaceAgentTurn(input: {
  runtimeManager?: RuntimeManager
  workspaceId: string
  userId: string
  sessionId: string
  prompt: string
  clientTurnId: string
  signal: AbortSignal
  label?: string
}): Promise<TurnOutcome> {
  const router = workspaceChatRoutes({
    runtimeManager: input.runtimeManager,
    alwaysEnabled: true,
    resolveUserId: async (c) => c.req.header('X-Schedule-User-Id') || null,
  })
  const response = await untilAborted(Promise.resolve(router.fetch(
    new Request(`http://internal/workspaces/${encodeURIComponent(input.workspaceId)}/chat`, {
      method: 'POST',
      signal: input.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Schedule-User-Id': input.userId,
        'X-Billing-User-Id': input.userId,
        'X-Chat-Session-Id': input.sessionId,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', parts: [{ type: 'text', text: input.prompt }] }],
        chatSessionId: input.sessionId,
        userId: input.userId,
        agentMode: 'auto',
        interactionMode: 'agent',
        clientTurnId: input.clientTurnId,
      }),
    }),
  )), input.signal)
  return consumeResponse(response, input.signal, input.label)
}
