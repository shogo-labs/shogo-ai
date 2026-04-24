// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Turn-resume client helpers.
 *
 * Phase 4.1 of the durable-turn work: expose the API's semantic turn
 * endpoints to the client so the UI can:
 *   1. Discover an in-flight turn on mount (after a page reload / app
 *      resume) via `fetchActiveTurns()`.
 *   2. Poll a single turn's status (attempts, continuations, terminal
 *      reason) via `fetchTurnStatus()` — used to drive the "continuing…"
 *      and "paused" banners (Phase 4.2/3).
 *   3. Ask the runtime to reconcile a turn via `postTurnResume()` — the
 *      server decides whether a pure stream replay is enough or a fresh
 *      chat request needs to be issued.
 *
 * These helpers are intentionally thin — no React state machinery here.
 * UIs compose them with their own state management (React Query,
 * useState, etc.). The `useActiveTurn` hook below is provided as a
 * convenient React wrapper for the common "subscribe to active turn
 * status" case.
 */

import { useEffect, useRef, useState } from 'react'

export interface TurnMetaLike {
  turnId: string
  status:
    | 'active'
    | 'completed'
    | 'aborted'
    | 'interrupted_recoverable'
    | 'max_continuations'
    | 'provider_fatal'
    | 'loop_detected'
  createdAt: number
  updatedAt: number
  terminalReason?: string
  chatSessionId?: string
  attempts?: number
  toolCallsTotal?: number
  outputTokensTotal?: number
  lastStopReason?: string
}

export interface TurnCheckpointLike {
  seq: number
  at: number
  attempt: number
  reason: string
  willContinue: boolean
  iterations: number
  toolCallsThisAttempt: number
  toolCallsTotal: number
  outputTokensTotal: number
  lastStopReason?: string
  modelId?: string
  error?: string
  extra?: Record<string, unknown>
}

export interface FetchOptions {
  apiBaseUrl: string
  projectId: string
  fetch?: typeof globalThis.fetch
  headers?: Record<string, string>
  signal?: AbortSignal
}

export async function fetchActiveTurns(
  opts: FetchOptions,
): Promise<TurnMetaLike[]> {
  const f = opts.fetch ?? globalThis.fetch
  const res = await f(`${opts.apiBaseUrl}/api/projects/${opts.projectId}/turns/active`, {
    headers: opts.headers,
    signal: opts.signal,
  })
  if (!res.ok) return []
  const body = (await res.json().catch(() => ({}))) as any
  const list = body.active ?? []
  return Array.isArray(list) ? (list as TurnMetaLike[]) : []
}

export interface TurnStatusResult {
  meta: TurnMetaLike | null
  checkpoints: TurnCheckpointLike[]
}

export async function fetchTurnStatus(
  opts: FetchOptions & { turnId: string; fromSeq?: number },
): Promise<TurnStatusResult | null> {
  const f = opts.fetch ?? globalThis.fetch
  const qs = opts.fromSeq ? `?fromSeq=${opts.fromSeq}` : ''
  const url = `${opts.apiBaseUrl}/api/projects/${opts.projectId}/turns/${encodeURIComponent(opts.turnId)}/status${qs}`
  const res = await f(url, { headers: opts.headers, signal: opts.signal })
  if (!res.ok) return null
  const body = (await res.json().catch(() => null)) as any
  if (!body?.ok) return null
  return {
    meta: body.meta ?? null,
    checkpoints: (body.checkpoints ?? []) as TurnCheckpointLike[],
  }
}

export type ResumeDecision =
  | { decision: 'replay'; turnId: string; chatSessionId?: string; replayPath?: string | null; meta: TurnMetaLike }
  | { decision: 'interrupted_recoverable'; turnId: string; chatSessionId?: string; meta: TurnMetaLike; hint?: string }
  | { decision: 'terminal'; turnId: string; terminalStatus: TurnMetaLike['status']; terminalReason?: string; meta: TurnMetaLike }
  | { decision: 'not_found'; turnId: string }

export async function postTurnResume(
  opts: FetchOptions & { turnId: string },
): Promise<ResumeDecision> {
  const f = opts.fetch ?? globalThis.fetch
  const url = `${opts.apiBaseUrl}/api/projects/${opts.projectId}/turns/${encodeURIComponent(opts.turnId)}/resume`
  const res = await f(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    signal: opts.signal,
  })
  if (res.status === 404) return { decision: 'not_found', turnId: opts.turnId }
  const body = (await res.json().catch(() => null)) as any
  if (!body?.ok) return { decision: 'not_found', turnId: opts.turnId }
  return {
    decision: body.decision,
    turnId: opts.turnId,
    chatSessionId: body.chatSessionId,
    replayPath: body.replayPath,
    meta: body.meta,
    terminalStatus: body.terminalStatus,
    terminalReason: body.terminalReason,
    hint: body.hint,
  } as ResumeDecision
}

/**
 * Build a resume URL suitable for an SSE GET request, optionally with a
 * `Last-Event-ID`-style `fromSeq`. This is the endpoint the AI SDK's
 * DefaultChatTransport hits when reconnecting to an existing turn.
 */
export function buildTurnStreamResumeUrl(
  apiBaseUrl: string,
  projectId: string,
  chatSessionId: string,
  turnId: string,
  fromSeq?: number,
): string {
  const qs = fromSeq ? `?fromSeq=${fromSeq}` : ''
  return `${apiBaseUrl}/api/projects/${projectId}/chat/${encodeURIComponent(chatSessionId)}/turns/${encodeURIComponent(turnId)}/stream${qs}`
}

/**
 * React hook: watch a single turn's status with configurable polling.
 * Safe to call with a null turnId — it no-ops.
 */
export function useActiveTurn(
  opts: Partial<FetchOptions> & { turnId: string | null; pollMs?: number; enabled?: boolean },
): {
  status: TurnMetaLike | null
  checkpoints: TurnCheckpointLike[]
  loading: boolean
  error: Error | null
} {
  const { turnId, pollMs = 3_000, enabled = true } = opts
  const [status, setStatus] = useState<TurnMetaLike | null>(null)
  const [checkpoints, setCheckpoints] = useState<TurnCheckpointLike[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const lastSeqRef = useRef(0)

  useEffect(() => {
    if (!enabled || !turnId || !opts.apiBaseUrl || !opts.projectId) return
    let cancelled = false
    const controller = new AbortController()

    const tick = async () => {
      setLoading(true)
      try {
        const res = await fetchTurnStatus({
          apiBaseUrl: opts.apiBaseUrl!,
          projectId: opts.projectId!,
          fetch: opts.fetch,
          headers: opts.headers,
          turnId,
          fromSeq: lastSeqRef.current,
          signal: controller.signal,
        })
        if (cancelled || !res) return
        if (res.meta) setStatus(res.meta)
        if (res.checkpoints.length > 0) {
          setCheckpoints((prev) => [...prev, ...res.checkpoints])
          lastSeqRef.current = res.checkpoints[res.checkpoints.length - 1].seq
        }
        setError(null)
      } catch (err: any) {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    tick()
    const timer = setInterval(() => {
      // Only keep polling while the turn might still change.
      if (status?.status && status.status !== 'active' && status.status !== 'interrupted_recoverable') {
        return
      }
      tick()
    }, pollMs)

    return () => {
      cancelled = true
      controller.abort()
      clearInterval(timer)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnId, opts.apiBaseUrl, opts.projectId, pollMs, enabled])

  return { status, checkpoints, loading, error }
}
