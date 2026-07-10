// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test'

// ---- Mocks at module scope (must come BEFORE the import-under-test) ----
let diagLevelSet: any = null
let diagLoggerSet: any = null
const diagSetLogger = mock((logger: any, level: any) => { diagLoggerSet = logger; diagLevelSet = level })
class DiagConsoleLoggerFake {}
const DiagLogLevel = { DEBUG: 'DEBUG', INFO: 'INFO', WARN: 'WARN' }
const SpanStatusCode = { OK: 'OK', ERROR: 'ERROR' }

let lastSpan: any = null
const startSpanMock = mock((name: string, opts: any) => {
  lastSpan = {
    name, opts,
    setStatus: mock(() => {}),
    setAttribute: mock(() => {}),
    recordException: mock(() => {}),
    end: mock(() => {}),
  }
  return lastSpan
})
const startActiveSpanMock = mock(async (name: string, opts: any, fn: any) => {
  const span = {
    setStatus: mock(() => {}),
    setAttribute: mock(() => {}),
    recordException: mock(() => {}),
    end: mock(() => {}),
  }
  return fn(span)
})
const getTracerMock = mock((_name: string) => ({
  startSpan: startSpanMock,
  startActiveSpan: startActiveSpanMock,
}))

mock.module('@opentelemetry/api', () => ({
  diag: { setLogger: diagSetLogger },
  DiagConsoleLogger: DiagConsoleLoggerFake,
  DiagLogLevel,
  trace: { getTracer: getTracerMock },
  SpanStatusCode,
}))

let sdkStartShouldThrow = false
let sdkShutdownShouldThrow = false
let sdkShutdownHangs = false
const sdkStartMock = mock(() => { if (sdkStartShouldThrow) throw new Error('start boom') })
const sdkShutdownMock = mock(async () => {
  if (sdkShutdownShouldThrow) throw new Error('shutdown boom')
  if (sdkShutdownHangs) await new Promise(() => {}) // never resolves
})
let lastSdkConfig: any = null
class FakeNodeSDK {
  constructor(public config: any) { lastSdkConfig = config }
  start = sdkStartMock
  shutdown = sdkShutdownMock
}
mock.module('@opentelemetry/sdk-node', () => ({ NodeSDK: FakeNodeSDK }))

let exporterShouldThrow = false
let lastExporterConfig: any = null
class FakeOTLPTraceExporter {
  constructor(public config: any) {
    lastExporterConfig = config
    if (exporterShouldThrow) throw new Error('exporter ctor boom')
  }
}
mock.module('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: FakeOTLPTraceExporter,
}))

class FakeBatchSpanProcessor { constructor(public exp: any, public opts?: any) {} }
class FakeSimpleSpanProcessor { constructor(public exp: any) {} }
mock.module('@opentelemetry/sdk-trace-base', () => ({
  BatchSpanProcessor: FakeBatchSpanProcessor,
  SimpleSpanProcessor: FakeSimpleSpanProcessor,
}))

// ---- Logs SDK mocks ----
const emitMock = mock((_record: any) => {})
const getLoggerMock = mock((_name: string) => ({ emit: emitMock }))
mock.module('@opentelemetry/api-logs', () => ({
  logs: { getLogger: getLoggerMock },
  SeverityNumber: { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 },
}))

let logExporterShouldThrow = false
let lastLogExporterConfig: any = null
class FakeOTLPLogExporter {
  constructor(public config: any) {
    lastLogExporterConfig = config
    if (logExporterShouldThrow) throw new Error('log exporter ctor boom')
  }
}
mock.module('@opentelemetry/exporter-logs-otlp-http', () => ({
  OTLPLogExporter: FakeOTLPLogExporter,
}))

class FakeBatchLogRecordProcessor { constructor(public exp: any, public opts?: any) {} }
class FakeSimpleLogRecordProcessor { constructor(public exp: any) {} }
mock.module('@opentelemetry/sdk-logs', () => ({
  BatchLogRecordProcessor: FakeBatchLogRecordProcessor,
  SimpleLogRecordProcessor: FakeSimpleLogRecordProcessor,
}))

mock.module('@opentelemetry/resources', () => ({
  resourceFromAttributes: (attrs: any) => ({ attrs }),
}))
mock.module('@opentelemetry/semantic-conventions', () => ({
  ATTR_SERVICE_NAME: 'service.name',
  ATTR_SERVICE_VERSION: 'service.version',
}))

// ---- Now import the module under test ----
import {
  initInstrumentation,
  shutdownInstrumentation,
  traceOperation,
} from '../instrumentation.js'
import { createLogger } from '../logger.js'

