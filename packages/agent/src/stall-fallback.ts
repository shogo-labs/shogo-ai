// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Time-to-first-token (TTFT) stall fallback for the agent loop.
 *
 * Some OpenRouter-routed models (notably `xiaomi/mimo-v2.5`) intermittently
 * accept a request and then never stream anything — the turn just hangs until
 * the eval/turn timeout fires, producing zero tool calls. This wraps a base
 * `StreamFn` so that, for configured models, if the provider produces no
 * streamed content within `ttftMs`, the in-flight request is aborted and the
 * call is transparently retried against a stronger fallback model.
 *
 * Design (per the agreed scope):
 * - **General mechanism.** Driven by a list of primary→fallback rules; ships
 *   with the MiMo v2.5 → MiMo v2.5 Pro pairing by default but is reusable.
 * - **Trigger = time-to-first-token.** The timer is armed when the request
 *   starts and disarmed on the first *content* event (text / thinking / tool
 *   call) or any terminal (`done`/`error`). A bare `start` frame (which some
 *   providers emit locally before the network round-trip) does NOT disarm it —
 *   we buffer it so the fallback can emit a clean fresh `start`.
 * - **Time-boxed fallback (not permanent).** When a stall fires, the fallback
 *   model is used for a fixed cooldown window (default 60s). After the window
 *   elapses, the next API call re-probes the original primary model (again
 *   guarded by the TTFT timer). If the primary streams normally we stay on it;
 *   if it stalls again, a fresh fallback window opens.
 * - **Transparent + zero-overhead off-path.** Models with no matching rule are
 *   passed straight through to the base stream function.
 *
 * The wrapper honours the pi-agent-core `StreamFn` contract: it never throws,
 * always returns an `AssistantMessageEventStream`, and encodes failures as
 * protocol events terminating in an `error` message.
 */

import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  createAssistantMessageEventStream,
} from '@mariozechner/pi-ai'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import { resolveModel } from './pi-adapter'

export interface StallFallbackRule {
  /** Match against the resolved pi `Model.id` (bare upstream id, e.g. `xiaomi/mimo-v2.5`). */
  matchModelId: string
  /** Optional provider guard (e.g. `openrouter`). When omitted, matches any provider. */
  matchProvider?: string
  /** Catalog id to resolve the fallback model from (e.g. `openrouter:xiaomi/mimo-v2.5-pro`). */
  fallbackModel: string
  /** Provider used to resolve the fallback model. */
  fallbackProvider: string
}

/** Default rule set: MiMo v2.5 → MiMo v2.5 Pro on OpenRouter. */
export const DEFAULT_STALL_FALLBACK_RULES: StallFallbackRule[] = [
  {
    matchModelId: 'xiaomi/mimo-v2.5',
    matchProvider: 'openrouter',
    fallbackModel: 'openrouter:xiaomi/mimo-v2.5-pro',
    fallbackProvider: 'openrouter',
  },
]

export const DEFAULT_TTFT_MS = 10_000
/** How long to stay on the fallback model before re-probing the primary. */
export const DEFAULT_FALLBACK_WINDOW_MS = 60_000

export interface StallFallbackOptions {
  rules?: StallFallbackRule[]
  /** Milliseconds to wait for the first streamed content before falling back. */
  ttftMs?: number
  /**
   * Cooldown window (ms) to keep using the fallback model after a stall before
   * the next API call retries the primary. Default 60s.
   */
  fallbackWindowMs?: number
  /** Invoked when a fallback fires (for logging/metrics/UI). */
  onFallback?: (info: { from: string; to: string; ttftMs: number }) => void
  logPrefix?: string
}

/** Events that prove the provider is actually streaming a response. */
const CONTENT_EVENT_TYPES = new Set<AssistantMessageEvent['type']>([
  'text_start',
  'text_delta',
  'text_end',
  'thinking_start',
  'thinking_delta',
  'thinking_end',
  'toolcall_start',
  'toolcall_delta',
  'toolcall_end',
])

