// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, it, expect, afterEach } from 'bun:test'
import { initSignozLogExporter, exportLogLine, flush, shutdownSignozLogExporter } from '../signoz-log-exporter'

const ENDPOINT = 'OTEL_EXPORTER_OTLP_ENDPOINT'
const KEY = 'SIGNOZ_INGESTION_KEY'

function withEnv(vars: Record<string, string | undefined>, run: () => void | Promise<void>) {
  const previous = new Map(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return run()
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** Swap in a fetch spy and return the calls it recorded. */
function captureFetch(): { calls: Array<{ url: string; headers: Record<string, string> }>; restore: () => void } {
  const original = globalThis.fetch
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} })
    return new Response(null, { status: 200 })
  }) as unknown as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

afterEach(async () => {
  await shutdownSignozLogExporter()
})

describe('initSignozLogExporter gating', () => {
  it('stays disabled when no collector endpoint is configured', async () => {
    const fetchSpy = captureFetch()
    try {
      await withEnv({ [ENDPOINT]: undefined, [KEY]: undefined }, async () => {
        expect(initSignozLogExporter()).toBe(false)
        exportLogLine('ERROR', '[Desktop] something failed')
        await flush()
        expect(fetchSpy.calls).toHaveLength(0)
      })
    } finally {
      fetchSpy.restore()
    }
  })

  it('stays disabled when only an ingestion key is present', async () => {
    const fetchSpy = captureFetch()
    try {
      await withEnv({ [ENDPOINT]: undefined, [KEY]: 'test-key' }, async () => {
        expect(initSignozLogExporter()).toBe(false)
        exportLogLine('ERROR', '[Desktop] something failed')
        await flush()
        expect(fetchSpy.calls).toHaveLength(0)
      })
    } finally {
      fetchSpy.restore()
    }
  })

  it('exports to the configured endpoint once one is set', async () => {
    const fetchSpy = captureFetch()
    try {
      await withEnv({ [ENDPOINT]: 'https://collector.example.com', [KEY]: 'test-key' }, async () => {
        expect(initSignozLogExporter()).toBe(true)
        exportLogLine('ERROR', '[Desktop] something failed')
        await flush()
        expect(fetchSpy.calls).toHaveLength(1)
        expect(fetchSpy.calls[0]!.url).toBe('https://collector.example.com/v1/logs')
        expect(fetchSpy.calls[0]!.headers['signoz-ingestion-key']).toBe('test-key')
      })
    } finally {
      fetchSpy.restore()
    }
  })

  it('supports an unauthenticated self-hosted collector', async () => {
    const fetchSpy = captureFetch()
    try {
      await withEnv({ [ENDPOINT]: 'http://localhost:4318/', [KEY]: undefined }, async () => {
        expect(initSignozLogExporter()).toBe(true)
        exportLogLine('INFO', '[Desktop] started')
        await flush()
        expect(fetchSpy.calls).toHaveLength(1)
        expect(fetchSpy.calls[0]!.url).toBe('http://localhost:4318/v1/logs')
        expect(fetchSpy.calls[0]!.headers['signoz-ingestion-key']).toBeUndefined()
      })
    } finally {
      fetchSpy.restore()
    }
  })
})
