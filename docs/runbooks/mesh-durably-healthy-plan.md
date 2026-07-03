# Plan: getting the multi-region mesh to "durably healthy"

**Author:** platform / on-call
**Last updated:** 2026-07-03
**Scope:** the active-active US/EU/India CNPG (PG 18) logical-replication mesh.

> **Framing.** "Never breaks again" is not achievable. The achievable — and
> correct — bar is **durably healthy**: the failure class that has repeatedly
> broken us is *prevented by construction*, anything that still slips through is
> *detected within one polling interval*, and most incidents *self-heal* without
> a human. This plan inventories what we've done, what's missing, and the ordered
> work to close the gap, across five layers: **Prevent · Detect · Self-heal ·
> Data hygiene · Operational readiness.**

---

## 0. How we got here (context)

Root failure class, seen repeatedly (2026-05-21, 2026-05-26, 2026-06-24…07-02):
two regions write the same logical row → collision on a **non-PK unique index** →
`INSERT_EXISTS_ACTION=last_update_wins` only resolves PK collisions → apply worker
poison-pills and the subscription auto-disables → WAL backlog grows on the
publisher until someone intervenes.

What we did in the latest incident:
- Recovered all **6 subscriptions** to healthy (lag 0) via a non-destructive
  skip loop; drained 19–30 GB WAL backlogs per slot.
- Fixed the immediate symptom (super-admin role not replicated to India).
- Regenerated the **identity-merge** pipeline for the current 104-split-email set
  with oldest-wins; dry-run clean, then **applied to all 3 regions (2026-07-03)** —
  0 duplicate emails, 7780 users / 7623 accounts converged in every region. See
  §5a for the merge + the replication lesson it taught.
- Confirmed `storage_usage` + `usage_wallets` are **region-local** (excluded from
  the publication) and wrote the plan to make them single-writer and rejoin the
  mesh (`usage-wallet-single-writer-plan.md`).

---

## 1. Current posture (what exists today)

| Layer | Mechanism | State |
|---|---|---|
| Prevent | `home-region-router.ts`, `HOME_REGION_ROUTING=enforce` in US/EU/India | ✅ live |
| Prevent | `chat-region-pin.ts` (chat affinity to home region) | ✅ on by default |
| Prevent | `check-multiregion-cron-locks.ts` CI guard (cron single-writer) | ✅ |
| Prevent | `check:publication` CI guard (no hand-listed publication) | ✅ (drift now guarded + deploy-stable, see §6) |
| Prevent | Idempotent signup (reduces dup `User`/`Account`) | ✅ partial |
| Prevent | Identity (`User`/`Account`) single-writer home-region pinning | ❌ "decision required" (runbook §A4) |
| Prevent | `usage_wallets` / `storage_usage` single-writer | ❌ region-local workaround only |
| Detect | `replication-monitor` CronJob /5min, exits non-zero | ⚠️ deployed all 3 regions, but a **stale/weaker** build (see §3a) |
| Detect | Monitor → pager | ✅ alert authored (`replication-monitor-failing.yaml`); ⬜ **pending import into SigNoz** — was entirely **missing** before |
| Self-heal | conflict watchdog (auto-skip + re-enable) | ✅ **productionized** as per-region CronJob (`conflict-watchdog.yaml`), deployed all 3 regions, skip-budget + `WATCHDOG_SKIP` log + fail-loud; alert `conflict-watchdog-failing.yaml` (⬜ import) |
| Self-heal | `subdisableonerr=true` (stops bad apply, waits for human) | ✅ (safe default, not healing) |
| Transport | `92_transport_hardening.sh` (keepalives, wal_*_timeout) | ✅ applied (idempotent) |
| Data | Identity dedupe pipeline (recon) | ✅ **applied all 3 regions 2026-07-03**, 0 residuals, 0 dup emails (§5a) |
| Data | Verified `pg_dump` backups per region | ✅ (incident + fresh pre-merge snapshots) — ⚠️ note: cluster has **no CNPG backup/PITR** stanza (§6) |
| Ops | `RUNBOOK.md`, `RUNBOOK_switchover_gameday.md` | ✅ exist |
| Ops | Game-day / failover drill cadence | ❌ ad hoc |

---

## 2. Prevent — make the broken class structurally impossible

**Goal:** every mutating write of a replicated row has exactly one writer region.

- [ ] **P1 — Close identity single-writer (runbook §A4).** Pick strategy (ii):
      route `User`/`Account`/identity writes to `users.homeRegion` (mirror the
      workspace pattern already in `resolveOwner`). This is the class that just
      produced 104 split emails; idempotent signup only narrows the race.
      - Add identity paths to the router's owner resolution (already stubbed:
        `resolveUserHomeRegionUserId`); move them out of any fail-open gap.
      - Backfill `users.homeRegion` for legacy null rows (`scripts/backfill-user-home-region.ts`).
