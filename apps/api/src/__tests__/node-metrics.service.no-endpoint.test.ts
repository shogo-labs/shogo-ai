// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Covers the `!SIGNOZ_ENDPOINT` early-return path of
 * src/services/node-metrics.service.ts (line 59).
 *
 * SIGNOZ_QUERY_ENDPOINT and OTEL_EXPORTER_OTLP_ENDPOINT are captured at
 * module-load time, so we explicitly clear them BEFORE the dynamic
 * import and isolate the module cache for this file.
 */

delete process.env.SIGNOZ_QUERY_ENDPOINT
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
delete process.env.SIGNOZ_INGESTION_KEY

import { describe, expect, mock, test } from 'bun:test'

mock.module('../lib/prisma', () => ({
  prisma: {
    workspace: { findUnique: mock(async () => ({ id: 'ws_1' })) },
    project: { findMany: mock(async () => []) },
  },
}))

const { getWorkspaceMetrics } = await import('../services/node-metrics.service')

describe('getWorkspaceMetrics — SIGNOZ_ENDPOINT unset', () => {
  test('returns zero-fill fallback metrics without hitting the network', async () => {
    const result = await getWorkspaceMetrics('ws_1', '24h')
    expect(result).toEqual({
      current: { cpuPercent: 0, memoryBytes: 0, memoryTotalBytes: 0 },
      history: { timestamps: [], cpuPercent: [], memoryBytes: [] },
      period: '24h',
    })
  })

  test('returns the same zero-fill shape for a 1h period', async () => {
    const result = await getWorkspaceMetrics('ws_1', '1h')
    expect(result?.period).toBe('1h')
    expect(result?.current.cpuPercent).toBe(0)
  })
})
