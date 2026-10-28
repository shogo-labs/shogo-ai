// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The chain-pause counter is the only way to answer "how often does each
 * backstop limit fire?", so it is worth proving it emits with the right name
 * and the right label rather than trusting that it does.
 */

import { describe, expect, spyOn, test } from 'bun:test'
import { metrics } from '@opentelemetry/api'
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'

// The counter is created when the module loads, so the provider has to be
// registered first — the same ordering apps/api/src/entry.ts guarantees in
// production by importing instrumentation before the server.
const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
const provider = new MeterProvider({
  readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
})
metrics.setGlobalMeterProvider(provider)

const { recordChainPaused } = await import('../lib/agent-chain-metrics')

interface CollectedPoint { value: number; attributes: Record<string, unknown> }

async function pausedPoints(): Promise<CollectedPoint[]> {
  await provider.forceFlush()
  const batches = exporter.getMetrics()
    .flatMap((rm) => rm.scopeMetrics)
    .flatMap((sm) => sm.metrics)
    .filter((m) => m.descriptor.name === 'agent_chain.paused')
  return batches.flatMap((m) => m.dataPoints as unknown as CollectedPoint[])
}

describe('recordChainPaused', () => {
  test('counts one pause per limit and keeps the ids off the metric', async () => {
    const info = spyOn(console, 'info').mockImplementation(() => {})
    try {
      recordChainPaused({
        limit: 'thread_turns',
        turns: 100,
        depth: 4,
        max: 100,
        workspaceId: 'w1',
        conversationId: 'c1',
        threadRootId: 't1',
      })
      recordChainPaused({ limit: 'depth', turns: 7, depth: 24, max: 24, workspaceId: 'w1', conversationId: 'c1', threadRootId: 't1' })
      recordChainPaused({ limit: 'depth', turns: 9, depth: 24, max: 24, workspaceId: 'w2', conversationId: 'c2', threadRootId: 't2' })

      expect(info).toHaveBeenCalledTimes(3)
      expect(info.mock.calls[0]).toEqual([
        '[ChannelAgent] chain paused',
        { limit: 'thread_turns', turns: 100, depth: 4, max: 100, workspaceId: 'w1', conversationId: 'c1', threadRootId: 't1' },
      ])

      const points = await pausedPoints()
      expect(points.map((p) => p.attributes).sort((a, b) => String(a.limit).localeCompare(String(b.limit))))
        .toEqual([{ limit: 'depth' }, { limit: 'thread_turns' }])
      expect(points.find((p) => p.attributes.limit === 'depth')?.value).toBe(2)
      expect(points.find((p) => p.attributes.limit === 'thread_turns')?.value).toBe(1)
    } finally {
      info.mockRestore()
    }
  })
})