- [ ] **P1 — `usage_wallets` + `storage_usage` single-writer** per
      `usage-wallet-single-writer-plan.md` (Design B), then rejoin the mesh.
- [ ] **P2 — Router coverage audit.** Enumerate every mutating route/cron/webhook
      and assert each resolves to an owner or is deliberately local. Turn the
      audit into a test so new routes fail CI if unclassified (extend the
      existing cron-locks guard to HTTP handlers).
- [ ] **P2 — Reconsider fail-open default.** The router fails *open* (writes
      local) on misconfig for non-money paths → silent divergence. Move more
      high-value tenant writes into `FAIL_CLOSED_PREFIXES`, or add a "shadow-diff"
      alert when a fail-open local write happens for an owned row.

**Exit:** collision-scan (`recon/11_collisions.sql`) trends to ~0 new splits over
a rolling window across *all* unique keys, not just the ones we hand-fixed.

---

## 3. Detect — page within one polling interval

**Goal:** no incident runs longer than ~5 min unnoticed (the 2026-05-26 lesson:
15 h undetected).

- [x] **P0 — The monitor's pager was MISSING, now authored.** Investigation
      (2026-07-02) found **no `kube_job_status_failed` alert exists anywhere** —
      deploy.yml and warm-pool-monitor comments reference "the existing
      kube_job_status_failed alert" that was never created. That is why the
      replication-monitor Jobs sat `Failed` for 8 days / 35h / 23h across the
      three regions during the incident without paging. Authored
      `terraform/modules/signoz/alerts/replication-monitor-failing.yaml` (pages
      when a region's monitor has no successful run in 15 min; auto-clears on a
      green run). **⬜ Remaining: import it into SigNoz** (manual, per the other
      files in that dir). **⬜ Also: the warm-pool-monitor has the identical
      missing-alert gap** — out of scope here, flag to the pool owner.
- [x] **P0 — Reconciled the publication-completeness check with the intentional
      exclusions.** Added a single `EXCLUDED_TABLES` list to the monitor
      (`storage_usage`, `usage_wallets`), an **inverse guard** that pages if
      either table is ever re-added to the publication, and documented the
      exclusion + CR-vs-live drift in `scripts/check-publication-drift.ts`
      (`INTENTIONALLY_UNPUBLISHED`).
- [ ] **P1 — Add slot-growth *rate* + publisher disk headroom alerts.** Current
      thresholds are absolute (100 MB lag). Add "slot growing N min monotonically"
      and "publisher WAL volume % of disk" so we page before disk pressure, not
      only on backlog size.
- [ ] **P1 — Alert on `subskiplsn` set / recent SKIP.** A skip is a data-loss
      event (we drop a remote txn). Surface every skip (who/what/when) so skips
      are reviewed, not silent.
- [ ] **P2 — Divergence canary.** Periodic lightweight cross-region row-count /
      checksum diff on a few key tables (users, workspaces, members) to catch
      silent drift that doesn't disable a sub.

### 3a. The deployed monitor is stale (found 2026-07-02)

The live `replication-monitor` in all three regions is an **older, weaker build**
than the repo YAML: its log ends with `=== Monitor complete ===` (no exit code)
and it is missing the Publication-Completeness, Refresh-Staleness, and
`_prisma_migrations`-trigger checks; it also exited 0 despite `apply_error_count`
of 324 (EU) / 70 (India). The repo version could not simply be rolled out because
it would page forever on (1) the **cumulative** `apply_error_count > 0` gate and
(2) the two intentionally-excluded tables. Both are now fixed in the repo:

- `apply_error_count` is now **report-only**; the actionable gate is a
  **currently-disabled** subscription (`subenabled = false`) + the existing
  STOPPED (`pid IS NULL`) check — neither is a cumulative counter.
- publication check honors `EXCLUDED_TABLES` + an inverse re-add guard.

- [x] **P0 — Deployed the corrected monitor to all 3 regions** (2026-07-02).
      Verified manual runs in US/EU/India: all print
      `=== Monitor complete (exit=0) ===`, the Publication-Completeness +
      Refresh-Staleness sections now render clean, and `apply_error_count`
      (324/70/…) is report-only (exit 0, no false page). Mesh 6/6 healthy.

---

## 4. Self-heal — degrade blips instead of outages

**Goal:** a *single* escaped conflict auto-resolves; humans handle only novel
classes.