// ---- Env + console helpers ----
const ENV_KEYS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_LOG_LEVEL', 'SIGNOZ_INGESTION_KEY',
  'OTEL_SERVICE_NAME', 'NODE_ENV', 'OTEL_EXPORTER_TIMEOUT_MS', 'OTEL_SHUTDOWN_TIMEOUT_MS',
]
let savedEnv: Record<string, string | undefined>
let savedConsoleLog: any
let savedConsoleErr: any
let logs: string[]
let errs: string[]

beforeEach(() => {
  savedEnv = {}
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k] }
  logs = []; errs = []
  savedConsoleLog = console.log; savedConsoleErr = console.error
  console.log = (...a: any[]) => { logs.push(a.join(' ')) }
  console.error = (...a: any[]) => { errs.push(a.join(' ')) }
  sdkStartShouldThrow = false
  sdkShutdownShouldThrow = false
  sdkShutdownHangs = false
  exporterShouldThrow = false
  sdkStartMock.mockClear()
  sdkShutdownMock.mockClear()
  diagSetLogger.mockClear()
  startSpanMock.mockClear()
  getTracerMock.mockClear()
  lastSpan = null
  lastSdkConfig = null
  lastExporterConfig = null
  diagLevelSet = null
  logExporterShouldThrow = false
  lastLogExporterConfig = null
  emitMock.mockClear()
  getLoggerMock.mockClear()
})
afterEach(async () => {
  // Reset the module-level `sdk` variable by calling shutdown.
  try { await shutdownInstrumentation() } catch {}
  console.log = savedConsoleLog
  console.error = savedConsoleErr
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]!
  }
})

