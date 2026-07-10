// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { diag, DiagConsoleLogger, DiagLogLevel, trace, SpanStatusCode } from '@opentelemetry/api'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { BatchSpanProcessor, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import { PrismaInstrumentation } from '@prisma/instrumentation'

const isEnabled = !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT

let sdk: NodeSDK | null = null

if (isEnabled) {
  // Enable OTEL diagnostic logging to surface export errors.
  // WARN shows failures only; switch to DEBUG for full request/response logging.
  const diagLevel = process.env.OTEL_LOG_LEVEL === 'debug' ? DiagLogLevel.DEBUG
    : process.env.OTEL_LOG_LEVEL === 'info' ? DiagLogLevel.INFO
    : DiagLogLevel.WARN
  diag.setLogger(new DiagConsoleLogger(), diagLevel)

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT!
  const headers: Record<string, string> = {}

  if (process.env.SIGNOZ_INGESTION_KEY) {
    headers['signoz-ingestion-key'] = process.env.SIGNOZ_INGESTION_KEY
  }

  console.log(`[OTEL] Configuring exporter → ${endpoint}/v1/traces`)
  console.log(`[OTEL] Ingestion key present: ${!!process.env.SIGNOZ_INGESTION_KEY}`)

  // Telemetry ingest is best-effort and must be non-blocking: a slow/unreachable
  // collector (SigNoz Cloud ingest timing out) must never block the request path
  // or delay process exit. Bound the export timeout so a failed flush resolves
  // fast in the background instead of hanging on the OTLP default (10s).
  const exportTimeoutMs = Number(process.env.OTEL_EXPORTER_TIMEOUT_MS ?? 3000)

  let traceExporter: OTLPTraceExporter
  try {
    traceExporter = new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
      headers,
      timeoutMillis: exportTimeoutMs,
    })
  } catch (err: any) {
    console.error(`[OTEL] Failed to create OTLPTraceExporter: ${err.message}`)
    console.error(`[OTEL] This is likely a Bun ESM/CJS interop issue. See: https://github.com/oven-sh/bun/issues/17311`)
    throw err
  }

  const isProduction = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging'
  // Background batching with a bounded queue: exports run off the hot path and a
  // persistently-unreachable collector drops spans instead of backing up.
  const spanProcessor = isProduction
    ? new BatchSpanProcessor(traceExporter, {
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 5000,
        exportTimeoutMillis: exportTimeoutMs,
      })
    : new SimpleSpanProcessor(traceExporter)

  let instrumentations: any[] = []
  try {
    instrumentations = [new PrismaInstrumentation()]
  } catch (err: any) {
    console.warn(`[OTEL] PrismaInstrumentation failed to initialize (likely import-in-the-middle incompatibility with Bun): ${err.message}`)
    console.warn(`[OTEL] Continuing without Prisma auto-instrumentation — manual spans still work`)
  }

  let metricReader: PeriodicExportingMetricReader | undefined
  try {
    const metricExporter = new OTLPMetricExporter({
      url: `${endpoint}/v1/metrics`,
      headers,
      timeoutMillis: exportTimeoutMs,
    })
    metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 15_000,
    })
    console.log(`[OTEL] Metrics exporter configured → ${endpoint}/v1/metrics (15s interval)`)
  } catch (err: any) {
    console.warn(`[OTEL] Failed to create metric exporter: ${err.message}`)
  }

  // NOTE: logs are intentionally NOT exported via OTLP here. The app-level OTLP
  // log export proved unreliable under Bun event-loop pressure (batches dropped
  // when the wall-clock export deadline elapsed), which is why API logs vanished
  // from SigNoz. Logs now reach SigNoz via the always-on k8s-infra otelAgent
  // DaemonSet that tails pod stdout; the structured console below stamps each
  // stdout line with trace_id/span_id so a SigNoz log pipeline can correlate
  // them with traces without depending on this process's OTLP export ("Option B").

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'shogo-api',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version || '0.1.0',
      'deployment.environment.name': process.env.NODE_ENV || 'development',
    }),
    spanProcessors: [spanProcessor],
    metricReader,
    instrumentations,
  })

  try {
    sdk.start()
    console.log(`[OTEL] Tracing enabled → ${endpoint}`)
  } catch (err: any) {
    console.error(`[OTEL] SDK failed to start: ${err.message}`)
    sdk = null
    throw err
  }

  // Fire a startup test span to verify the export pipeline is working.
  // If this span doesn't appear in SigNoz, the exporter itself is broken.
  try {
    const tracer = trace.getTracer('shogo-api')
    const testSpan = tracer.startSpan('otel.startup-test', {
      attributes: {
        'test.type': 'startup-verification',
        'runtime': typeof Bun !== 'undefined' ? 'bun' : 'node',
        'runtime.version': typeof Bun !== 'undefined' ? Bun.version : process.version,
      },
    })
    testSpan.setStatus({ code: SpanStatusCode.OK })
    testSpan.end()
    console.log(`[OTEL] Startup test span emitted`)
  } catch (err: any) {
    console.error(`[OTEL] Failed to emit test span: ${err.message}`)
  }

  // Patch console.* → trace-correlated structured JSON on stdout. Installed
  // after sdk.start() so `trace.getActiveSpan()` resolves against the live
  // tracer. This is the durable log path (scraped from stdout by the k8s-infra
  // DaemonSet); no-op outside prod/staging where plain-text console is kept.
  try {
    const { installStructuredConsole } = await import('./lib/structured-console')
    installStructuredConsole(process.env.OTEL_SERVICE_NAME || 'shogo-api')
  } catch (err: any) {
    console.warn(`[OTEL] Failed to install structured console: ${err.message}`)
  }
} else {
  console.log('[OTEL] Tracing disabled (OTEL_EXPORTER_OTLP_ENDPOINT not set)')
}

export async function shutdownTracing(): Promise<void> {
  if (!sdk) return
  // Bound shutdown so a hung final flush can't block process exit; telemetry
  // is best-effort and must never affect the host's exit code.
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
    console.error('[OTEL] Error shutting down tracing:', err.message)
  } finally {
    if (timer) clearTimeout(timer)
    sdk = null
  }
}
