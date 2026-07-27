// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Dependency-free OTLP/HTTP log exporter for the Electron MAIN process.
 *
 * WHY THIS EXISTS (and why it doesn't reuse @shogo-ai/core's exporter):
 * the desktop main bundle intentionally strips the heavy OpenTelemetry SDK
 * (see apps/api/src/entry.ts + apps/desktop/scripts/bundle-main.mjs), so we
 * cannot construct a LoggerProvider here. Instead this posts OTLP-JSON log
 * records straight to `${endpoint}/v1/logs` with the SigNoz ingestion header,
 * batching in memory and flushing on a timer. It captures the main-process
 * logs written to `main.log` — including the local API process's stdout/stderr,
 * which main.ts pipes through the patched `console.*`.
 *
 * HARD RULES (this module runs *behind* the patched console.* in main.ts):
 *   1. NEVER call console.log/warn/error. `writeLog()` is wired to console.*,
 *      so any console call here re-enters the log path and can loop forever.
 *      All diagnostics are therefore silent.
 *   2. NEVER throw and NEVER block. Logging must not crash, delay, or hang the
 *      app. Every failure path is swallowed; a persistently-unreachable
 *      collector simply drops records once the bounded queue is full.
 *   3. No external dependencies — only Node/Electron globals (fetch, setInterval).
 */

export type DesktopLogLevel = 'INFO' | 'WARN' | 'ERROR' | 'FATAL'

// OTLP SeverityNumber (see OpenTelemetry logs spec).
const SEVERITY_NUMBER: Record<DesktopLogLevel, number> = {
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
}

interface QueuedRecord {
  timeUnixNano: string
  level: DesktopLogLevel
  body: string
}

const MAX_QUEUE = 2048
const MAX_BATCH = 512
const FLUSH_INTERVAL_MS = 5000
const EXPORT_TIMEOUT_MS = 3000

let enabled = false
let logsUrl: string | null = null
let ingestionKey: string | undefined
let resourceAttributes: { key: string; value: { stringValue: string } }[] = []
let queue: QueuedRecord[] = []
let flushTimer: ReturnType<typeof setInterval> | null = null
let flushing = false

function attr(key: string, value: string) {
  return { key, value: { stringValue: value } }
}

/**
 * Initialize the exporter from env. Opt-in via `SHOGO_SIGNOZ_ENABLED === 'true'`.
 * Safe to call once at startup; a second call is ignored. Returns whether the
 * exporter became active (useful for tests; callers may ignore it).
 */
export function initSignozLogExporter(opts: { serviceVersion?: string } = {}): boolean {
  if (enabled) return true
  if (process.env.SHOGO_SIGNOZ_ENABLED !== 'true') return false
  if (typeof fetch !== 'function') return false

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'https://ingest.us.signoz.cloud:443'
  logsUrl = `${endpoint.replace(/\/+$/, '')}/v1/logs`
  ingestionKey = process.env.SIGNOZ_INGESTION_KEY

  resourceAttributes = [
    attr('service.name', 'shogo-desktop'),
    attr('service.version', opts.serviceVersion || process.env.APP_VERSION || '0.0.0'),
    attr('deployment.environment', 'desktop-local'),
    attr('os.type', process.platform),
    attr('host.arch', process.arch),
  ]

  enabled = true
  flushTimer = setInterval(() => { void flush() }, FLUSH_INTERVAL_MS)
  // Don't keep the event loop alive just for telemetry flushes.
  flushTimer.unref?.()
  return true
}

/**
 * Enqueue one log line for export. No-op when the exporter is disabled. Never
 * throws. Drops the oldest record when the bounded queue is full (a stuck
 * collector must not grow memory without bound).
 */
export function exportLogLine(level: DesktopLogLevel, body: string): void {
  if (!enabled || !body) return
  if (queue.length >= MAX_QUEUE) queue.shift()
  queue.push({
    timeUnixNano: `${Date.now()}000000`,
    level,
    body,
  })
}

function buildPayload(batch: QueuedRecord[]) {
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes },
        scopeLogs: [
          {
            scope: { name: 'shogo-desktop-main' },
            logRecords: batch.map((r) => ({
              timeUnixNano: r.timeUnixNano,
              severityNumber: SEVERITY_NUMBER[r.level],
              severityText: r.level,
              body: { stringValue: r.body },
              attributes: [attr('log.source', 'main.log')],
            })),
          },
        ],
      },
    ],
  }
}

/**
 * Flush queued records to SigNoz. Best-effort: bounded timeout, all errors
 * swallowed, and re-entrancy guarded so overlapping flushes can't pile up.
 */
export async function flush(): Promise<void> {
  if (!enabled || flushing || queue.length === 0 || !logsUrl) return
  flushing = true
  try {
    const batch = queue.splice(0, MAX_BATCH)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (ingestionKey) headers['signoz-ingestion-key'] = ingestionKey

    let signal: AbortSignal | undefined
    try {
      signal = AbortSignal.timeout(EXPORT_TIMEOUT_MS)
    } catch {
      signal = undefined
    }

    try {
      await fetch(logsUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildPayload(batch)),
        signal,
      })
      // Response status is intentionally ignored — a 4xx/5xx from the collector
      // is not actionable here and must not be logged (recursion) or retried
      // aggressively (the records are already dropped from the queue).
    } catch {
      // Network error / timeout: drop the batch. Retaining it risks unbounded
      // growth against a persistently-unreachable collector.
    }
  } finally {
    flushing = false
  }
}

/** Flush remaining records and stop the timer. Call on app quit. Never throws. */
export async function shutdownSignozLogExporter(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer)
    flushTimer = null
  }
  if (!enabled) return
  try {
    await flush()
  } catch {
    // best-effort
  }
  enabled = false
}
