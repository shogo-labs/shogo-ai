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
 * batching in memory and flushing on a timer. It exports sanitized structured
 * events derived from `main.log` rather than raw log text, because local logs can
 * include chats, prompts, tool payloads, paths, and tokens.
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

interface SafeLogRecord {
  msg: string
  category: string
  redacted: boolean
  attributes: Record<string, string>
}

interface QueuedRecord extends SafeLogRecord {
  timeUnixNano: string
  level: DesktopLogLevel
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


function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '')
}

function normalize(value: string): string {
  return stripAnsi(value).replace(/\s+/g, ' ').trim()
}

function bracketCategory(value: string): string | null {
  const match = value.match(/^\[([A-Za-z0-9:_./-]{1,80})\]/)
  return match?.[1] ?? null
}

function looksPrivate(value: string): boolean {
  return /\b(chat|conversation|transcript|prompt|completion|messages?|content|input|output|request body|response body|user message|assistant message|system message|tool result|claude|anthropic|openai|api[_-]?key|authorization|cookie|password|secret|token|cloud key)\b/i.test(value)
}

function looksOperational(value: string): boolean {
  return /\b(uncaught|exception|error|failed|failure|warn|warning|starting|started|startup|ready|listening|otel|signoz|trace|span|build|vite|bundle|compile|server|api|runtime|database|migration|window|update|port)\b/i.test(value)
}

function classifyMessage(value: string): string {
  const category = bracketCategory(value)
  if (category) return category
  if (/\b(uncaught|exception|error|failed|failure)\b/i.test(value)) return 'error'
  if (/\b(warn|warning)\b/i.test(value)) return 'warning'
  if (/\b(starting|started|startup|ready|listening)\b/i.test(value)) return 'startup'
  if (/\b(otel|signoz|trace|span)\b/i.test(value)) return 'telemetry'
  if (/\b(build|vite|bundle|compile)\b/i.test(value)) return 'build'
  if (/\b(server|api|runtime)\b/i.test(value)) return 'runtime'
  return 'desktop'
}

function toTemplateMessage(value: string): { msg: string; redacted: boolean } {
  let msg = normalize(value)
  let redacted = false
  const category = bracketCategory(msg)

  if (looksPrivate(msg) || (!category && !looksOperational(msg))) {
    return {
      msg: category ? `[${category}] private payload redacted` : 'desktop log redacted',
      redacted: true,
    }
  }

  const replacements: Array<[RegExp, string]> = [
    [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '<email>'],
    [/https?:\/\/[^\s)]+/gi, '<url>'],
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
    [/\b[0-9a-f]{32,}\b/gi, '<id>'],
    [/\b(?:sk|pk|rk|whsec|shogo_sk|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_=-]{12,}\b/g, '<secret>'],
    [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <secret>'],
    [/(?:[A-Za-z]:\\|\/Users\/|\/home\/|\/tmp\/|\/var\/)[^\s)]+/g, '<path>'],
    [/"[^"\\]*(?:\\.[^"\\]*)*"/g, '"<value>"'],
    [/'[^'\\]*(?:\\.[^'\\]*)*'/g, "'<value>'"],
  ]

  for (const [pattern, replacement] of replacements) {
    const next = msg.replace(pattern, replacement)
    if (next !== msg) redacted = true
    msg = next
  }

  if (msg.length > 220) {
    msg = `${msg.slice(0, 217)}...`
    redacted = true
  }

  return { msg, redacted }
}

function safeAttributeValue(value: unknown): string | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value !== 'string') return undefined
  if (!value || looksPrivate(value)) return undefined
  return toTemplateMessage(value).msg
}

function safeLogRecord(level: DesktopLogLevel, body: string): SafeLogRecord | null {
  const line = normalize(body)
  if (!line) return null

  let parsed: Record<string, unknown> | null = null
  if (line.startsWith('{') && line.endsWith('}')) {
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>
      }
    } catch {
      parsed = null
    }
  }

  const rawMsg = typeof parsed?.msg === 'string' ? parsed.msg : line
  const { msg, redacted } = toTemplateMessage(rawMsg)
  const category = classifyMessage(rawMsg)
  const attributes: Record<string, string> = {
    'log.source': 'main.log',
    'log.category': category,
    'log.redacted': redacted ? 'true' : 'false',
  }

  if (parsed) {
    for (const key of ['service', 'trace_id', 'span_id', 'code', 'status', 'statusCode', 'method']) {
      const safeValue = safeAttributeValue(parsed[key])
      if (safeValue) attributes[key === 'service' ? 'log.origin_service' : key] = safeValue
    }
  }

  return { msg, category, redacted, attributes }
}

/**
 * Initialize the exporter from env. The desktop build/release environment is
 * expected to provide `SIGNOZ_INGESTION_KEY`.
 * Safe to call once at startup; a second call is ignored. Returns whether the
 * exporter became active (useful for tests; callers may ignore it).
 */
export function initSignozLogExporter(opts: { serviceVersion?: string } = {}): boolean {
  if (enabled) return true
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
  const safe = safeLogRecord(level, body)
  if (!safe) return
  if (queue.length >= MAX_QUEUE) queue.shift()
  queue.push({
    timeUnixNano: `${Date.now()}000000`,
    level,
    ...safe,
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
              body: {
                stringValue: JSON.stringify({
                  timestamp: new Date(Number(r.timeUnixNano.slice(0, -6))).toISOString(),
                  level: r.level.toLowerCase(),
                  service: 'shogo-desktop',
                  msg: r.msg,
                  category: r.category,
                }),
              },
              attributes: Object.entries(r.attributes).map(([key, value]) => attr(key, value)),
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