/** A content event OR a terminal event — anything other than a bare `start`. */
function disarmsTimer(ev: AssistantMessageEvent): boolean {
  return ev.type === 'done' || ev.type === 'error' || CONTENT_EVENT_TYPES.has(ev.type)
}

function buildAbortedMessage(model: Model<Api>, base?: AssistantMessage): AssistantMessage {
  if (base) {
    return { ...base, stopReason: 'aborted', errorMessage: 'Aborted before fallback' }
  }
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as any,
    stopReason: 'aborted',
    errorMessage: 'Aborted before fallback',
    timestamp: Date.now(),
  } as AssistantMessage
}

/**
 * Wrap a base `StreamFn` with TTFT stall-fallback behavior.
 *
 * Returns a new `StreamFn` with its own sticky state — create one per agent
 * run (the agent-loop does this) so stickiness is scoped to a single run.
 */
export function makeStallFallbackStreamFn(base: StreamFn, options: StallFallbackOptions = {}): StreamFn {
  const rules = options.rules ?? DEFAULT_STALL_FALLBACK_RULES
  const ttftMs = options.ttftMs ?? DEFAULT_TTFT_MS
  const fallbackWindowMs = options.fallbackWindowMs ?? DEFAULT_FALLBACK_WINDOW_MS
  const prefix = options.logPrefix ?? '[StallFallback]'

  // Time-boxed fallback: when a stall fires we record the fallback model and an
  // expiry timestamp. Calls within the window use the fallback directly; after
  // expiry the next call re-probes the primary (guarded again).
  let activeFallback: { model: Model<Api>; until: number } | null = null

  const findRule = (model: Model<Api>): StallFallbackRule | undefined =>
    rules.find((r) => r.matchModelId === model.id && (!r.matchProvider || r.matchProvider === model.provider))

  return ((model: Model<Api>, context: any, opts: any) => {
    // Inside an active fallback window — keep using the fallback model.
    if (activeFallback) {
      if (Date.now() < activeFallback.until) {
        return base(activeFallback.model as any, context, opts)
      }
      // Window elapsed — drop it and re-probe the primary below.
      activeFallback = null
    }

    const rule = findRule(model)
    if (!rule) {
      // No guard configured for this model: pure pass-through, zero overhead.
      return base(model, context, opts)
    }

    const out = createAssistantMessageEventStream()
    const outerSignal: AbortSignal | undefined = opts?.signal

    void (async () => {
      const primaryCtrl = new AbortController()
      const onOuterAbort = () => primaryCtrl.abort()
      if (outerSignal) {
        if (outerSignal.aborted) primaryCtrl.abort()
        else outerSignal.addEventListener('abort', onOuterAbort, { once: true })
      }

      let timer: ReturnType<typeof setTimeout> | undefined
      let committed = false
      let stalled = false
      let firstPartial: AssistantMessage | undefined
      const buffered: AssistantMessageEvent[] = []

      try {
        const inner = base(model, context, { ...opts, signal: primaryCtrl.signal })

        timer = setTimeout(() => {
          if (!committed) {
            stalled = true
            primaryCtrl.abort()
          }
        }, ttftMs)

        for await (const ev of inner as AsyncIterable<AssistantMessageEvent>) {
          // Our timeout fired — abandon the primary stream entirely (the abort
          // will surface as an error terminal we don't want to forward).
          if (stalled) break

          if (committed) {
            out.push(ev)
            continue
          }

          if (ev.type === 'start') {
            firstPartial = ev.partial
            buffered.push(ev)
            continue
          }

          if (disarmsTimer(ev)) {
            committed = true
            if (timer) clearTimeout(timer)
            for (const b of buffered) out.push(b)
            buffered.length = 0
            out.push(ev)
          } else {
            buffered.push(ev)
          }
        }

        if (committed) return // terminal event already forwarded → `out` is complete

        // Primary ended without ever producing content. If our timer didn't
        // fire, treat the silent close as a stall too (nothing useful arrived).
        if (!stalled) stalled = true
      } catch (err: any) {
        // base() shouldn't throw, but the async iteration can reject on abort.
        // If we already committed, the terminal was forwarded; otherwise fall
        // through to the fallback (treat as a stall).
        if (committed) return
        if (!stalled) stalled = true
      } finally {
        if (timer) clearTimeout(timer)
        if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort)
      }

      // If the *outer* caller aborted (user stop) during the window, don't burn
      // a fallback request — end the stream as aborted.
      if (outerSignal?.aborted) {
        const aborted = buildAbortedMessage(model, firstPartial)
        out.push({ type: 'error', reason: 'aborted', error: aborted } as AssistantMessageEvent)
        return
      }

      // --- Fallback ---
      let fb: Model<Api>
      try {
        fb = resolveModel(rule.fallbackProvider, rule.fallbackModel) as Model<Api>
      } catch (err: any) {
        const failMsg = buildAbortedMessage(model, firstPartial)
        ;(failMsg as any).stopReason = 'error'
        ;(failMsg as any).errorMessage = `Stall fallback could not resolve ${rule.fallbackModel}: ${err?.message}`
        out.push({ type: 'error', reason: 'error', error: failMsg } as AssistantMessageEvent)
        return
      }

      activeFallback = { model: fb, until: Date.now() + fallbackWindowMs }
      try {
        options.onFallback?.({ from: String(model.id), to: String(fb.id), ttftMs })
      } catch { /* non-fatal */ }
      // Distinctive, greppable marker so the fallback is easy to spot in
      // gateway/eval logs (search: STALL_FALLBACK_FIRED).
      console.warn(
        `${prefix} STALL_FALLBACK_FIRED primary=${model.id} fallback=${fb.id} ttftMs=${ttftMs} ` +
          `windowMs=${fallbackWindowMs} (no tokens within ${ttftMs}ms; using fallback for ${fallbackWindowMs}ms, then retrying primary)`,
      )

      try {
        const fbStream = base(fb as any, context, opts)
        for await (const ev of fbStream as AsyncIterable<AssistantMessageEvent>) {
          out.push(ev)
        }
        // If the fallback stream ended without a terminal (shouldn't happen),
        // make sure `out.result()` resolves.
        out.end()
      } catch (err: any) {
        const failMsg = buildAbortedMessage(fb, undefined)
        ;(failMsg as any).stopReason = 'error'
        ;(failMsg as any).errorMessage = `Fallback model ${fb.id} failed: ${err?.message}`
        out.push({ type: 'error', reason: 'error', error: failMsg } as AssistantMessageEvent)
      }
    })()

    return out
  }) as StreamFn
}

