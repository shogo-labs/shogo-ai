# Region write-ownership — completion plan & runbook

> **Audience**: anyone working on the multi-region (US / EU / India)
> active-active Postgres mesh.
>
> **Why this exists**: the 2026-06 replication incidents (split-brain
> identities, FK-ordering breaks, `custom_domains` LWW churn, and the
> 2026-06-25 `SSL EOF` flap that rotted `sub_from_india` for hours) all
> trace to the same root cause: **the same logical rows are written in
> more than one region**, on a stack (vanilla CNPG / PG18 logical
> replication) that *detects* conflicts but does **not** resolve them.
> The conflict watchdog (`prod-investigation/recovery/recon/91_conflict_watchdog.sh`)
> keeps the mesh up by skipping/​re-enabling, but it is a bandaid — its
> keep-local skips silently drop data, and it has to be babysat.
>
> **The fix** is to make every logical row **single-writer** (region
> write-ownership / "region-pinned writes"), which is the industry
> best-practice for multi-region Postgres without a purpose-built
> multi-master extension. Once ownership is exhaustive and enforced, the
> conflict class disappears *by design* and the watchdog degrades to an
> alarm rather than a crutch.
>
> This plan covers four workstreams: **(A) table audit**, **(B) enforce
> rollout**, **(C) transport hardening**, **(D) DDL runbook**.

---

## 0. Current state (as of 2026-06-25, `v1.11.19`)

Already shipped (commit `529a5275`, deployed in **shadow** mode all regions):

- `Workspace.homeRegion` column + index (migration `20260624140000_add_workspace_home_region`).
- `homeRegion` stamped on workspace create (`workspace.service.ts`, generated `workspace.hooks.ts`).
- `apps/api/src/lib/region.ts` — region config (`REGION_ID`, `REGION_PEERS`, `PRIMARY_REGION`, `homeRegionForNewWorkspace()`).
- `apps/api/src/lib/region-peer-proxy.ts` — `proxyToPeer()`.
- `apps/api/src/lib/resolve-workspace-id.ts` — `resolveWorkspaceIdForRequest()`.
- `apps/api/src/middleware/home-region-router.ts` — `homeRegionWriteProxy`, gated by `HOME_REGION_ROUTING={off|shadow|enforce}`, applies to `POST/PUT/PATCH/DELETE`.
- Idempotent signup: Better Auth account-linking + hardened `user.create.before` in `auth.ts`.
- Backfill script `scripts/backfill-workspace-home-region.ts` (**not yet run**).

**Gaps this plan closes:**

