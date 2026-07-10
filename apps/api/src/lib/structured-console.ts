// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Structured console → trace-correlated stdout.
 *
 * The API emits the vast majority of its operational logs through plain
 * `console.*` calls (~200 call sites). This patches the console methods so
 * that in production / staging every call writes a single structured JSON
 * line to stdout carrying the active `trace_id` / `span_id`.
 *
 * Why stdout and not OTLP: the app-level OTLP log export is unreliable under
 * Bun event-loop pressure — its wall-clock export deadline elapses before the
 * batch is flushed and records are silently dropped (this is exactly why
 * [MetalPool]/[metal-fleet] logs went dark in SigNoz). The k8s-infra otelAgent
 * DaemonSet tails pod stdout independently of the app process, so it is the
 * authoritative, always-on log path. By stamping the trace context onto the
 * stdout line itself, a downstream SigNoz log pipeline promotes `trace_id` /
 * `span_id` into the linked trace fields — full log↔trace correlation with
 * ZERO dependence on the app's own OTLP export ("Option B").
 *
 * Design constraints:
 * - prod/staging only: JSON hurts local `kubectl logs`/dev readability and
 *   there are no exported traces to correlate against in dev, so dev keeps the
 *   original plain-text console untouched.
 * - stream-preserving: the original (pre-patch) console method is used to
 *   write, so warn/error still go to stderr and log/info/debug to stdout.
 * - in-process trace context: `trace.getActiveSpan()` reflects the request
 *   span created by the tracing middleware and is valid even when the trace
 *   EXPORT fails — so logs are grouped by request regardless of export health.
 * - best-effort: any failure formatting a record falls back to the raw args,
 *   so telemetry enrichment can never drop or break a log line.
 */

import { format } from 'node:util'
import { trace, isSpanContextValid } from '@opentelemetry/api'

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug'

/** Severity level written to the `level` field, keyed by console method. */
const LEVEL: Record<ConsoleMethod, 'debug' | 'info' | 'warn' | 'error'> = {
  debug: 'debug',
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
}

/** Active trace context in OpenTelemetry hex form (32-char trace, 16-char span). */
export interface ActiveTraceContext {
  traceId: string
  spanId: string
}

/**
 * Build the structured JSON log line for a console call. Pure and side-effect
 * free (exported for testing): the shape is what the SigNoz log pipeline
 * parses — `msg` becomes the log body, `level` drives severity, and
 * `trace_id`/`span_id` are promoted to the record's linked trace fields.
 */
export function formatConsoleRecord(
  level: 'debug' | 'info' | 'warn' | 'error',
  args: unknown[],
  serviceName: string,
  ctx: ActiveTraceContext | null,
): string {
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    service: serviceName,
    msg: format(...(args as [unknown, ...unknown[]])),
  }
  if (ctx) {
    record.trace_id = ctx.traceId
    record.span_id = ctx.spanId
  }
  return JSON.stringify(record)
}

/** Read the active span's trace context, or null when there is no valid span. */
function activeTraceContext(): ActiveTraceContext | null {
  const ctx = trace.getActiveSpan()?.spanContext()
  return ctx && isSpanContextValid(ctx) ? { traceId: ctx.traceId, spanId: ctx.spanId } : null
}

let installed = false
// Guards against re-entrancy: while we're building a record, any console call
// made underneath (e.g. OTEL diag exporter errors) must not re-enter and
// double-wrap the line.
let emitting = false

/**
 * Patch `console.*` so each call writes a trace-correlated structured JSON line
 * to stdout in production / staging. Idempotent; gated by `NODE_ENV` and the
 * `OTEL_LOGS_CONSOLE_BRIDGE` env var (set to "false" to disable). Returns true
 * if the structured console was installed.
 */
export function installStructuredConsole(serviceName = 'shogo-api'): boolean {
  if (installed) return true
  if (process.env.OTEL_LOGS_CONSOLE_BRIDGE === 'false') {
    console.log('[OTEL] Structured console disabled (OTEL_LOGS_CONSOLE_BRIDGE=false)')
    return false
  }

  const isProduction = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging'
  if (!isProduction) {
    // Keep human-readable plain text for local `kubectl logs`/dev; there is no
    // exported trace to correlate against outside prod/staging anyway.
    console.log('[OTEL] Structured console disabled outside prod/staging (plain-text console kept)')
    return false
  }

  const methods: ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug']

  for (const method of methods) {
    const original = console[method]?.bind(console) ?? console.log.bind(console)

    console[method] = (...args: unknown[]): void => {
      if (emitting) {
        original(...args)
        return
      }
      emitting = true
      try {
        original(formatConsoleRecord(LEVEL[method], args, serviceName, activeTraceContext()))
      } catch {
        // best-effort: never let enrichment drop a log line
        original(...args)
      } finally {
        emitting = false
      }
    }
  }

  installed = true
  console.log('[OTEL] Structured console installed (JSON + trace_id/span_id on stdout)')
  return true
}
