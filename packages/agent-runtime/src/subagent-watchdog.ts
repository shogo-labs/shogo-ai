// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Sub-agent watchdog — bounded waiting and per-instance resource cleanup.
 *
 * Deliberately a leaf module: `gateway-tools.ts` needs these helpers at runtime,
 * and importing them from `agent-manager.ts` would drag that whole module graph
 * (subagent, persistence, screencast) into every consumer of the tool surface.
 * Keep the imports here to types only.
 */

import type { SubagentResult } from './subagent'

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * How long a sub-agent may show no progress at all (no model delta, no tool
 * start, no tool end) before it is treated as wedged.
 *
 * A real `browser_qa` run on prod does 25–82 tool calls in 5–15 minutes, and a
 * single navigation/analysis step can go a few minutes without a tool boundary,
 * so 10 minutes of complete silence is unambiguous: the model is not streaming
 * and no tool has started or finished.
 */
export const DEFAULT_SUBAGENT_IDLE_TIMEOUT_MS = 10 * 60_000

/**
 * Absolute ceiling for one foreground `agent_spawn`. Long enough for a real
 * browser QA run, short enough that a wedged call can never pin a chat for
 * hours (the prod wedge lasted 18 h).
 */
export const DEFAULT_SUBAGENT_MAX_DURATION_MS = 60 * 60_000

function positiveEnvMs(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

export function subagentIdleTimeoutMs(): number {
  return positiveEnvMs('SUBAGENT_IDLE_TIMEOUT_MS', DEFAULT_SUBAGENT_IDLE_TIMEOUT_MS)
}

export function subagentMaxDurationMs(): number {
  return positiveEnvMs('SUBAGENT_MAX_DURATION_MS', DEFAULT_SUBAGENT_MAX_DURATION_MS)
}

// ---------------------------------------------------------------------------
// Bounded waiting
// ---------------------------------------------------------------------------

/** The parts of a managed instance the watchdog needs. */
export interface WatchableInstance {
  promise: Promise<SubagentResult>
  abort?: AbortController
  startedAt: number
  lastActivityAt?: number
}

export type SubagentWaitOutcome =
  | { kind: 'settled'; result: SubagentResult }
  | { kind: 'cancelled'; reason: 'parent-abort' | 'instance-cancel' }
  | { kind: 'timeout'; reason: string }

export interface SubagentWaitOptions {
  /** Max silence (ms) before the instance counts as wedged. */
  idleMs: number
  /** Max total wall time (ms) for the wait. */
  maxMs: number
  /** The parent turn's signal, so Stop reaches the spawn immediately. */
  parentSignal?: AbortSignal
  /** Clock, for tests. */
  now?: () => number
  /** How often the watchdog samples. */
  checkIntervalMs?: number
}

/**
 * Wait for a spawned instance, but never forever.
 *
 * `await inst.promise` alone is what wedged prod: a sub-agent whose tool call
 * never settles never resolves its promise, so the parent's `agent_spawn` — and
 * therefore its chat turn — stayed open for 18 hours, and neither Stop nor the
 * sub-agent Stop button could end it.
 *
 * Here the wait ends on the first of: the instance settling, the instance being
 * cancelled (`AgentManager.cancel`), the parent turn aborting, the inactivity
 * watchdog, or the hard duration cap.
 */
export function waitForSubagentInstance(
  inst: WatchableInstance,
  opts: SubagentWaitOptions,
): Promise<SubagentWaitOutcome> {
  const now = opts.now ?? Date.now
  const checkIntervalMs = opts.checkIntervalMs ?? 1000
  const signal = inst.abort?.signal
  const lastActivity = () => Math.max(inst.lastActivityAt ?? inst.startedAt, inst.startedAt)

  return new Promise<SubagentWaitOutcome>((resolve) => {
    let done = false
    let timer: ReturnType<typeof setInterval> | null = null

    const finish = (outcome: SubagentWaitOutcome) => {
      if (done) return
      done = true
      if (timer) clearInterval(timer)
      timer = null
      signal?.removeEventListener('abort', onInstanceAbort)
      opts.parentSignal?.removeEventListener('abort', onParentAbort)
      resolve(outcome)
    }

    const onInstanceAbort = () => finish({ kind: 'cancelled', reason: 'instance-cancel' })
    const onParentAbort = () => finish({ kind: 'cancelled', reason: 'parent-abort' })

    if (signal?.aborted) return finish({ kind: 'cancelled', reason: 'instance-cancel' })
    if (opts.parentSignal?.aborted) return finish({ kind: 'cancelled', reason: 'parent-abort' })

    inst.promise.then(
      (result) => finish({ kind: 'settled', result }),
      () => finish({ kind: 'settled', result: synthesizeWaitResult({}, 'Subagent failed') }),
    )
    signal?.addEventListener('abort', onInstanceAbort, { once: true })
    opts.parentSignal?.addEventListener('abort', onParentAbort, { once: true })

    timer = setInterval(() => {
      const t = now()
      const idleFor = t - lastActivity()
      if (idleFor >= opts.idleMs) {
        finish({
          kind: 'timeout',
          reason: `no model output or tool activity for ${Math.round(idleFor / 60_000) || 1} min`,
        })
        return
      }
      if (t - inst.startedAt >= opts.maxMs) {
        finish({
          kind: 'timeout',
          reason: `ran longer than the ${Math.round(opts.maxMs / 60_000)} min limit`,
        })
      }
    }, checkIntervalMs)
    ;(timer as any)?.unref?.()
  })
}

/**
 * A result for a run that was cancelled or timed out. It carries the cause, so
 * the parent model can tell "the work stopped" from "the work finished quietly".
 */
export function synthesizeWaitResult(
  partial: Partial<SubagentResult>,
  message: string,
): SubagentResult {
  return {
    toolCalls: 0,
    iterations: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    responseText: '',
    responseEmpty: true,
    error: { message },
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// Per-instance resource cleanup
// ---------------------------------------------------------------------------

type InstanceCleanup = () => Promise<void> | void

const instanceCleanups = new Map<string, Set<InstanceCleanup>>()

/**
 * Register a cleanup for one sub-agent instance (its browser page/lease, for
 * example). Returns an unregister function.
 *
 * `runSubagent`'s own `finally` disposes the browser tool — but a run wedged in
 * a tool that never settles never reaches its `finally`, so cancel has to be
 * able to release the page itself, or the wedged run keeps a browser-pool slot
 * and a busy CPU for the rest of the turn's life (SHO-358).
 */
export function registerSubagentInstanceCleanup(
  instanceId: string,
  fn: InstanceCleanup,
): () => void {
  let set = instanceCleanups.get(instanceId)
  if (!set) {
    set = new Set()
    instanceCleanups.set(instanceId, set)
  }
  set.add(fn)
  return () => {
    const s = instanceCleanups.get(instanceId)
    if (!s) return
    s.delete(fn)
    if (s.size === 0) instanceCleanups.delete(instanceId)
  }
}

/** Release whatever an instance still holds. Idempotent. */
export async function releaseSubagentInstanceResources(instanceId: string): Promise<void> {
  const set = instanceCleanups.get(instanceId)
  if (!set) return
  instanceCleanups.delete(instanceId)
  await Promise.all([...set].map(async (fn) => {
    try { await fn() } catch {}
  }))
}
