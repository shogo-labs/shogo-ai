import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { BatchSpanProcessor, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import { PrismaInstrumentation } from '@prisma/instrumentation'

const isEnabled = !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT

let sdk: NodeSDK | null = null

if (isEnabled) {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT!
  const headers: Record<string, string> = {}

  if (process.env.SIGNOZ_INGESTION_KEY) {
    headers['signoz-ingestion-key'] = process.env.SIGNOZ_INGESTION_KEY
  }

  const traceExporter = new OTLPTraceExporter({
    url: `${endpoint}/v1/traces`,
    headers,
  })

  const isProduction = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging'
  const spanProcessor = isProduction
    ? new BatchSpanProcessor(traceExporter)
    : new SimpleSpanProcessor(traceExporter)

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'shogo-api',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version || '0.1.0',
      'deployment.environment.name': process.env.NODE_ENV || 'development',
    }),
    spanProcessors: [spanProcessor],
    instrumentations: [
      new PrismaInstrumentation(),
    ],
  })

  sdk.start()
  console.log(`[OTEL] Tracing enabled → ${endpoint}`)
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
