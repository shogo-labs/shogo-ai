// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Custom-domain reconciler cron — every 60s, polls Cloudflare for every
 * bring-your-own custom domain that hasn't reached `active` yet, persists
 * the latest validation/SSL status, writes the Worker KV route once a
 * hostname goes live, and notifies the project owner.
 *
 * Why a background poller (and not just the in-UI "Check now" button):
 * Cloudflare for SaaS does not push custom-hostname SSL status events, so
 * the only way a domain reliably goes live AFTER the user closes the publish
 * panel is for us to poll. This makes "add DNS records, walk away, come back
 * to a live domain" work the way Vercel/Lovable do.
 *
 * Multi-region safety: wrapped in `withGlobalJobLock('poll-custom-domains')`
 * so exactly one region reconciles per tick (the body writes `custom_domains`
 * rows + the shared Worker KV map; two regions racing would double-write KV
 * and double-notify). Feature-gated on the Cloudflare for SaaS config, so
 * stacks without custom domains never call Cloudflare.
 */

import { withGlobalJobLock } from '../lib/global-job-lock'
import { prisma } from '../lib/prisma'
import {
  getCustomHostnamesConfig,
  retriggerCustomHostname,
} from '../lib/cloudflare-custom-hostnames'
import {
  refreshCustomDomain,
  shouldAutoRetrigger,
  isDueForPoll,
  type CustomDomainRowLike,
} from '../services/custom-domain.service'
import { createNotification } from '../services/notification.service'

export interface PollCustomDomainsSummary {
  disabled?: boolean
  lockSkipped?: boolean
  polled?: number
  activated?: number
  /** How many stalled domains were auto-re-triggered this tick. */
  retriggered?: number
  /** Non-active rows skipped this tick by the slow-poll backoff. */
  skipped?: number
}

/** How many non-active domains to reconcile per tick (bounds CF calls). */
const BATCH_LIMIT = 200

async function pollOnce(): Promise<PollCustomDomainsSummary> {
  // Every custom hostname still working toward `active` (incl. `failed` so a
  // user who corrects their DNS recovers automatically on the next tick).
  // `updatedAt asc` puts the least-recently-touched rows first, so any
  // recently-checked (not-yet-due) slow-cadence rows sort to the back and
  // never starve due rows out of the batch.
  const candidates = (await prisma.customDomain.findMany({
    where: { status: { not: 'active' }, cfCustomHostnameId: { not: null } },
    orderBy: { updatedAt: 'asc' },
    take: BATCH_LIMIT,
  })) as CustomDomainRowLike[]

  // Back off long-pending domains from per-tick polling to one poll per
  // SLOW_POLL_INTERVAL_MS once past SLOW_POLL_AFTER_MS (~30 checks / 30m).
  const now = Date.now()
  const pending = candidates.filter((d) => isDueForPoll(d, now))
  const skipped = candidates.length - pending.length

  if (pending.length === 0) return { polled: 0, activated: 0, retriggered: 0, skipped }

  const projectIds = [...new Set(pending.map((d) => d.projectId))]
  const projects = await prisma.project.findMany({
    where: { id: { in: projectIds } },
    select: { id: true, publishedSubdomain: true, createdBy: true },
  })
  const projectById = new Map(projects.map((p) => [p.id, p]))

  // Load ALL rows for affected projects so canonical resolution sees the
  // (possibly already-active) primary that isn't in the pending set.
  const allRows = (await prisma.customDomain.findMany({
    where: { projectId: { in: projectIds } },
  })) as CustomDomainRowLike[]
  const siblingsByProject = new Map<string, CustomDomainRowLike[]>()
  for (const r of allRows) {
    const list = siblingsByProject.get(r.projectId) ?? []
    list.push(r)
    siblingsByProject.set(r.projectId, list)
  }

  let activated = 0
  let retriggered = 0
  for (const row of pending) {
    const project = projectById.get(row.projectId)
    try {
      const { row: updated, becameActive } = await refreshCustomDomain({
        row,
        siblings: siblingsByProject.get(row.projectId) ?? [row],
        publishedSubdomain: project?.publishedSubdomain ?? null,
      })
      if (becameActive) {
        activated++
        if (project?.createdBy) {
          await createNotification({
            userId: project.createdBy,
            type: 'custom_domain_live',
            title: 'Custom domain is live',
            message: `${row.hostname} is now serving your app over HTTPS.`,
            actionUrl: `shogo://projects/${row.projectId}`,
            metadata: { projectId: row.projectId, hostname: row.hostname },
            dedupeKey: `custom-domain-live:${row.id}`,
          })
        }
        continue
      }

      // Self-heal: the domain's DNS is correct but issuance has stalled past
      // the threshold (e.g. a slow CA). Re-kick validation WITHOUT changing
      // the tokens, then bump the cooldown/backoff counters so we don't loop
      // faster than AUTO_RETRIGGER_INTERVAL_MS or beyond MAX_RETRIGGERS.
      // Leader-only (this whole tick runs under the advisory lock).
      if (updated.cfCustomHostnameId && shouldAutoRetrigger(updated)) {
        try {
          await retriggerCustomHostname(updated.cfCustomHostnameId)
          await prisma.customDomain.update({
            where: { id: updated.id },
            data: { lastRetriggerAt: new Date(), retriggerCount: { increment: 1 } },
          })
          retriggered++
          console.log(
            `[PollCustomDomains] auto-retriggered ${updated.hostname} ` +
              `(attempt ${updated.retriggerCount + 1})`,
          )
        } catch (err: any) {
          console.error(
            `[PollCustomDomains] auto-retrigger ${updated.hostname} failed (non-fatal):`,
            err?.message ?? err,
          )
        }
      }
    } catch (err: any) {
      console.error(
        `[PollCustomDomains] refresh ${row.hostname} failed (non-fatal):`,
        err?.message ?? err,
      )
    }
  }

  return { polled: pending.length, activated, retriggered, skipped }
}

export async function runPollCustomDomains(): Promise<PollCustomDomainsSummary> {
  if (!getCustomHostnamesConfig()) return { disabled: true }
  const lockResult = await withGlobalJobLock('poll-custom-domains', async () => {
    return pollOnce()
  })
  if (!lockResult.acquired) return { lockSkipped: true }
  return lockResult.result
}

/**
 * Schedule the reconciler. Every 60s — fast enough that a domain typically
 * goes live within a minute of DNS propagating, while one CF GET per pending
 * hostname per minute keeps API usage trivial. Override in tests.
 */
export function startPollCustomDomainsCron(intervalMs: number = 60 * 1000) {
  setTimeout(() => {
    runPollCustomDomains().catch((err) =>
      console.error('[PollCustomDomains] initial run failed:', err),
    )
    setInterval(() => {
      runPollCustomDomains().catch((err) =>
        console.error('[PollCustomDomains] periodic run failed:', err),
      )
    }, intervalMs)
  }, 45_000)
  console.log(
    `[PollCustomDomains] cron scheduled (every ${Math.round(intervalMs / 1000)}s)`,
  )
}
