// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Structured logger for Shogo runtime services.
 *
 * Outputs JSON lines in production / staging (suitable for SigNoz log
 * collection or any structured log pipeline) and a human-readable
 * `[service] msg {extra}` format in development.
 *
 * Lifted into the SDK from `@shogo/shared-runtime` (was AGPL) under MIT
 * so userland agent/app code can import the same logger the runtime
 * services use without dragging an AGPL workspace dependency.
 *
 * @example
 *   import { createLogger } from '@shogo-ai/sdk/logger'
 *
 *   const log = createLogger('my-service')
 *   log.info('boot complete', { port: 8002 })
 *
 *   const reqLog = log.child({ requestId: 'r-123' })
 *   reqLog.warn('slow query', { ms: 4200 })
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  level: LogLevel
  msg: string
  service: string
  timestamp: string
  [key: string]: unknown
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const isProduction = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging'
const minLevel = LOG_LEVELS[(process.env.LOG_LEVEL as LogLevel) || 'info'] ?? 1

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= minLevel
}

function formatEntry(entry: LogEntry): string {
  if (isProduction) {
    return JSON.stringify(entry)
  }
  const { level: _level, msg, service, timestamp: _timestamp, ...extra } = entry
  const extraStr = Object.keys(extra).length > 0
    ? ' ' + JSON.stringify(extra)
    : ''
  return `[${service}] ${msg}${extraStr}`
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void
  info(msg: string, extra?: Record<string, unknown>): void
  warn(msg: string, extra?: Record<string, unknown>): void
  error(msg: string, extra?: Record<string, unknown>): void
  /** Returns a new logger that merges `extra` into every log entry. */
  child(extra: Record<string, unknown>): Logger
}

/**
 * Optional sink that forwards every emitted log entry to an external
 * destination (e.g. an OpenTelemetry `LoggerProvider` for OTLP export to
 * SigNoz). Kept as a plain callback so this module has ZERO OpenTelemetry
 * dependency — `instrumentation.ts` installs the sink only when OTEL is
 * configured, and userland consumers that just want a console logger are
 * unaffected. See `setOtelLogSink`.
 */
export type LogSink = (entry: LogEntry) => void

let logSink: LogSink | null = null

/**
 * Register (or clear, with `null`) a sink invoked for every log entry after
 * it is written to the console. Errors thrown by the sink are swallowed —
 * telemetry must never break application logging.
 */
export function setOtelLogSink(sink: LogSink | null): void {
  logSink = sink
}

/** Active trace context, in OpenTelemetry hex form (32-char / 16-char). */
export interface TraceContext {
  trace_id: string
  span_id: string
}

/**
 * Optional provider of the active trace context, used to stamp `trace_id` /
 * `span_id` onto every log entry so the *stdout line itself* is trace-
 * correlated. This is the durable "trace-ids-on-stdout" path: a log scraper
 * (the SigNoz k8s-infra DaemonSet, or a host collector tailing serial output
 * on bare-metal guests) can then link logs to traces WITHOUT depending on the
 * app-level OTLP log export, which is unreliable under Bun event-loop pressure.
 *
 * Kept as a plain callback so this module keeps ZERO OpenTelemetry dependency —
 * `instrumentation.ts` registers it once a tracer is live, and userland
 * consumers that just want a console logger are unaffected.
 */
export type TraceContextProvider = () => TraceContext | null

let traceContextProvider: TraceContextProvider | null = null

/**
 * Register (or clear, with `null`) the provider consulted on every log call to
 * enrich entries with the active `trace_id` / `span_id`. Errors thrown by the
 * provider are swallowed — telemetry must never break application logging.
 */
export function setTraceContextProvider(provider: TraceContextProvider | null): void {
  traceContextProvider = provider
}

export function createLogger(service: string, defaultExtra?: Record<string, unknown>): Logger {
  function log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    if (!shouldLog(level)) return

    const entry: LogEntry = {
      level,
      msg,
      service,
      timestamp: new Date().toISOString(),
      ...defaultExtra,
      ...extra,
    }

    // Stamp the active trace context so the emitted line is trace-correlated on
    // stdout — independent of whether the OTLP log export succeeds.
    if (traceContextProvider) {
      try {
        const tc = traceContextProvider()
        if (tc) {
          entry.trace_id = tc.trace_id
          entry.span_id = tc.span_id
        }
      } catch {
        // best-effort: never let telemetry break logging
      }
    }

    const formatted = formatEntry(entry)

    switch (level) {
      case 'error':
        console.error(formatted)
        break
      case 'warn':
        console.warn(formatted)
        break
      default:
        console.log(formatted)
        break
    }

    // Forward the structured entry to the OTEL log sink (if configured) so it
    // reaches SigNoz on /v1/logs, correlated with the active span.
    if (logSink) {
      try {
        logSink(entry)
      } catch {
        // best-effort: never let telemetry break logging
      }
    }
  }

  return {
    debug: (msg, extra) => log('debug', msg, extra),
    info: (msg, extra) => log('info', msg, extra),
    warn: (msg, extra) => log('warn', msg, extra),
    error: (msg, extra) => log('error', msg, extra),
    child: (extra) => createLogger(service, { ...defaultExtra, ...extra }),
  }
}
