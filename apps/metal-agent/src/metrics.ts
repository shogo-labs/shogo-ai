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
  // Docker runtime images removed by image-gc.ts, and the root-disk space they
  // gave back. The images live on the ROOT disk, which the NVMe watermarks
  // above never see — dal-2 filled it to 100% with 83 stale images (2026-10-31).
  imageGcRemoved: 'metal_image_gc_removed_total',
  imageGcFailed: 'metal_image_gc_failed_total',
  imageGcFreedBytes: 'metal_image_gc_freed_bytes_total',
  // Root filesystem, sampled with the heartbeat — NOT the NVMe cache. This is
  // the disk a host dies on when nobody is deleting images.
  rootDiskUsedPct: 'metal_root_disk_used_pct',
  rootDiskFreeBytes: 'metal_root_disk_free_bytes',
  rootDiskDockerBytes: 'metal_root_disk_docker_bytes',
  // Rootfs switch-over: pre-warmed snapshots made current at activation, and
  // idle VMs on a superseded rootfs backed up and stopped instead of snapshotted.
  stagedSnapshotsPromoted: 'metal_staged_snapshots_promoted_total',
  suspendRetiredStale: 'metal_suspend_retired_stale_total',
  // VMs moved off a superseded rootfs by the rollout rotation (pool.rotateStale).
  rolloutRotated: 'metal_rollout_rotated_total',
  // A staged rootfs was refused because a real VM could not boot from it
  // (SHO-552). Non-zero means a release is broken and this host stayed on the
  // image it had — the log line names the error.
  rootfsBootProbeFailed: 'metal_rootfs_boot_probe_failed_total',
  // Activations undone automatically after a burst of failed cold boots, and by
  // an operator (`POST /admin/rollback-rootfs`).
  rootfsRollback: 'metal_rootfs_rollback_total',
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
  // The host's member list for a workspace VM disagreed with what the guest
  // has mounted. Backups follow the guest; before that, a member missing from
  // the host's list was never backed up at all.
  workspaceMemberDrift: 'metal_workspace_member_drift_total',
  // Single-runtime rule: a project is online only in its own runtime
  // (pool.ownMemberIds). Each of these should read zero once the API and every
  // VM from before the rule are gone.
  //   `foreignMembersStripped`    — member ids dropped from an assign/resume env
  //                                 (an API replica still sending the old lists).
  //   `foreignMemberMountRefused` — a live mount of a foreign member (409).
  //   `foreignMemberBackupSkipped`— a backup found a foreign member in a legacy
  //                                 VM and left it to the drain.
  //   `foreignMemberDrained`      — `{outcome="exported"|"conflict"|"empty"|"failed"}`
  //                                 per member pool.drainForeignMembers took off.
  foreignMembersStripped: 'metal_foreign_members_stripped_total',
  foreignMemberMountRefused: 'metal_foreign_member_mount_refused_total',
  foreignMemberBackupSkipped: 'metal_foreign_member_backup_skipped_total',
  foreignMemberDrained: 'metal_foreign_member_drained_total',
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
  // Successful writable-state uploads, by why they ran.
  dataUploadPeriodic: 'metal_data_upload_periodic_total',
  dataUploadFinal: 'metal_data_upload_final_total',
  dataUploadRecycle: 'metal_data_upload_recycle_total',
  // Periodic uploads skipped by the large-database cadence limit.
  dataUploadThrottled: 'metal_data_upload_throttled_total',
  // The guest could not snapshot its database at all (named code
  // `sqlite_snapshot_failed`), so this project has NO writable-state backup.
  // Counted once per failure streak, not per retry (SHO-541).
  dataSnapshotFailed: 'metal_data_snapshot_failed_total',
  // A VM on a superseded rootfs that rotation cannot take. Non-zero means a
  // runtime is stuck on old code with no way out but a human (SHO-541).
  rotationBlocked: 'metal_rotation_blocked_total',
  // Durability gauges for writable state: how many assigned VMs cannot back
  // their database up, how long the oldest has been unable to, and how many
  // are pinned to a superseded rootfs. The alert reads these — one broken
  // database used to be invisible for four days (SHO-541).
  dataSnapshotFailedVms: 'metal_data_snapshot_failed_vms',
  dataSnapshotFailedOldestSec: 'metal_data_snapshot_failed_oldest_seconds',
  rotationBlockedVms: 'metal_rotation_blocked_vms',
  // End-of-day restore points (`project-data/daily/<date>.tar.gz`).
  dataDailyCopied: 'metal_data_daily_copy_ok_total',
  dataDailyCopyFailed: 'metal_data_daily_copy_failed_total',
  // Encrypted home-directory durability (pool.saveHomeStateToStore). Same
  // meanings as the writable-state counters above, for `home-state.enc`.
  homeHydrated: 'metal_home_hydrated_total',
  homeHydrateFailed: 'metal_home_hydrate_failed_total',
  homeUploadPeriodic: 'metal_home_upload_periodic_total',
  homeUploadFinal: 'metal_home_upload_final_total',
  homeUnchanged: 'metal_home_unchanged_total',
  homeConflict: 'metal_home_conflict_total',
  homeRefused: 'metal_home_refused_untrusted_total',
  homeTooLarge: 'metal_home_too_large_total',
  homeUnsupported: 'metal_home_unsupported_total',
  // API health watchdog. `apiUnhealthy` is how many live runtimes currently
  // report an unhealthy project API sidecar. The auto-recycle counters split
  // by outcome: `observed` = would have recycled (observe mode), `aborted` = a
  // backup failed so nothing was removed, `rateLimited` = skipped by the
  // per-runtime hourly/daily cap.
  apiUnhealthy: 'metal_api_unhealthy',
  autoRecycleOk: 'metal_auto_recycle_ok_total',
  autoRecycleObserved: 'metal_auto_recycle_observed_total',
  autoRecycleAborted: 'metal_auto_recycle_aborted_total',
  autoRecycleRateLimited: 'metal_auto_recycle_rate_limited_total',
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
  // Saving a VM's workspace before it is discarded (see pool.rescueWorkspace).
  // `failed` means the workspace is only in a quarantined disk — page on it.
  rescueGuest: 'metal_rescue_guest_export_total',
  rescueDisk: 'metal_rescue_disk_extract_total',
  rescueFailed: 'metal_rescue_failed_quarantined_total',
  staleSnapshotSkipped: 'metal_stale_snapshot_skipped_total',
  // Same events labelled `{reason="repo"|"member_data"|...}` (see StaleReason).
  staleSnapshotSkippedByReason: 'metal_stale_snapshot_skipped_by_reason_total',
  // Resumes that kept a snapshot whose writable-state archives had moved on,
  // re-applying just those archives instead of cold-booting.
  snapshotDriftRepaired: 'metal_snapshot_drift_repaired_total',
  // Idle suspends labelled `{tier="relaxed"|"aggressive"|"static"}`, and VMs
  // past the window left for a later pass by METAL_REAP_MAX_PER_PASS.
  idleSuspendedByTier: 'metal_idle_suspended_by_tier_total',
  idleReapDeferred: 'metal_idle_reap_deferred_total',
  idleWindowMs: 'metal_idle_window_ms',
  // Why each assigned VM is still resident, as a gauge per reason
  // `{reason="window"|"busy"|"refused"|"alwaysOn"|"legacy"|"evictable"}`. They
  // are disjoint and sum to `metal_assigned_count`, so one scrape answers "why
  // are 140 VMs loaded while 20 projects are active". `evictable` means nothing
  // is holding it — the next pass suspends it, so a sustained non-zero
  // `evictable` means the reaper is not keeping up (SHO-533).
  idleHoldReason: 'metal_idle_hold_reason',
  // Idle-VM reclaim (SHO-534): MiB the balloon has taken out of idle guests
  // (a total, so the fleet's saved RAM is one sum), how many assigned VMs are
  // currently holding reclaimed RAM (state), how many deflates happened and how
  // long one took. The deflate latency matters because it sits behind the first
  // request after an idle period: it is off the request's critical path, but a
  // slow PATCH is why the first click after an idle spell feels sluggish.
  balloonReclaimedMiB: 'metal_balloon_reclaimed_mib_total',
  balloonDeflated: 'metal_balloon_deflated_total',
  idleReclaimedVms: 'metal_idle_reclaimed_vms',
  idleReclaimDeflateMs: 'metal_idle_reclaim_deflate_ms',
  // Host RAM and KSM (SHO-534). `hostMemUsedMiB` is MemTotal - MemAvailable, not
  // the sum of FC RSS: a restored VM's guest memory is a MAP_PRIVATE file
  // mapping, so per-process RSS under-counts the page cache the host really
  // holds. The KSM gauges are what the ksmd CPU budget and the dedup gain are
  // read from while KSM is being evaluated on staging; they stay zero on a host
  // with KSM off, which is every prod host until Russell signs off on it.
  hostMemUsedMiB: 'metal_host_mem_used_mib',
  hostMemAvailableMiB: 'metal_host_mem_available_mib',
  ksmPagesSharing: 'metal_ksm_pages_sharing',
  ksmPagesShared: 'metal_ksm_pages_shared',
  ksmFullScans: 'metal_ksm_full_scans',
  ksmdCpuPct: 'metal_ksmd_cpu_pct',
  /** Window (ms) the ksmd CPU percentage was measured over — a fixed 30s. */
  ksmdCpuWindowMs: 'metal_ksmd_cpu_window_ms',
  // Idle-suspend refusals: each one means the guest's HEAD is not in the durable
  // repo yet, so the VM may not be suspended (SHO-442). Counted per attempt
  // (`refused`) and summed per reaper pass for VMs waiting out their backoff
  // (`refused_backoff`), because a refusal costs a full repo export and retrying
  // one every scan starves the reaper (SHO-533).
  idleSuspendRefused: 'metal_idle_suspend_refused_total',
  idleSuspendRefusedVms: 'metal_idle_suspend_refused_vms',
  idleReapRefusedBackoff: 'metal_idle_reap_refused_backoff_total',
  // VMs the reaper would have suspended if their guest did not report busy:
  // assigned, not always-on, `busy` true, and no user activity for the current
  // idle window. A non-zero gauge is the "reports busy, does nothing" tail that
  // held ~12% of US capacity on 2026-11-18.
  busyIdleVms: 'metal_busy_idle_vms',
  // Suspends/retires driven by METAL_BUSY_IDLE_CEILING_MS — a guest that kept
  // reporting busy past the ceiling with no user activity. Counted on top of
  // `idleSuspendedByTier`.
  busyIdleCeilingSuspended: 'metal_busy_idle_ceiling_suspended_total',
  // On-demand evictions of the "ready to suspend" bucket (SHO-444), labelled
  // `{reason="mem"|"slots"|"headroom"|"retired"}`: a warm VM suspended early
  // because an assign/resume on this host needed the room. `retired` means the
  // VM was on a superseded rootfs and was re-warmed instead of snapshotted.
  evictions: 'metal_evictions_total',
  // An assign found the host full and nothing evictable: the host is full of
  // WORK, not of warm VMs. The signal that the bucket cannot help here.
  evictNoneAvailable: 'metal_evict_none_available_total',
  // The assigned set split by residency: `active` holds a slot someone needs,
  // `evictable` is warm but free capacity. Disjoint, sum to assigned.
  assignedActive: 'metal_assigned_active',
  assignedEvictable: 'metal_assigned_evictable',
  // Source backups taken mid-residency (pool.exportAllSource), separate from
  // the one every suspend takes.
  sourceBackupPeriodic: 'metal_source_backup_periodic_total',
  sourceBackupPeriodicFailed: 'metal_source_backup_periodic_failed_total',
  // Host-mediated `.git` durability (see pool.saveRepoToStore).
  repoConflict: 'metal_repo_conflict_total',
  repoPromoted: 'metal_repo_unlinked_promoted_total',
  repoRefused: 'metal_repo_refused_untrusted_total',
  repoTooLarge: 'metal_repo_too_large_total',
  repoBundleBytes: 'metal_repo_bundle_bytes_total',
  repoBundleFull: 'metal_repo_bundle_full_total',
  repoManifestConflict: 'metal_repo_manifest_conflict_total',
  repoBundleCompactions: 'metal_repo_bundle_compactions_total',
  repoBundlesGced: 'metal_repo_bundle_gc_deleted_total',
  // Unmigrated projects kept on the tarball because the guest's LFS push failed.
  repoBundleLfsFallback: 'metal_repo_bundle_lfs_fallback_total',
  // The guest's LFS push is still running (202). The export retries and joins
  // the same job; a slow push must never look like a failed save (SHO-442).
  repoBundleLfsPending: 'metal_repo_bundle_lfs_pending_total',
  // An UNTRUSTED VM's `.git` was copied to `conflict/` — the floor that keeps
  // its work durable while it cannot write the real repo (SHO-442).
  repoQuarantine: 'metal_repo_quarantine_total',
  // An UNTRUSTED VM was re-attached to the durable history and can save again.
  repoHealed: 'metal_repo_healed_total',
  // A suspend/retire/recycle was refused because the current HEAD is not in the
  // durable repo. The VM keeps running and the next sweep retries.
  repoDurabilityRefused: 'metal_repo_durability_refused_total',
  // Pointers whose bytes are on neither side, reported by the guest's export.
  repoLfsMissing: 'metal_repo_lfs_missing_total',
  repoExportUnchanged: 'metal_repo_export_unchanged_total',
  // Durability gauges (SHO-442). The incident ran a day and a half with no
  // signal at all: VMs that could not save, and work that had never been
  // written anywhere. `repoUntrustedVms` counts assigned VMs whose `.git` is
  // not trusted to write the durable repo, `repoUntrustedOldestSec` is how long
  // the oldest has been in that state, and `repoUnsavedSeconds` is the worst
  // age of a HEAD that exists only inside a guest.
  repoUntrustedVms: 'metal_repo_untrusted_vms',
  repoUntrustedOldestSec: 'metal_repo_untrusted_oldest_seconds',
  repoUnsavedSeconds: 'metal_repo_unsaved_seconds',
  // Assign-time git history restore, `{outcome=}`: `foreground` (done before
  // the open returned), `deferred` (open returned on the source's .git, the
  // download finishing behind it), `none` (no durable repo), `failed`.
  repoHydrate: 'metal_repo_hydrate_total',
  // How each deferred restore ended, `{outcome=}`: `adopted`, `busy` (the
  // workspace was in use by then, so it was left on the source's .git),
  // `failed`, `abandoned` (the VM went away first).
  repoHydrateDeferred: 'metal_repo_hydrate_deferred_total',
  // Quarantine writes (`conflict/`), all four writers through quarantine.ts.
  // `deduped` = identical bytes already durable, so no PUT was made; `capped` =
  // the project is over its daily cap and the copy was NOT written (callers
  // must treat that as not saved); `bytes` is what actually reached the bucket.
  // One identical 525 MB copy every ten minutes for six days is what these
  // three counters make visible (SHO-584).
  quarantineDeduped: 'metal_quarantine_deduped_total',
  quarantineCapped: 'metal_quarantine_capped_total',
  quarantineBytes: 'metal_quarantine_bytes_total',
  // A VM adopted after a restart whose open never finished (its assign was cut
  // off by the drain): the tree is a partial hydrate, so it is marked untrusted
  // and retired without a snapshot (SHO-584).
  midOpenAdopted: 'metal_mid_open_adopted_total',
  // A `.git` the guest reports as corrupt (`bad object` / `missing blob` on the
  // export's rev-list). Permanent for that VM, so rotation is blocked rather
  // than retried every ten minutes (SHO-584).
  repoCorrupt: 'metal_repo_corrupt_total',
  // Bytes and bundles the guest was asked to download, and the wall time of
  // each restore (foreground or deferred) — divide by repoHydrate for averages.
  repoHydrateBytes: 'metal_repo_hydrate_bytes_total',
  repoHydrateBundles: 'metal_repo_hydrate_bundles_total',
  repoHydrateMs: 'metal_repo_hydrate_ms_total',
  // Guest-side failures scraped from the per-VM serial console by serial-watcher.
  // These are the ONLY fleet-wide signal for in-guest breakage that survives a
  // guest too broken to ship its own telemetry (e.g. TLS failing on clock skew).
  guestErrorTotal: 'metal_guest_error_total',
  guestTlsClockSkew: 'metal_guest_tls_clock_skew_total',
  // Guest wall-clock skew measured against the host on the first health check
  // after a snapshot restore (see pool.probeGuestClockSkew). `guestClockSkewMs`
  // is the worst absolute skew seen since the agent started — a restore should
  // read a few ms, and anything in the thousands is a guest whose clock froze at
  // snapshot time (the 2026-10-25 staging incident: 4h40m). The counter is the
  // number of restores that came back more than GUEST_CLOCK_SKEW_ALERT_MS off,
  // which the rehydrate clock sync then corrects.
  guestClockSkewMs: 'metal_guest_clock_skew_ms',
  guestClockSkewAfterRestore: 'metal_guest_clock_skew_after_restore_total',
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
  // Workspace-drive grows (SHO-349), labelled by result: `ok`, `error`. A
  // failing grow is why a project would still hit ENOSPC after raising its
  // setting, so this is the first thing to look at when it does.
  workspaceDriveGrow: 'metal_workspace_drive_grow_total',
  /** Duration (ms) of the most recent successful grow — freeze→resize2fs. */
  workspaceDriveGrowMs: 'metal_workspace_drive_grow_last_ms',
} as const

export const metrics = new Metrics()
