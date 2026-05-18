// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Boot-time marketplace migration chain.
 *
 *   1. templates → marketplace migration creates listings/versions
 *      with a jsonb `workspaceSnapshot` for each first-party template.
 *   2. snapshot S3 backfill picks up those v1.0.0 rows and uploads
 *      their tarballs to S3, populating `workspaceSnapshotKey`.
 *
 * Step 2 STRICTLY DEPENDS on step 1 — it filters by
 * `workspaceSnapshot != null AND workspaceSnapshotKey == null`, so
 * if step 1 hasn't yet committed any v1.0.0 rows when step 2 fires,
 * step 2 silently no-ops. Pre-fix the two halves were independent
 * `void (async () => …)()` IIFEs and raced; the very first prod cold
 * start would frequently leave S3 keys unpopulated until the SECOND
 * pod boot caught up.
 *
 * The factor-out into a function (rather than living inline in
 * `server.ts`) is purely so the ordering invariant can be unit-tested
 * — see `boot-marketplace-migrations.test.ts`.
 */

export interface BootMarketplaceMigrationsDeps {
  /**
   * Loader for `runMigration` from `migrate-templates-to-marketplace.ts`.
   * A function (not the module) so the dynamic import stays lazy: in
   * production this is `() => import('../scripts/...').then(m => m.runMigration)`.
   */
  loadRunMigration: () => Promise<(opts: { quiet: boolean }) => Promise<unknown>>
  /** Loader for `runSnapshotBackfill` — same lazy-import shape. */
  loadRunSnapshotBackfill: () => Promise<(opts: { quiet: boolean }) => Promise<unknown>>
  /** Env source. Tests inject; prod passes `process.env`. */
  env: {
    SHOGO_SKIP_TEMPLATE_MIGRATION?: string
    SHOGO_SKIP_SNAPSHOT_BACKFILL?: string
  }
  /** Logger for the non-fatal error branch. Defaults to `console.error`. */
  onError?: (label: string, err: Error) => void
}

/**
 * Run the migrate → backfill chain SEQUENTIALLY. Errors are swallowed
 * per-step so a transient failure of one doesn't gate the other or
 * the API itself from accepting requests.
 */
export async function runBootMarketplaceMigrations(
  deps: BootMarketplaceMigrationsDeps,
): Promise<void> {
  const onError =
    deps.onError ?? ((label, err) => console.error(`[BootMigrate] ${label} (non-fatal):`, err.message))

  if (deps.env.SHOGO_SKIP_TEMPLATE_MIGRATION !== 'true') {
    try {
      const runMigration = await deps.loadRunMigration()
      await runMigration({ quiet: true })
    } catch (err) {
      onError('templates → marketplace migration failed', err as Error)
    }
  }

  if (deps.env.SHOGO_SKIP_SNAPSHOT_BACKFILL !== 'true') {
    try {
      const runSnapshotBackfill = await deps.loadRunSnapshotBackfill()
      await runSnapshotBackfill({ quiet: true })
    } catch (err) {
      onError('snapshot S3 backfill failed', err as Error)
    }
  }
}
