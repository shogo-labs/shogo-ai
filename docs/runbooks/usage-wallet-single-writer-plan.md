# Plan: single-writer `usage_wallets` + `storage_usage` via `workspace.homeRegion`

**Status:** design / implementation plan. No code changes yet.
**Decision (2026-07-02):** Design **B** — serve the completion locally, route only
the wallet mutation to the workspace's home region via an internal RPC. Then
re-add both tables to the replication mesh.

## Goal

`usage_wallets` and `storage_usage` are `🔴` additive counters (running USD /
byte totals). They are currently **excluded from `shogo_all_pub`** (region-local)
because logical replication's `last_update_wins` cannot merge concurrent counter
updates and their `workspaceId` unique index poison-pills the apply worker when
two regions insert. See `docs/runbooks/region-write-ownership.md` (A1, 🔴 tables).

The correct end-state: make every write of these rows **single-writer, pinned to
`workspace.homeRegion`**. Once there is exactly one writer per row, LWW never
fires and the tables can safely rejoin the mesh (read locally off the replica
everywhere else).

## Why a flag flip is not enough

`HOME_REGION_ROUTING=enforce` + `home-region-router.ts` already pins *REST*
mutations to `workspace.homeRegion` and fails **closed** for `/api/billing`,
`/api/usage-events`, `/api/usage-wallets`. But the dominant writers bypass it:

| writer | location | routed today? |
|---|---|---|
| `consumeUsage()` → `tx.usageWallet.update()` (per completion) | `billing.service.ts` `_consumeUsageTransaction` (~904), via `recordUsage()` in `ai-proxy.ts` (~1824) and `proxy-billing-session.closeSession()` | **No** — triggered under `/api/ai/`, `/api/v1/` which are in `SKIP_PREFIXES` |
| `storageUsage.upsert()` | `storage.service.ts:107` | **No** — side-effect of whatever action runs |
| monthly/daily reset, `grant-monthly-refill`, `billing-alerts` | `server.ts` setInterval crons + `billing.service.ts` `updateMany` | Partially — `withGlobalJobLock` makes one region run them, but that region then writes *every* workspace's wallet = not home-region single-writer |

So single-writer requires closing these three write paths, not just routing REST.

## Design B — sync home-region wallet RPC

Keep the latency-sensitive completion **local**. Move only the wallet/storage
*mutation* to the home region. Metering happens at **stream close**
(`closeSession`) / after the upstream completes (`recordUsage`), i.e. **off the
TTFT path**, so a cross-region hop here does not delay first token.

### 1. `usage_events` stays the source of truth
`usage_events` is append-only, PK-keyed, and already replicated. It remains the
durable ledger. The wallet is a **fast aggregate** derived from it. This is what
makes failure handling safe (below).

### 2. New internal endpoint (home region executes the charge)
Add `POST /api/internal/billing/consume` (and `.../storage-usage`) under the
existing `/api/internal/` surface (already in `SKIP_PREFIXES`; authenticated by
the internal service token, not a user session):

- Body: the current `ConsumeUsageParams` (`workspaceId`, `projectId`, `memberId`,
  `actionType`, `rawUsd`, `billedUsd`, `actionMetadata`, `billingWorkspaceId`).
- Handler runs the **existing** `_consumeUsageTransaction` locally. Because it is
  invoked in the home region, the wallet read (limit check) + update happen where
  the row is authoritative → **exact enforcement, no stale read**.
- Returns the existing `ConsumeUsageResult`.

### 3. `consumeUsage()` becomes home-aware
At the top of `consumeUsage()` (`billing.service.ts`):

```
homeRegion = (await prisma.workspace.findUnique(billingWorkspaceId)).homeRegion ?? PRIMARY_REGION
if (RAW_REGION_ID && homeRegion !== RAW_REGION_ID) {
   return await callPeerInternal(homeRegion, '/api/internal/billing/consume', params)  // fetch to getPeer(homeRegion).url
}
// else: run _consumeUsageTransaction locally (unchanged)
```

Same wrapper for `storage.service.ts` `recordStorageDelta` → `/api/internal/billing/storage-usage`.
Reuse `getPeer()` + the in-mesh TLS/`x-shogo-*` conventions from
`region-peer-proxy.ts` (but as a small JSON RPC, not a request proxy).

### 4. Enforcement semantics
- **Pre-flight (unchanged, local):** action-start budget checks read the local
  replica (slightly stale, acceptable for gating the *next* action).
- **Authoritative charge (home region):** the post-completion `consumeUsage`
  runs in the home region and returns the real remaining/limit result. Streaming
  overage is inherently after-the-fact already, so this matches today's behavior.

### 5. Crons: partition by home region (not global lock)
Because every wallet write must occur in its home region, the reset / refill /
alert crons must **each region process only its own workspaces**:

```
where: { workspace: { homeRegion: RAW_REGION_ID } }   // (null => primary region handles it)
```