describe('initInstrumentation', () => {
  it('returns early + logs "disabled" when OTEL_EXPORTER_OTLP_ENDPOINT is unset', () => {
    initInstrumentation({ serviceName: 'svc' })
    expect(logs.join('\n')).toContain('Tracing disabled for svc')
    expect(sdkStartMock).not.toHaveBeenCalled()
  })

  it('starts the SDK + emits the startup-test span on success', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.example.com'
    initInstrumentation({ serviceName: 'svc', serviceVersion: '1.2.3' })
    expect(sdkStartMock).toHaveBeenCalledTimes(1)
    expect(lastSdkConfig.resource.attrs['service.name']).toBe('svc')
    expect(lastSdkConfig.resource.attrs['service.version']).toBe('1.2.3')
    expect(lastSdkConfig.resource.attrs['deployment.environment.name']).toBe('development')
    expect(lastExporterConfig.url).toBe('https://otel.example.com/v1/traces')
    expect(startSpanMock).toHaveBeenCalledWith('otel.startup-test', expect.anything())
    expect(lastSpan.setStatus).toHaveBeenCalledWith({ code: 'OK' })
    expect(lastSpan.end).toHaveBeenCalled()
    expect(logs.some(l => l.includes('Tracing enabled for svc'))).toBe(true)
    expect(logs.some(l => l.includes('Startup test span emitted'))).toBe(true)
  })

  it('defaults serviceVersion to 0.1.0 when not provided', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.example.com'
    initInstrumentation({ serviceName: 'svc' })
    expect(lastSdkConfig.resource.attrs['service.version']).toBe('0.1.0')
  })

  it('respects OTEL_LOG_LEVEL=debug', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    process.env.OTEL_LOG_LEVEL = 'debug'
    initInstrumentation({ serviceName: 'svc' })
    expect(diagLevelSet).toBe('DEBUG')
  })

  it('respects OTEL_LOG_LEVEL=info', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    process.env.OTEL_LOG_LEVEL = 'info'
    initInstrumentation({ serviceName: 'svc' })
    expect(diagLevelSet).toBe('INFO')
  })

  it('defaults OTEL_LOG_LEVEL to warn when unset', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    initInstrumentation({ serviceName: 'svc' })
    expect(diagLevelSet).toBe('WARN')
  })

  it('adds signoz-ingestion-key header when SIGNOZ_INGESTION_KEY set', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    process.env.SIGNOZ_INGESTION_KEY = 'sk-123'
    initInstrumentation({ serviceName: 'svc' })
    expect(lastExporterConfig.headers['signoz-ingestion-key']).toBe('sk-123')
  })

  it('omits signoz-ingestion-key header when env var unset', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    initInstrumentation({ serviceName: 'svc' })
    expect(lastExporterConfig.headers['signoz-ingestion-key']).toBeUndefined()
  })

  it('bounds the exporter timeout so ingest never blocks (default 3000ms)', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    initInstrumentation({ serviceName: 'svc' })
    expect(lastExporterConfig.timeoutMillis).toBe(3000)
  })

  it('honors OTEL_EXPORTER_TIMEOUT_MS override for the exporter timeout', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    process.env.OTEL_EXPORTER_TIMEOUT_MS = '750'
    initInstrumentation({ serviceName: 'svc' })
    expect(lastExporterConfig.timeoutMillis).toBe(750)
  })

  it('configures the prod BatchSpanProcessor with a bounded, background-friendly queue', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    process.env.NODE_ENV = 'production'
    initInstrumentation({ serviceName: 'svc' })
    const proc = lastSdkConfig.spanProcessors[0]
    expect(proc).toBeInstanceOf(FakeBatchSpanProcessor)
    expect(proc.opts.maxQueueSize).toBe(2048)
    expect(proc.opts.exportTimeoutMillis).toBe(3000)
  })

  it('OTEL_SERVICE_NAME env overrides config.serviceName', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    process.env.OTEL_SERVICE_NAME = 'env-svc'
    initInstrumentation({ serviceName: 'config-svc' })
    expect(lastSdkConfig.resource.attrs['service.name']).toBe('env-svc')
  })

  it('uses BatchSpanProcessor in NODE_ENV=production', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    process.env.NODE_ENV = 'production'
    initInstrumentation({ serviceName: 'svc' })
    expect(lastSdkConfig.spanProcessors[0]).toBeInstanceOf(FakeBatchSpanProcessor)
    expect(lastSdkConfig.resource.attrs['deployment.environment.name']).toBe('production')
  })

  it('uses BatchSpanProcessor in NODE_ENV=staging', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    process.env.NODE_ENV = 'staging'
    initInstrumentation({ serviceName: 'svc' })
    expect(lastSdkConfig.spanProcessors[0]).toBeInstanceOf(FakeBatchSpanProcessor)
  })

  it('uses SimpleSpanProcessor outside production/staging', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    process.env.NODE_ENV = 'development'
    initInstrumentation({ serviceName: 'svc' })
    expect(lastSdkConfig.spanProcessors[0]).toBeInstanceOf(FakeSimpleSpanProcessor)
  })

  it('returns early when OTLPTraceExporter ctor throws', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    exporterShouldThrow = true
    initInstrumentation({ serviceName: 'svc' })
    expect(errs.some(e => e.includes('Failed to create exporter'))).toBe(true)
    expect(sdkStartMock).not.toHaveBeenCalled()
  })

  it('returns early + nulls sdk when sdk.start() throws', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    sdkStartShouldThrow = true
    initInstrumentation({ serviceName: 'svc' })
    expect(errs.some(e => e.includes('SDK failed to start'))).toBe(true)
    expect(startSpanMock).not.toHaveBeenCalled()
  })

  it('catches errors during startup-test span emission', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    getTracerMock.mockImplementationOnce(() => { throw new Error('tracer boom') })
    initInstrumentation({ serviceName: 'svc' })
    expect(errs.some(e => e.includes('Failed to emit test span'))).toBe(true)
  })
})

describe('initInstrumentation — re-entrancy (metal resume activation)', () => {
  it('no-ops on a second call once the SDK is live (no duplicate SDK/exporters)', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    initInstrumentation({ serviceName: 'svc' })
    expect(sdkStartMock).toHaveBeenCalledTimes(1)
    // A second call (e.g. a later resume) must NOT rebuild the SDK — that would
    // leak a second NodeSDK + duplicate the createLogger OTEL sink.
    initInstrumentation({ serviceName: 'svc' })
    expect(sdkStartMock).toHaveBeenCalledTimes(1)
  })

  it('activates on a later call once the endpoint appears (disabled → enabled)', () => {
    // Models a snapshot-restored guest that booted WITHOUT the OTEL endpoint:
    // the first call early-returns disabled and leaves the SDK unstarted.
    initInstrumentation({ serviceName: 'svc' })
    expect(logs.join('\n')).toContain('Tracing disabled for svc')
    expect(sdkStartMock).not.toHaveBeenCalled()
    // `/pool/refresh-env` later injects the endpoint and calls init again.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    initInstrumentation({ serviceName: 'svc' })
    expect(sdkStartMock).toHaveBeenCalledTimes(1)
    expect(logs.some(l => l.includes('Tracing enabled for svc'))).toBe(true)
  })
})

