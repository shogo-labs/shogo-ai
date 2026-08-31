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
  // Leaked `fctap<n>` devices reclaimed by the GC, and how much of the host's
  // /30 space is occupied. `tapUsedPct` is the leading indicator for the outage
  // where a host exhausted its indices: it climbs monotonically while taps leak
  // and nothing else misbehaves until every /30 is gone, at which point every
  // /assign on that host fails. A healthy host sits near its VM count with
  // `gcTapsReclaimed` flat.
  gcTapsReclaimed: 'metal_gc_taps_reclaimed_total',
  tapsInUse: 'metal_taps_in_use',
  tapCapacity: 'metal_tap_capacity',
  tapUsedPct: 'metal_tap_used_pct',
  gcStaleReclaimed: 'metal_gc_stale_reclaimed_total',
  resumeLocalHits: 'metal_resume_local_hits_total',
  resumeStoreHits: 'metal_resume_store_hits_total',
  resumeColdMiss: 'metal_resume_cold_miss_total',
  // Write-side anti-clobber guard (see pool.saveBackupToStore / suspend). A
  // non-zero rate here means workspaces are coming up with a lineage that
  // doesn't match their durable backup (template reverts, stale snapshots,
  // cross-host races) — the exact condition that used to silently destroy
  // real backups. `backupConflict` = a source export quarantined instead of
  // overwriting; `backupTemplateSnapshotBlocked` = a template-origin VM
  // prevented from clobbering an existing durable snapshot;
  // `backupSizeRegression` = the size backstop refused an otherwise-permitted
  // write (an `adopt`) that would have collapsed a real backup to a
  // template-shaped one — the mislabeled-lineage clobber vector.
  backupConflict: 'metal_backup_conflict_total',
  backupTemplateSnapshotBlocked: 'metal_backup_template_snapshot_blocked_total',
  backupSizeRegression: 'metal_backup_size_regression_total',
  // `backupTemplatePromotion` = real source replaced a template-shaped backup it
  // could not prove descent from. The counterpart to `backupSizeRegression`, and
  // the case that used to quarantine: a project built inside a template-origin
  // VM has no lineage to present, so its work never reached the durable backup.
  backupTemplatePromotion: 'metal_backup_template_promotion_total',
  // Writable-state durability (database + uploads; see
  // pool.saveProjectDataToStore).
  //   `dataConflict`  — a conditional write's precondition failed, so the
  //                     durable archive was NOT the one this workspace
  //                     descends from and was left untouched.
  //   `dataRefused`   — the workspace was marked untrusted (its writable-state
  //                     hydrate failed, so it is running on whatever database
  //                     the source archive held) and was never allowed to
  //                     write. Sustained non-zero means projects are running
  //                     WITHOUT durability and needs investigating.
  //   `dataCollapse`  — observational only: a permitted write shrank a
  //                     populated archive to a fraction of its size. Either a
  //                     user wiped their own database or something upstream is
  //                     wrong; it no longer blocks the write (see
  //                     project-data-archive.isDataCollapse).
  //   `dataTooLarge`  — writable state exceeded the durability limit and was
  //                     NOT persisted, so it is only as durable as its VM
  //                     snapshot. Any sustained rate needs a real storage
  //                     backend for that app.
  dataConflict: 'metal_data_conflict_total',
  dataRefused: 'metal_data_refused_untrusted_total',
  dataCollapse: 'metal_data_collapse_observed_total',
  dataTooLarge: 'metal_data_too_large_total',
  // Writable-state exports skipped because the guest reported nothing changed
  // (HTTP 304 from /pool/export-data). The counterweight to the export
  // interval: a high ratio here means the cadence is affordable.
  dataUnchanged: 'metal_data_unchanged_total',
  // VMs whose guest predates /pool/export-data. Counted once per VM, and
  // expected to be non-zero only while a rollout drains: a value that stays
  // flat and high means projects whose writable state is NOT being persisted.
  dataUnsupported: 'metal_data_unsupported_total',
  diskUsedPct: 'metal_disk_used_pct',
  diskFreeBytes: 'metal_disk_free_bytes',
  // Per-VM dm-snapshot CoW stores (dm rootfs mode). A store that fills is not
  // a slow VM but a dead one: the kernel invalidates the snapshot and every
  // subsequent write on that root device fails, silently, under a guest that
  // is still up and still answering health checks.
  //   `cowInvalid`    — devices already invalidated. Should be flat zero; any
  //                     value at all is that many broken VMs, and is worth
  //                     paging on rather than graphing.
  //   `cowMaxUsedPct` — utilisation of the fullest store on the host, the lead
  //                     indicator for the above.
  //   `cowNearLimit`  — how many stores are in the danger band, so a single
  //                     outlier reads differently from a fleet-wide trend.
  cowInvalid: 'metal_cow_invalid',
  cowMaxUsedPct: 'metal_cow_max_used_pct',
  cowNearLimit: 'metal_cow_near_limit',
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
  // Assigned VMs whose guest HTTP is mute (process alive, /health fails).
  // Should be zero; a non-zero gauge is the 2026-08 wedged-guest fingerprint.
  assignedUnhealthy: 'metal_assigned_unhealthy',
  healthGateDiscard: 'metal_health_gate_discard_total',
  // Host-mediated `.git` durability (see pool.saveRepoToStore).
  repoConflict: 'metal_repo_conflict_total',
  repoRefused: 'metal_repo_refused_untrusted_total',
  repoTooLarge: 'metal_repo_too_large_total',
  // Guest-side failures scraped from the per-VM serial console by serial-watcher.
  // These are the ONLY fleet-wide signal for in-guest breakage that survives a
  // guest too broken to ship its own telemetry (e.g. TLS failing on clock skew).
  guestErrorTotal: 'metal_guest_error_total',
  guestTlsClockSkew: 'metal_guest_tls_clock_skew_total',
  guestProviderError: 'metal_guest_provider_error_total',
  guestConnectionError: 'metal_guest_connection_error_total',
  guestInferenceRetry: 'metal_guest_inference_retry_total',
  guestOom: 'metal_guest_oom_total',
  guestKernelPanic: 'metal_guest_kernel_panic_total',
  // Control-plane requests that arrived without a valid bearer, labelled by
  // bucketed path and reason (see auth.ts). This is the gate on enforcement:
  // `METAL_AUTH_MODE=observe` serves these anyway and counts them, so a host is
  // only flipped to `enforce` once this has read zero long enough to cover the
  // slow callers — a project delete fanning out `/destroy`, an admin panel
  // listing `/vms`. Under `enforce` it keeps counting, and then it is the
  // signal that something is being turned away: either an attacker, or a
  // caller nobody remembered was there.
  controlUnauthenticated: 'metal_control_unauthenticated_total',
} as const

export const metrics = new Metrics()
