import { diag, DiagConsoleLogger, DiagLogLevel, trace, SpanStatusCode } from '@opentelemetry/api'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
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

  let traceExporter: OTLPTraceExporter
  try {
    traceExporter = new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
      headers,
    })
  } catch (err: any) {
    console.error(`[OTEL] Failed to create OTLPTraceExporter: ${err.message}`)
    console.error(`[OTEL] This is likely a Bun ESM/CJS interop issue. See: https://github.com/oven-sh/bun/issues/17311`)
    throw err
  }

  const isProduction = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging'
  const spanProcessor = isProduction
    ? new BatchSpanProcessor(traceExporter)
    : new SimpleSpanProcessor(traceExporter)

  let instrumentations: any[] = []
  try {
    instrumentations = [new PrismaInstrumentation()]
  } catch (err: any) {
    console.warn(`[OTEL] PrismaInstrumentation failed to initialize (likely import-in-the-middle incompatibility with Bun): ${err.message}`)
    console.warn(`[OTEL] Continuing without Prisma auto-instrumentation — manual spans still work`)
  }

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'shogo-api',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version || '0.1.0',
      'deployment.environment.name': process.env.NODE_ENV || 'development',
    }),
    spanProcessors: [spanProcessor],
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
} else {
  console.log('[OTEL] Tracing disabled (OTEL_EXPORTER_OTLP_ENDPOINT not set)')
}

export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    try {
      await sdk.shutdown()
      console.log('[OTEL] Tracing shut down')
    } catch (err: any) {
      console.error('[OTEL] Error shutting down tracing:', err.message)
    }
  }
}