/**
 * Resolve effective stall-fallback options from explicit config + env overrides.
 * Returns `null` when the mechanism is disabled.
 *
 * Env:
 * - `SHOGO_STALL_FALLBACK=0|false|off` disables it entirely.
 * - `SHOGO_STALL_FALLBACK_TTFT_MS=<n>` overrides the TTFT threshold.
 * - `SHOGO_STALL_FALLBACK_WINDOW_MS=<n>` overrides the fallback cooldown window.
 */
export function resolveStallFallbackOptions(
  explicit?: StallFallbackOptions | false,
): StallFallbackOptions | null {
  if (explicit === false) return null
  const envFlag = (process.env.SHOGO_STALL_FALLBACK ?? '').trim().toLowerCase()
  if (envFlag === '0' || envFlag === 'false' || envFlag === 'off') return null

  const opts: StallFallbackOptions = { ...explicit }
  const envTtft = process.env.SHOGO_STALL_FALLBACK_TTFT_MS
  if (envTtft && Number.isFinite(Number(envTtft)) && Number(envTtft) > 0) {
    opts.ttftMs = Number(envTtft)
  }
  const envWindow = process.env.SHOGO_STALL_FALLBACK_WINDOW_MS
  if (envWindow && Number.isFinite(Number(envWindow)) && Number(envWindow) > 0) {
    opts.fallbackWindowMs = Number(envWindow)
  }
  return opts
}
