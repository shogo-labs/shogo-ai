// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * OpenTelemetry tracing setup for Shogo runtime services.
 *
 * Wires a `NodeSDK` with an OTLP HTTP trace exporter pointed at
 * `OTEL_EXPORTER_OTLP_ENDPOINT`, optionally authenticated via
 * `SIGNOZ_INGESTION_KEY`. In production / staging, spans are batched
 * before flush; in development a `SimpleSpanProcessor` flushes
 * eagerly so traces are visible immediately.
 *
 * Lifted into the SDK from `@shogo/shared-runtime` (was AGPL) under MIT.
 * The OpenTelemetry packages are optional `peerDependencies` of the SDK
 * — only consumers that actually call `initInstrumentation` need them
 * installed.
 *
 * @example
 *   import { initInstrumentation, traceOperation, shutdownInstrumentation }
 *     from '@shogo-ai/sdk/instrumentation'
 *
 *   initInstrumentation({ serviceName: 'my-api', serviceVersion: '1.0.0' })
 *
 *   await traceOperation('my-api', 'cold-start', { region: 'us-west' }, async (span) => {
 *     // ... boot work ...
 *     span.setAttribute('warm-pool-size', 4)
 *   })
 *
 *   process.on('SIGTERM', () => shutdownInstrumentation())
 */

