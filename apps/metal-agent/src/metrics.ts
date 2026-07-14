// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Lightweight in-process metrics for the node-agent. The agent is a single
 * dependency-free `bun run`, so rather than pull in an OTel SDK we keep plain
 * counters/gauges here and surface them two ways:
 *   - GET /metrics  → Prometheus text (host scrape / node_exporter sidecar);
 *   - the registration heartbeat folds a compact summary into the control-plane
 *     payload, where apps/api already emits OTel (metal.* series). So the same
 *     numbers reach Datadog via the path metal metrics already travel.
 */

class Metrics {
  private counters = new Map<string, number>()
  private gauges = new Map<string, number>()

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by)
  }
  gauge(name: string, value: number): void {
    this.gauges.set(name, value)
  }
  getCounter(name: string): number {
    return this.counters.get(name) ?? 0
  }
  getGauge(name: string): number {
    return this.gauges.get(name) ?? 0
  }

  /** Compact object for the heartbeat + /vms. */
  snapshot(): { counters: Record<string, number>; gauges: Record<string, number> } {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
    }
  }

  /** Prometheus exposition format. */
  prometheus(): string {
    const lines: string[] = []
    for (const [k, v] of this.counters) lines.push(`${k} ${v}`)
    for (const [k, v] of this.gauges) lines.push(`${k} ${v}`)
    return lines.join('\n') + '\n'
  }
}

/** Metric names (kept as constants so /metrics and OTel stay in sync). */
export const M = {
  gcRuns: 'metal_gc_runs_total',
  gcEvicted: 'metal_gc_evicted_total',
  gcBytesReclaimed: 'metal_gc_bytes_reclaimed_total',
  gcOrphansRemoved: 'metal_gc_orphans_removed_total',
  gcDurableRemoved: 'metal_gc_durable_removed_total',
  resumeLocalHits: 'metal_resume_local_hits_total',
  resumeStoreHits: 'metal_resume_store_hits_total',
  resumeColdMiss: 'metal_resume_cold_miss_total',
  diskUsedPct: 'metal_disk_used_pct',
  diskFreeBytes: 'metal_disk_free_bytes',
  cacheLocalCount: 'metal_cache_local_count',
  cacheLocalBytes: 'metal_cache_local_bytes',
  // Per-class liveness of the assigned (running) set. These decompose the raw
  // "assigned" count into WHY each VM is live, so a running total of e.g. 96
  // can be read as "N serving app traffic + M mid agent-turn + K idle tail"
  // instead of one opaque gauge.
  assignedCount: 'metal_assigned_count',
  assignedAppActive: 'metal_assigned_app_active',
  assignedAgentActive: 'metal_assigned_agent_active',
  assignedIdleTail: 'metal_assigned_idle_tail',
} as const

export const metrics = new Metrics()
