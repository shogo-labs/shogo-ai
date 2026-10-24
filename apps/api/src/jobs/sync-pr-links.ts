// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PR-link sweep — every five minutes, refresh the `pr` links on cards that
 * have gone stale, per workspace.
 *
 * Why a sweep as well as webhooks: `pull_request` / `check_run` /
 * `workflow_run` only arrive for a repo connected through the GitHub App. A
 * repo wired up with a personal token (every agent sandbox today) delivers
 * nothing, and a dropped delivery loses a transition for good. Without this,
 * a card behind a token-connected PR would never move. Each link is refreshed
 * at most once per 15 minutes, so the cost is a handful of GitHub reads.
 */

import { withGlobalJobLock } from '../lib/global-job-lock'
import { prisma } from '../lib/prisma'
import { syncPrLinksForWorkspace } from '../services/work-item-pr.service'

export interface SyncPrLinksSummary {
  lockSkipped?: boolean
  workspaces?: number
  refreshed?: number
}

/** How many workspaces to sweep per tick (bounds GitHub calls). */
const WORKSPACE_LIMIT = 40
/** A link older than this is worth re-reading. */
const STALE_MS = 15 * 60_000

async function sweepOnce(): Promise<SyncPrLinksSummary> {
  const rows = (await (prisma as any).workItemLink.findMany({
    where: { kind: 'pr' },
    select: { workspaceId: true },
    distinct: ['workspaceId'],
    take: WORKSPACE_LIMIT,
  })) as Array<{ workspaceId: string }>

  let refreshed = 0
  for (const row of rows) {
    try {
      refreshed += await syncPrLinksForWorkspace(row.workspaceId, { staleMs: STALE_MS })
    } catch (err: any) {
      console.error(
        `[SyncPrLinks] sweep for ${row.workspaceId} failed (non-fatal):`,
        err?.message ?? err,
      )
    }
  }
  return { workspaces: rows.length, refreshed }
}

export async function runSyncPrLinks(): Promise<SyncPrLinksSummary> {
  const lockResult = await withGlobalJobLock('sync-pr-links', async () => sweepOnce())
  if (!lockResult.acquired) return { lockSkipped: true }
  return lockResult.result
}

/** Schedule the sweep. Override the interval in tests. */
export function startSyncPrLinksCron(intervalMs: number = 5 * 60 * 1000) {
  const timer = setInterval(() => {
    runSyncPrLinks().catch((err) =>
      console.error('[SyncPrLinks] periodic run failed:', err),
    )
  }, intervalMs)
  ;(timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()
  console.log(`[SyncPrLinks] cron scheduled (every ${Math.round(intervalMs / 1000)}s)`)
}