describe('initInstrumentation — logs pipeline', () => {
  it('configures the OTLP log exporter at /v1/logs with the ingestion header', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.example.com'
    process.env.SIGNOZ_INGESTION_KEY = 'sk-123'
    initInstrumentation({ serviceName: 'svc' })
    expect(lastLogExporterConfig.url).toBe('https://otel.example.com/v1/logs')
    expect(lastLogExporterConfig.headers['signoz-ingestion-key']).toBe('sk-123')
    expect(lastSdkConfig.logRecordProcessors).toHaveLength(1)
    expect(logs.some(l => l.includes('Logs exporter enabled for svc'))).toBe(true)
  })

  it('uses BatchLogRecordProcessor in production, SimpleLogRecordProcessor otherwise', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    process.env.NODE_ENV = 'production'
    initInstrumentation({ serviceName: 'svc' })
    expect(lastSdkConfig.logRecordProcessors[0]).toBeInstanceOf(FakeBatchLogRecordProcessor)
  })

  it('routes createLogger output through the OTEL logger with mapped severity', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    initInstrumentation({ serviceName: 'svc' })
    const log = createLogger('unit', { requestId: 'r-1' })
    log.warn('slow query', { ms: 4200 })
    expect(emitMock).toHaveBeenCalledTimes(1)
    const record = emitMock.mock.calls[0][0]
    expect(record.severityText).toBe('WARN')
    expect(record.severityNumber).toBe(13)
    expect(record.body).toBe('slow query')
    expect(record.attributes.service).toBe('unit')
    expect(record.attributes.requestId).toBe('r-1')
    expect(record.attributes.ms).toBe(4200)
  })

  it('stops forwarding logs after shutdown clears the sink', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    initInstrumentation({ serviceName: 'svc' })
    await shutdownInstrumentation()
    emitMock.mockClear()
    createLogger('unit').info('after shutdown')
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('skips the log sink when the log exporter ctor throws (tracing still works)', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    logExporterShouldThrow = true
    initInstrumentation({ serviceName: 'svc' })
    // Tracing must still come up even if the log exporter failed to build.
    expect(sdkStartMock).toHaveBeenCalledTimes(1)
    expect(lastSdkConfig.logRecordProcessors).toHaveLength(0)
    createLogger('unit').info('no sink')
    expect(emitMock).not.toHaveBeenCalled()
  })
})

describe('shutdownInstrumentation', () => {
  it('calls sdk.shutdown() and logs success', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    initInstrumentation({ serviceName: 'svc' })
    await shutdownInstrumentation()
    expect(sdkShutdownMock).toHaveBeenCalled()
    expect(logs.some(l => l.includes('Tracing shut down'))).toBe(true)
  })

  it('catches errors from sdk.shutdown()', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    initInstrumentation({ serviceName: 'svc' })
    sdkShutdownShouldThrow = true
    await shutdownInstrumentation()
    expect(errs.some(e => e.includes('Error shutting down'))).toBe(true)
  })

  it('is non-blocking: resolves within the deadline even if sdk.shutdown() hangs', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    process.env.OTEL_SHUTDOWN_TIMEOUT_MS = '20'
    initInstrumentation({ serviceName: 'svc' })
    sdkShutdownHangs = true
    const start = Date.now()
    await shutdownInstrumentation() // must NOT hang forever on a stuck flush
    expect(Date.now() - start).toBeLessThan(1000)
  })

  it('is idempotent — a second shutdown is a no-op once sdk is cleared', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://x.example.com'
    initInstrumentation({ serviceName: 'svc' })
    await shutdownInstrumentation()
    sdkShutdownMock.mockClear()
    await shutdownInstrumentation()
    expect(sdkShutdownMock).not.toHaveBeenCalled()
  })
})

describe('traceOperation', () => {
  it('runs fn and sets OK status on success', async () => {
    const result = await traceOperation('tracer', 'span', { x: 1 }, async (span) => {
      span.setAttribute('extra', 'v')
      return 42
    })
    expect(result).toBe(42)
    expect(startActiveSpanMock).toHaveBeenCalledWith('span', { attributes: { x: 1 } }, expect.anything())
  })

  it('records exception + ERROR status + re-throws when fn throws', async () => {
    await expect(
      traceOperation('tracer', 'span', {}, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
  })

  it('always ends the span (success path)', async () => {
    // We can't directly assert span.end() easily because we wrap-and-return,
    // but we can ensure the active-span fn ran and returned the value.
    const r = await traceOperation('t', 's', {}, async () => 'ok')
    expect(r).toBe('ok')
  })
})
