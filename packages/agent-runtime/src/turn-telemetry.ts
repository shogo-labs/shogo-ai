// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Turn-scoped telemetry.
 *
 * Phase 5.1 (structured turn-scoped logs) and 5.2 (metrics) of the durable
 * turn work.
 *
 * This module keeps metrics/log plumbing out of the gateway hot path. We
 * expose:
 *
 *   - `logTurnEvent(turnId, event, fields)` — a single-line JSON log for
 *     downstream ingestion. Works whether or not an OTel pipeline is
 *     configured.
 *
 *   - `recordTurnMetric(name, value, attrs)` — a no-op-friendly wrapper
 *     around `@opentelemetry/api.metrics`. Falls back to structured logs
 *     when OTel is unavailable so we never crash a turn over a missing
 *     metrics SDK.
 *
 *   - `TurnTelemetry.start(turnId, attrs)` — returns a handle that records
 *     attempt/continuation events and finalizes the span on terminal.
 *
 * The public surface is intentionally narrow: the gateway should treat
 * telemetry as fire-and-forget side effects.
 */

type JSONFields = Record<string, unknown>

let metrics: any = null
let trace: any = null
try {
  // Soft import so builds without OTel installed still work.
  const mod = require('@opentelemetry/api') as any
  metrics = mod.metrics
  trace = mod.trace
} catch {
  metrics = null
  trace = null
}

const METER_NAME = 'shogo.agent.turn'
const TRACER_NAME = 'shogo.agent.turn'

let cachedMeter: any = null
let cachedTracer: any = null
function getMeter() {
  if (cachedMeter) return cachedMeter
  if (!metrics) return null
  try {
    cachedMeter = metrics.getMeter(METER_NAME)
    return cachedMeter
  } catch {
    return null
  }
}
function getTracer() {
  if (cachedTracer) return cachedTracer
  if (!trace) return null
  try {
    cachedTracer = trace.getTracer(TRACER_NAME)
    return cachedTracer
  } catch {
    return null
  }
}

const counters = new Map<string, any>()
const histograms = new Map<string, any>()

function getCounter(name: string) {
  if (counters.has(name)) return counters.get(name)
  const meter = getMeter()
  if (!meter) return null
  try {
    const c = meter.createCounter(name)
    counters.set(name, c)
    return c
  } catch {
    return null
  }
}
function getHistogram(name: string) {
  if (histograms.has(name)) return histograms.get(name)
  const meter = getMeter()
  if (!meter) return null
  try {
    const h = meter.createHistogram(name)
    histograms.set(name, h)
    return h
  } catch {
    return null
  }
}

/**
 * Single-line JSON log for turn events. Stable, machine-parseable.
 *
 * Example:
 *   {"lvl":"info","kind":"turn","event":"checkpoint","turnId":"t-123",...}
 */
export function logTurnEvent(
  turnId: string,
  event: string,
  fields: JSONFields = {},
  level: 'info' | 'warn' | 'error' = 'info',
): void {
  try {
    const line = JSON.stringify({
      lvl: level,
      kind: 'turn',
      event,
      turnId,
      ts: Date.now(),
      ...fields,
    })
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  } catch {
    // Never let logging fail a turn
  }
}

export function recordTurnCounter(
  name: string,
  value = 1,
  attrs: Record<string, string | number | boolean> = {},
): void {
  try {
    const c = getCounter(name)
    if (c) c.add(value, attrs)
    else logTurnEvent(String(attrs.turnId ?? 'unknown'), 'metric', { name, value, ...attrs })
  } catch { /* telemetry must not throw */ }
}

export function recordTurnHistogram(
  name: string,
  value: number,
  attrs: Record<string, string | number | boolean> = {},
): void {
  try {
    const h = getHistogram(name)
    if (h) h.record(value, attrs)
    else logTurnEvent(String(attrs.turnId ?? 'unknown'), 'metric', { name, value, ...attrs })
  } catch { /* telemetry must not throw */ }
}

/**
 * A handle over a turn's OTel span + aggregated metrics. All methods are
 * safe to call when OTel is not configured.
 */
export class TurnTelemetry {
  private readonly startedAt = Date.now()
  private ended = false
  constructor(
    public readonly turnId: string,
    private readonly span: any,
    private readonly baseAttrs: Record<string, string | number | boolean>,
  ) {}

  static start(
    turnId: string,
    attrs: Record<string, string | number | boolean> = {},
  ): TurnTelemetry {
    const tracer = getTracer()
    let span: any = null
    try {
      if (tracer) {
        span = tracer.startSpan('agent.turn', {
          attributes: { 'turn.id': turnId, ...attrs },
        })
      }
    } catch { /* best effort */ }

    recordTurnCounter('agent_turn_started_total', 1, { turnId, ...attrs })
    logTurnEvent(turnId, 'start', attrs)
    return new TurnTelemetry(turnId, span, attrs)
  }

  attempt(cp: {
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
  }): void {
    logTurnEvent(this.turnId, 'checkpoint', cp)
    recordTurnCounter('agent_turn_attempt_total', 1, {
      turnId: this.turnId,
      reason: cp.reason,
      willContinue: cp.willContinue,
      ...this.baseAttrs,
    })
    if (cp.error) {
      recordTurnCounter('agent_turn_attempt_error_total', 1, {
        turnId: this.turnId,
        reason: cp.reason,
        ...this.baseAttrs,
      })
    }
    try {
      this.span?.addEvent('attempt', {
        'attempt.number': cp.attempt,
        'attempt.reason': cp.reason,
        'attempt.will_continue': cp.willContinue,
        'attempt.iterations': cp.iterations,
        'attempt.tool_calls_this_attempt': cp.toolCallsThisAttempt,
        'attempt.tool_calls_total': cp.toolCallsTotal,
        'attempt.output_tokens_total': cp.outputTokensTotal,
        ...(cp.lastStopReason ? { 'attempt.stop_reason': cp.lastStopReason } : {}),
        ...(cp.modelId ? { 'attempt.model_id': cp.modelId } : {}),
      })
    } catch {}
  }

  end(finalStatus: string, terminalReason?: string, fields: JSONFields = {}): void {
    if (this.ended) return
    this.ended = true
    const durationMs = Date.now() - this.startedAt
    logTurnEvent(this.turnId, 'end', {
      status: finalStatus,
      terminalReason,
      durationMs,
      ...fields,
    })
    recordTurnCounter('agent_turn_completed_total', 1, {
      turnId: this.turnId,
      status: finalStatus,
      terminalReason: terminalReason ?? 'unspecified',
      ...this.baseAttrs,
    })
    recordTurnHistogram('agent_turn_duration_ms', durationMs, {
      turnId: this.turnId,
      status: finalStatus,
      ...this.baseAttrs,
    })
    try {
      this.span?.setAttribute('turn.status', finalStatus)
      if (terminalReason) this.span?.setAttribute('turn.terminal_reason', terminalReason)
      this.span?.end()
    } catch {}
  }
}