- [x] **P0 — Productionized the conflict watchdog** (2026-07-03).
      `k8s/cnpg/logical-replication/conflict-watchdog.yaml`: per-region CronJob
      (/5min, own SA/Role/RoleBinding) that heals only its LOCAL disabled subs —
      finds the latest `insert_exists`/`update_exists`/`multiple_unique_conflicts`
      LSN for the sub's origin in the local PG log, SKIPs + re-enables, else
      re-enables-without-skip and pages. `SKIP_BUDGET=25`/run; over-budget or an
      unknown (non-safe) disable **exits non-zero** (fail-loud). Every skip prints
      `WATCHDOG_SKIP sub=… relation=… lsn=…`. Deployed + verified no-op in all 3
      regions, and **battle-tested during the identity merge** — it correctly
      skipped 4 redundant-backfill conflicts and re-enabled every sub (exit 0).
      Companion alert `terraform/modules/signoz/alerts/conflict-watchdog-failing.yaml`
      (⬜ import into SigNoz). Keep `subdisableonerr=true`; the watchdog is the
      automated re-enabler.
      - ⬜ Add the log-based **skip-review** alert on the `WATCHDOG_SKIP` marker
        (feeds §3 skip alert) — a skip is a data-loss event and must be reviewed.
- [ ] **P1 — Auto-refresh subscriptions after migrations.** The monitor detects
      stale subs; make the deploy workflow's `REFRESH PUBLICATION` idempotent and
      verified (it already runs; add a post-deploy assertion).
- [ ] **P2 — Auto-recreate lost slots** with a guarded runbook automation (a
      `lost` slot currently needs manual reseed).

**Guardrail:** self-heal must never mask a *new* failure class. The skip-budget +
skip-alert are what keep "auto-skip" from becoming "auto-lose-data."

---

## 5. Data hygiene — converge what already diverged

- [x] **P1 — Applied the identity merge** (2026-07-03). Oldest-wins, all 3
      regions, 0 residuals, 0 duplicate emails, converged 7780 users / 7623
      accounts per region. See §5a for procedure + the replication lesson.
- [ ] **P1 — Converge `usage_wallets`/`storage_usage`** before they rejoin the
      mesh (dedupe to the home-region row; fold any unreplicated tail from
      `usage_events`).
- [ ] **P2 — Standing dedupe report.** Schedule the read-only `recon` collision
      scan (weekly) so new divergence is caught as data, not as an outage.
- [x] **P0 — Dropped the FDW hub** (2026-07-03). Removed `eu_remote`/`in_remote`
      + servers/user-mappings on US and `us_remote`/`us_recon` + `us_srv` on
      EU/India, plus the `recon` merge-artifact schemas. Verified 0 foreign
      servers/schemas everywhere; mesh still healthy.

### 5a. Identity merge — what we did + the replication lesson (2026-07-03)

Procedure that worked: (1) fresh per-region `pg_dump` safety snapshot of the 21
merge-affected tables (`recon/dumps/`, git-ignored — contains tokens/PII);
(2) build oldest-wins maps on US from the FDW union (`commit_10_maps_oldest.sql`);
(3) dry-run the exact commit SQL under `ROLLBACK` (residuals 0); (4) commit on US
(delete local dups → backfill canon from peers → repoint children → assert
residuals 0 → COMMIT), then EU + India (local dedupe + repoint, no backfill,
maps copied from US).