1. Backfill not run → existing workspaces have `homeRegion = NULL` (router treats NULL as primary, so they're all effectively pinned to US until backfilled — correct but not intentional).
2. Still in `shadow` → nothing is actually proxied; conflicts continue.
3. The router only knows how to resolve **workspace-scoped** writes. **Identity** and **platform/global** tables (see audit) are not yet pinned and remain multi-writer.
4. Transport is unhardened (no keepalives, aggressive `disable_on_error`).
5. No expand/contract DDL discipline → the EU/India "missing `homeRegion` column" break recurs on every schema change.

---

## The invariant we are enforcing

> **Every table is written in exactly one region per logical row.**

Three ownership classes, three routing rules:

| Class | Owner | Routing rule |
|---|---|---|
| **Workspace-owned** | `workspace.homeRegion` | proxy write to the workspace's home region |
| **Identity / user-global** | the user (global) | idempotent + (decision) pin to user-home or primary |
| **Platform / catalog-global** | the platform | proxy write to `PRIMARY_REGION` (us-ashburn-1) |

---

## Part A — Table audit (90 models)

Generated from `prisma/schema.prisma`. Each model is classified by how a
write resolves to an owner. **Counter/additive tables are flagged 🔴** —
these corrupt under last-write-wins if ownership is ever bypassed, so they
are the highest-priority to get single-writer.

### A1. Workspace-owned — direct `workspaceId` (28)

Route on `workspace.homeRegion`. The router already resolves these via
`resolveWorkspaceIdForRequest()`.

`AgentCostMetric` 🔴, `AgentEvalResult`, `AgentEvalSet`, `ApiKey`,
`BillingAccount` 🔴, `BudgetAlert`, `ChatSession`, `Folder`, `Instance`,
`InstanceSubscription`, `Invitation`, `InviteLink`, `MarketplaceInstall`,
`Meeting`, `Member`, `ModelExperiment`, `Project`, `ProjectAgent`,
`StarredProject`, `StorageUsage` 🔴, `SubagentModelOverride`,
`Subscription`, `UsageEvent` 🔴, `UsageWallet` 🔴, `VoiceCallMeter` 🔴,
`VoiceProjectConfig`, `WorkspaceGrant`, `WorkspaceModelVisibility`
(+ `Workspace` itself).

### A2. Workspace-owned — via `projectId` → `Project.workspaceId` (11)

Router must resolve `project → workspace → homeRegion`. `resolveWorkspaceIdForRequest()`
already handles project paths/params; verify each route below hits that path.

`AgentConfig`, `ChatSessionProject`, `CustomDomain` ⚠️ *(the churn culprit)*,
`FeatureSession`, `GitHubConnection`, `MarketplaceListing`,
`ProjectAttachment`, `ProjectAuthConfig`, `ProjectAuthSignIn`,
`ProjectCheckpoint`, `ProjectFolder`.

### A3. Workspace-owned — via parent/`sessionId` chain (14)

These have no `workspaceId`/`projectId` of their own; they hang off a
session or run that resolves to a project/workspace. The resolver must walk
the chain (most already covered via `ChatSession`/`FeatureSession`).

- `ChatMessage` → `sessionId` → `ChatSession` → workspace
- `ToolCallLog` → `chatSessionId` → `ChatSession`
- `Requirement`, `DesignDecision`, `ClassificationDecision`,
  `AnalysisFinding`, `IntegrationPoint`, `TestCase`, `ImplementationTask`,
  `ImplementationRun`, `TestSpecification`, `TaskExecution`,
  `TaskDependency` → `sessionId` → `FeatureSession` → `Project` → workspace

> **Action**: add explicit resolver coverage + unit tests for the
> session-chain tables (`ChatMessage`, `ToolCallLog`, and the
> `FeatureSession` family). A miss here = the exact FK-ordering break we saw.

### A4. Identity / user-global (12) — **decision required**

A user is not naturally region-pinned (this *was* the split-brain bug).
Idempotent signup (done) stops duplicate `User`/`Account` inserts, but
ongoing profile/session writes can still happen in any region.

`User`, `Account`, `Session`, `Verification`, `Notification`,
`PushSubscription`, `RemoteAction`, `SignupAttribution`, `CreatorProfile`,
`MarketplaceReview`, `Affiliate`, `AffiliateAttribution`.

Two viable strategies (pick one — see Open Decisions):

- **(i) Pin to primary**: route all identity writes to `PRIMARY_REGION`.
  Simplest, fully conflict-free; costs cross-region latency on auth writes.
- **(ii) User-home-region**: add `User.homeRegion`, mirror the workspace
  pattern for identity. Best locality; more work, and "global" tables like
  `Session`/`Verification` still need a rule.

`Session`/`Verification` are short-lived; LWW + idempotency is acceptable
for those regardless of choice.

### A5. Platform / catalog-global (35) — route to `PRIMARY_REGION`

Reference/catalog/marketplace/affiliate-ledger data, written by admins or
platform jobs, read everywhere. Pin **all writes to the primary region**.

`PlatformSetting`, `ModelDefinition`, `ModelProvider`, `Registry`,
`ComponentDefinition`, `ComponentSpec`, `Composition`, `RendererBinding`,
`LayoutTemplate`, `MarketplaceListingVersion`, `MarketplaceTransaction` 🔴,
`LicenseKey`, `CreatorBadge`, `CreatorFollow`, `AffiliateClick`,
`AffiliateCommission` 🔴, `AffiliateCommissionTier`, `AffiliatePayout` 🔴,
`AffiliatePost`, `AffiliatePostSnapshot`, `AffiliateSocialAccount`,
`AnalysisFinding`*, `AnalyticsDigest`, `InfraSnapshot`, `EvalRun`,
`EvalRunResult`, `ModelExperiment`*, `TestSpecification`*, `Requirement`*…

> \* Some appear in both A3 and here depending on who writes them — resolve
> ambiguity during the per-route audit (B1). When in doubt, a table may only
> be in **one** class.

### A6. Audit completion checklist

- [ ] Every model assigned to exactly one class (A1–A5).
- [ ] For A2/A3, confirm the HTTP routes that mutate them flow through
      `resolveWorkspaceIdForRequest()` and resolve non-null.
- [ ] Add a CI guard: a test that fails if a new model with
      `workspaceId`/`projectId` is added without resolver coverage.
- [ ] Every 🔴 counter table verified single-writer (highest priority).

---

## Part B — Enforce rollout

Phased, reversible. Never flip straight to `enforce` globally.

### B1. Pre-flight (shadow analysis)

1. **Run the backfill** (dry-run first), against US primary only:
   ```bash
   bun scripts/backfill-workspace-home-region.ts --dry-run
   bun scripts/backfill-workspace-home-region.ts        # after review
   ```
   Verify `SELECT homeRegion, count(*) FROM workspaces GROUP BY 1;` on all
   three regions (must match — it replicates).
2. **Mine the shadow logs** for ≥48h across all regions:
   ```bash
   kubectl logs -l app=api --since=48h | grep 'home-region-router' \
     | grep would-proxy
   ```
   Confirm: (a) resolved `workspaceId` is non-null for real mutations,
   (b) the would-proxy target region matches expectation, (c) no hot path
   resolves to NULL (= unowned write = future conflict).
3. **Close resolver gaps** found in step 2 (A3 session-chain tables, any
   route not hitting the resolver). Re-deploy shadow, re-mine.

### B2. Enforce, per-class, one region pair at a time

`HOME_REGION_ROUTING` stays a single env var, but roll it region-by-region:

1. **Enforce in EU first** (lowest traffic), keep US/India shadow. Watch
   error rate, proxy latency (`proxyToPeer` adds one cross-region hop on
   non-home writes), and the mesh (`subenabled`, slot lag).
2. **Enforce India**, then **US**.
3. After workspace-owned is stable, extend the router to pin **A5
   platform-global → primary**, then resolve the **A4 identity decision**.

### B3. Success criteria (per step)

- Conflict-class apply errors → **0** new (`pg_stat_subscription_stats`
  deltas flat for `insert_exists`/FK over 24h).
- No subscription self-disables for a conflict reason.
- p99 write latency within budget (cross-region proxy hop is the cost).

### B4. Rollback

Flip the region back to `HOME_REGION_ROUTING=shadow` (env change + restart).
The router fails open (handles locally) when a peer is unreachable or a home
region is unknown — see `home-region-router.test.ts`.

---

## Part C — Transport hardening

Fixes the **connection-drop** class (today's `SSL EOF`), independent of
conflicts. Apply to all three CNPG clusters.

### C1. Keepalives + timeouts on the subscriber conninfo

The cross-region `subconninfo` currently lacks keepalives, so an idle/slow
cross-region socket gets reaped by a NAT/LB and surfaces as
`could not receive data from WAL stream: SSL SYSCALL error: EOF detected`.

Append to every `subconninfo` (per-subscription):
```
keepalives=1 keepalives_idle=30 keepalives_interval=10 keepalives_count=3
```
```sql
ALTER SUBSCRIPTION sub_from_eu
  CONNECTION 'host=... dbname=shogo user=logical_replicator sslmode=require
              keepalives=1 keepalives_idle=30 keepalives_interval=10 keepalives_count=3';
```

### C2. Raise WAL timeouts (CNPG cluster `postgresql.parameters`)

```yaml
wal_sender_timeout: "180s"     # was default 60s; cross-region needs slack
wal_receiver_timeout: "180s"
wal_retrieve_retry_interval: "5s"
```

### C3. Stop letting transient errors disable subscriptions

`disable_on_error=true` treats a *network* hiccup the same as a *data*
conflict — it disables the whole subscription, which (without a persistent
watcher) rots. Two options:

- **Preferred (post-ownership)**: set `disable_on_error=false`. Once Part B
  makes conflicts impossible, the only remaining apply errors are transient
  and should **auto-retry**, not disable.
- **Interim (before ownership is complete)**: keep `disable_on_error=true`
  but run the watchdog as a **persistent** in-cluster CronJob (Part E) so a
  disable self-heals in seconds.

### C4. Verify

```bash
# no EOF disables over 24h
kubectl logs <pg-pod> -c postgres --since=24h | grep -c 'SSL SYSCALL error: EOF'
# all 6 subs enabled, slots active, lag ~0
```

---

## Part D — DDL runbook (expand / contract)

> **Root cause of the EU/India break on 2026-06-25**: logical replication
> **does not replicate DDL**. The deploy pipeline runs migrations per-region
> (`SKIP_MIGRATIONS=false` on every region), and US deploys + starts writing
> the new column *before* EU/India have it — and a non-idempotent
> `ADD COLUMN` then fails as "already exists" if pre-applied, recording a
> **failed migration (P3009)** that blocks the region.

### D1. Rules for every schema change in the mesh

1. **Additive only, in the expand phase.** New columns nullable / with
   defaults; never drop/rename in the same release as code that depends on
   the new shape. (expand → migrate code → contract, across releases.)
2. **Idempotent migration SQL** for anything that might be pre-applied:
   `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, etc.
3. **Schema lands on ALL regions before any region writes the new shape.**
   Either:
   - **(preferred)** a pre-deploy job that runs `migrate deploy` against all
     three primaries *before* the app rollout, **or**
   - keep the current per-region migrate, but ensure the column-writing code
     path is dark (feature-flagged off) until all regions are migrated.
4. **Never hand-apply DDL out-of-band** (this is what created the P3009).
   If you must, immediately reconcile Prisma state (D3).

### D2. Recommended deploy ordering for mesh-affecting migrations

```
expand DDL to US  ──►  expand DDL to EU  ──►  expand DDL to India
        └──────────── all green ────────────┘
                         ▼
            roll app code (writes new shape)
```
Add a pipeline gate: "schema present on all regions" before the
column-writing image is allowed to take traffic.

### D3. If a migration is recorded as failed (P3009) but the schema is fine

(e.g. column already applied out-of-band). Mark it resolved — do **not**
re-run:
```bash
# preferred: official resolve
bunx prisma migrate resolve --applied <migration_name>
```
or, equivalently, directly:
```sql
UPDATE _prisma_migrations
SET finished_at = now(), applied_steps_count = 1, logs = NULL, rolled_back_at = NULL
WHERE migration_name = '<name>' AND finished_at IS NULL;
```
Then re-run the failed deploy jobs (`gh run rerun <id> --failed`).

### D4. Schema parity

`scripts/check-schema-parity.ts` already gates PG↔SQLite drift; cloud-only
columns (like `homeRegion`) go in its allow-list. Keep that list current.

---

## Part F — Paths that bypassed the router (closed, SHO-585)

The 2026-11-24 outage was not a routing bug in the router: it was three write
paths that never reached it, plus a watchdog that could not see the result.

| Path | Why it escaped | Closed by |
|---|---|---|
| `POST /api/chat-queued-messages {sessionId}` (and every body-only create) | The resolver never read the body, so the row fell through to the identity rule and was written in whichever region served the request. Draining happens in the home region, so the message was never sent — and "send now"/delete were *correctly* forwarded to a region that had no such row. | `resolve-workspace-id.ts` step 7 (`BODY_CREATE_LOOKUPS`), the router forwarding the bytes it consumed (`FORWARD_BODY_KEY`), and `/api/chat-queued-messages` added to the fail-closed set. |
| Zernio inbox writes (`handleZernioWebhook`, and the runtime-token reply/backfill routes under `/api/internal`, which `SKIP_PREFIXES` excludes) | Provider webhooks carry no Shogo session, and the agent surface is mounted where the router never looks. Both regions imported the same Instagram comments and collided on `zernioCommentId`. | `handleZernioWebhook` → `routeToHomeRegion('/api/internal/social/apply')`; a single guard inside `inbox.service` (`forwardInboxWrite`) → `/api/internal/social/inbox`, before the provider is called. |
| Team-chat inserts from background callers (agent dispatcher, work boards, huddles, polls, mail) | `postMessage` had ~40 callers and the guard would have had to live in each; no HTTP router sees the service paths at all. | One guard at the insert point (`conversation.service.postMessage`) → `routeToHomeRegion('/api/internal/conversations/post-message')`. Mentions, wakes, `seq` and hooks run in the home region, once. |

All three are no-ops in single-region/desktop (`isMultiRegionActive()` false),
so there is still one code path for both surfaces.

The **watchdog** side (Part E) is what let it run for 10 hours: it looked for
the conflict LSN in `kubectl logs --since=15m`, missed it, re-enabled the
subscription, and printed a *green* "nothing to do" run whenever the re-enable
momentarily worked. `conflict-watchdog.yaml` now finds the failing transaction
by peeking the publisher's slot from the database, classifies from
`pg_stat_subscription_stats`, re-enables an unknown cause at most
`MAX_BLIND_ENABLE` times, and pages (`REPLICATION_STALLED`, alert
`ReplicationStalled`) when an origin LSN has not moved for 15 minutes — enabled
or not.

---

## Part E — Demote the watchdog to a safety net

The watchdog should **never** be the thing keeping the mesh alive. Target
end-state:

1. **Persistent, in-cluster** watchdog as a `CronJob` (every 1m) in
   `shogo-production-system`, not a laptop loop — *interim* protection while
   Part B/C land.
2. **Alerting** (the missing seatbelt): page on
   - any `pg_subscription.subenabled = false`
   - logical slot lag > threshold or `active = false`
   - apply-error-count delta > 0
3. Once Part B (ownership) + Part C (`disable_on_error=false`) are in place,
   the watchdog's *skip* path is dead code (no conflicts to skip). Keep only
   the **alert**, retire the auto-skip — because every skip is silent data
   loss.

---

## Sequencing (recommended order)

1. **C (transport hardening)** — cheap, immediately stops the EOF-flap class.
2. **E1+E2 (persistent watchdog + alerts)** — interim seatbelt; makes
   everything else safe to roll.
3. **A (finish audit)** + close resolver gaps (A3 session chains).
4. **B1 (backfill + shadow mining)**.
5. **B2 (enforce, EU → India → US)** for workspace-owned.
6. **A5 platform-global → primary**, then **A4 identity decision**.
7. **C3 (`disable_on_error=false`)** + **E3 (retire auto-skip)** once
   conflicts are structurally impossible.

---

## Open decisions

1. **Identity routing (A4)**: pin identity writes to primary *(simpler,
   conflict-free, adds auth-write latency)* vs. add `User.homeRegion`
   *(better locality, more work)*.
2. **Enforce granularity**: single global `HOME_REGION_ROUTING` flag (current)
   vs. per-class flags (lets us enforce workspace-owned while still
   shadowing identity/global).
3. **Long-term**: is hand-rolled write-ownership the destination, or a
   stepping stone to a purpose-built multi-master stack (pgEdge Spock /
   AWS pgactive / EDB PGD) that gives automatic conflict resolution,
   delta-apply counters, global sequences, and **automatic DDL replication**
   (which would delete Part D entirely)? Revisit once Part B proves out the
   ownership model.
