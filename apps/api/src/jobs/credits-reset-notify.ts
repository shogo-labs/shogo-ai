// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Your agent is back" — the second half of the free-cap moment (SHO-258 §4).
 *
 * The cap notice promises a reset time, and until now nothing told anyone it
 * had arrived. Windows reset lazily (`rollWindow`), so there is no event to
 * hang this off: the 402 writes `usage_wallets.capNotifyPendingAt`, and this
 * sweep finds those wallets whose 5-hour window has reopened, sends one push +
 * in-app row + email, and clears the flag.
 *
 * Multi-region: home-region partitioned, not globally locked. `usage_wallets`
 * is never replicated, so each region clears only the flags it owns
 * (`homeWorkspaceIds`), exactly like `expire-signup-credits.ts`.
 *
 * Losing a run only delays a nudge; the flag stays set until it is delivered.
 */
import { prisma } from '../lib/prisma'
import { homeWorkspaceIds } from '../lib/region'
import { notifyCreditsReset } from '../lib/lifecycle-notifications'

export interface CreditsResetSummary {
  pending: number
  notified: number
  failed: number
}

/**
 * Window length of the gating short window. Kept local (not imported from the
 * billing service) so this job can run in a bundle without the Stripe client;
 * it only compares timestamps.
 */
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000

export async function runCreditsResetNotify(options: { now?: Date; batchSize?: number } = {}): Promise<CreditsResetSummary> {
  const now = options.now ?? new Date()
  const summary: CreditsResetSummary = { pending: 0, notified: 0, failed: 0 }

  const pending = await prisma.usageWallet.findMany({
    where: { capNotifyPendingAt: { not: null } },
    select: {
      workspaceId: true,
      capNotifyPendingAt: true,
      fiveHourWindowStart: true,
    },
    take: options.batchSize ?? 500,
  })
  summary.pending = pending.length
  if (pending.length === 0) return summary

  const home = await homeWorkspaceIds(pending.map((w) => w.workspaceId))
  const due = home ? pending.filter((w) => home.has(w.workspaceId)) : pending
  if (due.length === 0) return summary

  for (const wallet of due) {
    try {
      // Still inside the same 5-hour window the cap happened in? Then nothing
      // has reset yet — leave the flag for the next sweep.
      const start = wallet.fiveHourWindowStart
      if (start && now.getTime() - start.getTime() < FIVE_HOUR_MS) continue

      const owner = await resolveWorkspaceOwner(wallet.workspaceId)
      if (!owner) {
        // No owner to notify (deleted user / system workspace): drop the flag
        // rather than retrying it forever.
        await clearFlag(wallet.workspaceId, wallet.capNotifyPendingAt)
        continue
      }

      const lastProject = await prisma.chatSession.findFirst({
        where: { workspaceId: wallet.workspaceId, contextType: 'project', contextId: { not: null } },
        orderBy: { lastActiveAt: 'desc' },
        select: { contextId: true },
      })
      const projectId = lastProject?.contextId ?? null
      const projectName = projectId
        ? ((await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } }))?.name ?? 'your project')
        : 'your workspace'

      await notifyCreditsReset({
        userId: owner,
        workspaceId: wallet.workspaceId,
        projectId,
        projectName,
        resetAt: start ? new Date(start.getTime() + FIVE_HOUR_MS) : now,
      })
      await clearFlag(wallet.workspaceId, wallet.capNotifyPendingAt)
      summary.notified += 1
    } catch (error: any) {
      summary.failed += 1
      console.error('[CreditsReset] notify failed:', { workspaceId: wallet.workspaceId, err: error?.message ?? error })
    }
  }

  if (summary.notified > 0 || summary.failed > 0) {
    console.log('[CreditsReset] cycle complete', summary)
  }
  return summary
}

/** The user to tell: the workspace owner, else any member. */
async function resolveWorkspaceOwner(workspaceId: string): Promise<string | null> {
  const member = await (prisma as any).member?.findFirst?.({
    where: { workspaceId },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    select: { userId: true },
  })
  return member?.userId ?? null
}

/**
 * Clear the flag conditionally on its previous value, so a fresh cap that
 * landed while we were sending is not wiped out.
 */
async function clearFlag(workspaceId: string, seenAt: Date | null): Promise<void> {
  await prisma.usageWallet.updateMany({
    where: { workspaceId, capNotifyPendingAt: seenAt },
    data: { capNotifyPendingAt: null },
  })
}

/** Every-10-minutes scheduler; mirrors `startExpireSignupCreditsCron`. */
export function startCreditsResetNotifyCron(intervalMs: number = 10 * 60 * 1000) {
  setTimeout(() => {
    runCreditsResetNotify().catch((err) => console.error('[CreditsReset] initial run failed:', err))
    setInterval(() => {
      runCreditsResetNotify().catch((err) => console.error('[CreditsReset] periodic run failed:', err))
    }, intervalMs)
  }, 45_000)
  console.log(`[CreditsReset] cron scheduled (every ${Math.round(intervalMs / 60000)}m)`)
}