This replaces `withGlobalJobLock` for these specific wallet-mutating crons and is
enforced by `scripts/check-multiregion-cron-locks.ts` (add a `regionKeyColumn`
justification or the partition filter). Every region runs the cron, but each only
touches wallets it owns → still single-writer.

### 6. Failure handling (home region unreachable at charge time)
Never fail the already-delivered completion. Order of operations:

1. Always write the local `usage_events` row first (durable, replicated).
2. Attempt the home-region `consumeUsage` RPC.
3. On RPC failure: enqueue a durable **outbox** row (or rely on a reconcile job)
   and return a soft result. A periodic **home-region reconcile job** folds any
   `usage_events` not yet reflected in the wallet (idempotent by event id). This
   bounds money-correctness to "wallet may briefly lag the ledger", never "usage
   lost". (This reconcile job is also the long-term backstop that keeps the
   aggregate honest.)

## Re-joining the mesh (after single-writer is proven)

1. **Shadow first.** Land the routing behind `HOME_REGION_ROUTING=shadow` (plus a
   dedicated `USAGE_WALLET_HOME_WRITER` kill switch). Log every wallet/storage
   write with `{ servingRegion, homeRegion, wouldProxy }`. Confirm **0 non-home
   writes** across a representative window (covers agent traffic, direct API,
   voice, failover drills).
2. **Converge existing divergence.** Before re-adding to the publication, dedupe
   the region-local rows to one canonical per `workspaceId` (reuse the
   `prod-investigation/recovery/recon` machinery; wallets should collapse to the
   home-region row, summing any unreplicated tail from `usage_events`).
3. **Add to publication.** The CR `platform-publication.yaml` is
   `FOR TABLES IN SCHEMA public`, so simply stop hand-excluding the two tables and
   re-assert the CR; then `ALTER SUBSCRIPTION ... REFRESH PUBLICATION` on all
   subscribers (deploy workflow does this). Note: the *live* publication is
   currently a hand-listed 89-table set (`puballtables=f`) that drifts from the
   CR — reconcile that drift as part of this step.
4. **Enforce.** Flip `HOME_REGION_ROUTING=enforce` (already the case) and the
   usage-wallet writer to enforce. Money paths fail **closed** (503) when the
   home region is unreachable, matching `FAIL_CLOSED_PREFIXES`.
5. **Verify.** `check-multiregion-cron-locks` green; re-run the recon collision
   scan → `usage_wallets` / `storage_usage` split_keys trend to 0; mesh stays 6/6.

## Rollout order (safe, reversible at each step)

1. Ship internal endpoints + `consumeUsage`/storage home-aware wrapper behind a
   default-off `USAGE_WALLET_HOME_WRITER=off` flag. No behavior change.
2. `=shadow`: log would-route decisions; validate 0 non-home writes.
3. Partition the wallet crons by `homeRegion`; update the cron-locks allowlist.
4. Converge divergent rows (recon dedupe).
5. Re-add both tables to the publication + refresh subscribers.
6. `=enforce`. Monitor apply-worker health + `pg_stat_subscription` lag; the
   conflict watchdog (`recon/91_conflict_watchdog.sh`) stays armed as a backstop.

Kill switches: `USAGE_WALLET_HOME_WRITER=off` reverts to local writes;
re-excluding the two tables from the publication reverts to region-local.

## Risks & mitigations

| risk | mitigation |
|---|---|
| Home region down → charges blocked | `usage_events` written locally first; outbox + reconcile job folds later; wallet only lags |
| Cross-region hop latency on completion finalize | It's post-stream (off TTFT); measure p95; fall back to async-fold (Design A) if unacceptable |
| Cron double-writes during rollout | Partition-by-homeRegion + `check-multiregion-cron-locks` guard before enabling |
| Publication CR re-reconciles to all-tables mid-rollout | Reconcile the CR-vs-live drift explicitly in step 3; only re-add once single-writer proven |
| Existing divergent rows replay as `insert_exists` when re-added | Converge/dedupe first (step 2); watchdog armed |

## Work breakdown

- [ ] `POST /api/internal/billing/consume` + `/storage-usage` (internal-token auth)
- [ ] `callPeerInternal()` helper (JSON RPC to `getPeer(homeRegion).url`, in-mesh TLS)
- [ ] Home-aware branch in `consumeUsage()` and `storage.service` writer
- [ ] `usage_events`-first ordering + outbox + home-region reconcile job
- [ ] Partition wallet reset/refill/alert crons by `workspace.homeRegion`; update `check-multiregion-cron-locks.ts`
- [ ] `USAGE_WALLET_HOME_WRITER` flag (off/shadow/enforce) + shadow logging
- [ ] Recon dedupe pass for `usage_wallets` + `storage_usage`
- [ ] Publication: reconcile CR drift, re-include both tables, refresh subscribers
- [ ] Validation: shadow 0-non-home report, collision scan → 0, mesh 6/6, p95 latency
