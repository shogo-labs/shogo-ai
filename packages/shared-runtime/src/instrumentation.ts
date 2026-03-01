import { diag, DiagConsoleLogger, DiagLogLevel, trace, SpanStatusCode, type Span } from '@opentelemetry/api'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { BatchSpanProcessor, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'

let sdk: NodeSDK | null = null

export interface InstrumentationConfig {
  serviceName: string
  serviceVersion?: string
}

export function initInstrumentation(config: InstrumentationConfig): void {
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

  let traceExporter: OTLPTraceExporter
  try {
    traceExporter = new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
      headers,
    })
  } catch (err: any) {
    console.error(`[OTEL] Failed to create exporter: ${err.message}`)
    return
  }

  const isProduction = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging'
  const spanProcessor = isProduction
    ? new BatchSpanProcessor(traceExporter)
    : new SimpleSpanProcessor(traceExporter)

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: config.serviceVersion || '0.1.0',
      'deployment.environment.name': process.env.NODE_ENV || 'development',
    }),
    spanProcessors: [spanProcessor],
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

  // Emit a startup verification span
  try {
    const tracer = trace.getTracer(serviceName)
    const testSpan = tracer.startSpan('otel.startup-test', {
      attributes: {
        'test.type': 'startup-verification',
        'service.name': serviceName,
        'runtime': typeof Bun !== 'undefined' ? 'bun' : 'node',
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
  if (sdk) {
    try {
      await sdk.shutdown()
      console.log('[OTEL] Tracing shut down')
    } catch (err: any) {
      console.error('[OTEL] Error shutting down:', err.message)
    }
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
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = trace.getTracer(tracerName)
  return tracer.startActiveSpan(spanName, { attributes }, async (span) => {
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