**Lesson — never apply a cross-region data merge as one big transaction.** The US
commit was a single txn. When it replicated to EU/India it hit a
`multiple_unique_conflicts` on ONE already-present row (a backfilled canon row
whose id+email both matched the peer's identical row — *not* auto-resolved by
last-update-wins, unlike single-index `insert_exists`). `subdisableonerr` disabled
the sub, and skipping that LSN skipped the **entire** US transaction on the peer —
so EU/India silently lost all 51 canon backfills (counts diverged by exactly each
region's deleted-dup count). Recovery: backfill each region **locally** from
`us_remote` (`commit_40_backfill_from_us.sql`) so counts converge independent of
replication, then let the watchdog skip the now-redundant identical-row conflicts.

Next time: batch merge writes into **small per-entity transactions** (or apply the
identical deterministic merge in each region from copied maps and let only
row-level redundant conflicts arise), so one conflicting row can't drop a whole
batch. Note the foreign table `us_remote.users` was stale (missing `homeRegion`) —
`ALTER FOREIGN TABLE … ADD COLUMN` before backfilling identity.

---

## 6. Operational readiness

- [x] **P0 — Fixed publication CR drift (made it deploy-stable + fail-loud).** The
      CNPG CR declares `FOR TABLES IN SCHEMA public` (`applied=true`,
      `observedGeneration:1`); the live publication is a hand-list
      (`puballtables=f`) excluding the 2 region-local tables. A Postgres
      publication **cannot** both auto-include future tables and exclude specific
      ones, so the drift is irreducible until single-writer lands (then all
      tables rejoin and CR=live). Instead of forcing them equal (either direction
      is worse), we made the deviation **explicit, guarded, and deploy-stable**:
      `exclude-region-local-tables.sql` runs in every deploy (all 3 regions) after
      the CR apply / before REFRESH — idempotently re-drops the 2 tables and
      **RAISES (fails the deploy)** if it ever finds the pub reconciled to a
      schema-level publication; the monitor READDED guard pages if they reappear;
      CI `INTENTIONALLY_UNPUBLISHED` + the CR YAML `LIVE DIVERGENCE` header
      document it. True resolution stays tied to the single-writer rejoin (§2).
- [ ] **P1 — Add CNPG backup / PITR.** Found 2026-07-03: `platform-pg` has **no
      `backup` stanza, no scheduled backups, no recoverability point** in any
      region — an irreversible bad migration has no cluster-level restore path
      (we relied on manual `pg_dump` + peer regions for the identity merge).
      Configure CNPG Barman/object-store backups + WAL archiving + a restore
      drill.
- [ ] **P1 — Migration/DDL discipline.** No hand-applied DDL (caused P3009);
      operator upgrades gated by the staging game-day first (an operator upgrade
      triggered the 2026-06-24 incident). Document the ordering in `RUNBOOK.md`.
- [ ] **P1 — Failover playbook.** Define `homeRegion` reassignment + the
      fail-closed vs availability tradeoff during a real region outage; rehearse.
- [ ] **P2 — Quarterly game-day** using `RUNBOOK_switchover_gameday.md`: kill a
      sub, kill a region, force a conflict — verify detect + self-heal fire.
- [ ] **P2 — Backup/restore drill** (verified `pg_dump` per region already exists;
      prove restore).

---

## 7. Ordered roadmap

**P0 — this week (make current safety real):**
1. ✅ Authored the missing pager alert (`replication-monitor-failing.yaml`) —
   ⬜ import it into SigNoz (§3).
2. ✅ Fixed the CR-vs-live drift: deploy-stable + fail-loud re-assertion (§6).
3. ✅ Deployed the corrected (de-staled) monitor to all 3 regions (§3a).
4. ✅ Productionized conflict watchdog (skip-budget, fail-loud, deployed) —
   ⬜ import `conflict-watchdog-failing.yaml` + add the `WATCHDOG_SKIP` log alert (§3,§4).
5. ✅ Applied identity merge COMMIT (all 3 regions) + dropped FDW hub (§5,§5a).

**Remaining manual P0 follow-ups:** import the two SigNoz alerts
(`replication-monitor-failing`, `conflict-watchdog-failing`) + author the
`WATCHDOG_SKIP` log alert; configure CNPG backups/PITR (§6).

**P1 — this quarter (close the prevention gaps):**
6. Identity single-writer home-region routing (§2) — the merge converged the
   *existing* splits; this stops *new* ones.
7. `usage_wallets`/`storage_usage` single-writer + rejoin mesh (§2, §5) — also
   retires the CR-vs-live drift for good.
8. CNPG backup / PITR + restore drill (§6).
9. Slot-rate/disk + skip alerts; auto-refresh assertion (§3, §4).
10. Migration discipline + failover playbook (§6).

**P2 — hardening:**
9. Full router coverage audit as CI; fail-open review (§2).
10. Divergence canary + standing dedupe report (§3, §5).
11. Quarterly game-day + restore drill (§6).

---

## 8. Definition of "durably healthy" (exit criteria)

- Every replicated table has exactly one writer region (routing audit green,
  identity + usage tables included); collision scan shows ~0 new splits.
- Any disabled sub / stuck slot / drift pages an owner within 5 min **and** the
  watchdog auto-recovers the known-safe classes within minutes, with every skip
  alerted and reviewed.
- No table is hand-excluded from the publication out-of-band; CR, CI, monitor,
  and live DB agree.
- A quarterly game-day (kill sub, kill region, force conflict) is survived with
  no manual DB surgery.
- Zero standing split-brain rows; a weekly report proves it.

Related docs: `region-write-ownership.md`, `usage-wallet-single-writer-plan.md`,
`k8s/cnpg/logical-replication/RUNBOOK.md`,
`prod-investigation/recovery/recon/` (recon pipeline + watchdog + transport).