import { diag, DiagConsoleLogger, DiagLogLevel, trace, SpanStatusCode, type Span } from '@opentelemetry/api'
import { logs, SeverityNumber } from '@opentelemetry/api-logs'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { BatchSpanProcessor, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { BatchLogRecordProcessor, SimpleLogRecordProcessor, type LogRecordProcessor } from '@opentelemetry/sdk-logs'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import { setOtelLogSink, type LogLevel } from './logger'

const SEVERITY_BY_LEVEL: Record<LogLevel, { number: SeverityNumber; text: string }> = {
  debug: { number: SeverityNumber.DEBUG, text: 'DEBUG' },
  info: { number: SeverityNumber.INFO, text: 'INFO' },
  warn: { number: SeverityNumber.WARN, text: 'WARN' },
  error: { number: SeverityNumber.ERROR, text: 'ERROR' },
}

let sdk: NodeSDK | null = null

export interface InstrumentationConfig {
  serviceName: string
  serviceVersion?: string
}

export function initInstrumentation(config: InstrumentationConfig): void {
  // Re-entrant / idempotent. Metal resumes call this again from
  // `/pool/refresh-env` when a snapshot-restored guest is handed an
  // `OTEL_EXPORTER_OTLP_ENDPOINT` it didn't have at boot (a suspend/restore
  // brings the process back with its boot-time env, so a guest that first
  // booted without the endpoint starts with telemetry DISABLED). Once the SDK
  // is live we MUST NOT rebuild it — doing so would leak a second NodeSDK,
  // duplicate exporters/processors, and register a second `createLogger` OTEL
  // sink (double-emitting every log). So if we're already running, no-op; the
  // running exporter keeps its boot-time endpoint/headers. Only when the SDK is
  // not yet live do we (re-)evaluate the endpoint below and start if present.
  if (sdk) return

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!endpoint) {
    console.log(`[OTEL] Tracing disabled for ${config.serviceName} (OTEL_EXPORTER_OTLP_ENDPOINT not set)`)
    return
  }

  const diagLevel = process.env.OTEL_LOG_LEVEL === 'debug' ? DiagLogLevel.DEBUG
    : process.env.OTEL_LOG_LEVEL === 'info' ? DiagLogLevel.INFO
    : DiagLogLevel.WARN
  diag.setLogger(new DiagConsoleLogger(), diagLevel)

  const headers: Record<string, string> = {}
  if (process.env.SIGNOZ_INGESTION_KEY) {
    headers['signoz-ingestion-key'] = process.env.SIGNOZ_INGESTION_KEY
  }

  const serviceName = process.env.OTEL_SERVICE_NAME || config.serviceName

  console.log(`[OTEL] Configuring ${serviceName} → ${endpoint}/v1/traces`)

  // Telemetry ingest MUST be non-blocking and happen in the background: a slow
  // or unreachable collector (e.g. SigNoz Cloud ingest timing out) must never
  // block, delay, or fail the host process. In prod we observed OTLP exports
  // hanging on the default 10s timeout and surfacing as spurious non-zero exits
  // in short-lived `shogo generate` / `server.tsx` boots — which then cascaded
  // into the API-sidecar crash loop and 503s. Bounding the export timeout keeps
  // a failed flush from lingering on the event loop.
  const exportTimeoutMs = Number(process.env.OTEL_EXPORTER_TIMEOUT_MS ?? 3000)

  let traceExporter: OTLPTraceExporter
  try {
    traceExporter = new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
      headers,
      timeoutMillis: exportTimeoutMs,
    })
  } catch (err: any) {
    console.error(`[OTEL] Failed to create exporter: ${err.message}`)
    return
  }

  const isProduction = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging'
  // Background batching with a bounded queue: spans flush off the hot path on a
  // timer, and a persistently-unreachable collector drops spans (bounded
  // memory) instead of backing up or blocking. Dev keeps the eager
  // SimpleSpanProcessor for immediate local visibility — still bounded by the
  // short export timeout above.
  const spanProcessor = isProduction
    ? new BatchSpanProcessor(traceExporter, {
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 5000,
        exportTimeoutMillis: exportTimeoutMs,
      })
    : new SimpleSpanProcessor(traceExporter)

  // Logs: export structured log records (emitted via `createLogger`) to the
  // same OTLP endpoint on /v1/logs, correlated with the active span. Batched
  // in prod so exports stay off the hot path; eager in dev for visibility.
  let logRecordProcessors: LogRecordProcessor[] = []
  try {
    const logExporter = new OTLPLogExporter({
      url: `${endpoint}/v1/logs`,
      headers,
      timeoutMillis: exportTimeoutMs,
    })
    logRecordProcessors = [
      isProduction
        ? new BatchLogRecordProcessor(logExporter, {
            maxQueueSize: 2048,
            maxExportBatchSize: 512,
            scheduledDelayMillis: 5000,
            exportTimeoutMillis: exportTimeoutMs,
          })
        : new SimpleLogRecordProcessor(logExporter),
    ]
  } catch (err: any) {
    console.warn(`[OTEL] Failed to create log exporter for ${serviceName}: ${err.message}`)
  }

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: config.serviceVersion || '0.1.0',
      'deployment.environment.name': process.env.NODE_ENV || 'development',
    }),
    spanProcessors: [spanProcessor],
    logRecordProcessors,
    instrumentations: [],
  })

  try {
    sdk.start()
    console.log(`[OTEL] Tracing enabled for ${serviceName}`)
  } catch (err: any) {
    console.error(`[OTEL] SDK failed to start: ${err.message}`)
    sdk = null
    return
  }

  // Route `createLogger` output through the OTEL LoggerProvider that NodeSDK
  // registered globally, so runtime-service logs land in SigNoz correlated
  // with traces. No-op if the log exporter above failed to initialize.
  if (logRecordProcessors.length > 0) {
    const otelLogger = logs.getLogger(serviceName)
    setOtelLogSink((entry) => {
      const { level, msg, service, timestamp, ...attrs } = entry
      const severity = SEVERITY_BY_LEVEL[level] ?? SEVERITY_BY_LEVEL.info
      otelLogger.emit({
        severityNumber: severity.number,
        severityText: severity.text,
        body: msg,
        attributes: { service, ...attrs },
      })
    })
    console.log(`[OTEL] Logs exporter enabled for ${serviceName} → ${endpoint}/v1/logs`)
  }

  // Emit a startup verification span so devs can quickly confirm the
  // exporter is wired (visible in SigNoz / Jaeger as `otel.startup-test`).
  try {
    const tracer = trace.getTracer(serviceName)
    const testSpan = tracer.startSpan('otel.startup-test', {
      attributes: {
        'test.type': 'startup-verification',
        'service.name': serviceName,
        // `process.versions.bun` is present under Bun (always undefined
        // under plain Node) — avoids referencing the `Bun` global so
        // this file typechecks without `@types/bun` in tsconfig.
        'runtime': (process.versions as { bun?: string }).bun ? 'bun' : 'node',
      },
    })
    testSpan.setStatus({ code: SpanStatusCode.OK })
    testSpan.end()
    console.log(`[OTEL] Startup test span emitted for ${serviceName}`)
  } catch (err: any) {
    console.error(`[OTEL] Failed to emit test span: ${err.message}`)
  }
}

export async function shutdownInstrumentation(): Promise<void> {
  if (!sdk) return
  // Stop forwarding logs before the provider shuts down.
  setOtelLogSink(null)
  // Never let a hung flush block process shutdown — race the SDK's final
  // export against a short deadline so exit is bounded even if the collector
  // is unreachable. Errors are swallowed (telemetry is best-effort and must
  // not affect the host's exit code).
  const shutdownTimeoutMs = Number(process.env.OTEL_SHUTDOWN_TIMEOUT_MS ?? 2000)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      sdk.shutdown(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, shutdownTimeoutMs)
      }),
    ])
    console.log('[OTEL] Tracing shut down')
  } catch (err: any) {
    console.error('[OTEL] Error shutting down:', err.message)
  } finally {
    if (timer) clearTimeout(timer)
    sdk = null
  }
}

/**
 * Trace a function execution with automatic error recording and timing.
 * Use for key operations like cold starts, builds, tool calls, etc.
 */
export function traceOperation<T>(
  tracerName: string,
  spanName: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(tracerName)
  return tracer.startActiveSpan(spanName, { attributes }, async (span: Span) => {
    try {
      const result = await fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (err: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
      span.recordException(err)
      throw err
    } finally {
      span.end()
    }
  })
}
