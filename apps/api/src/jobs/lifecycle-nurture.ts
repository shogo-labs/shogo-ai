// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Your idea is still waiting" — a once-only nudge for a signup who never built
 * anything (SHO-615, growth plan §0 G9b).
 *
 * Before this, nothing followed up with someone who signed up, typed an idea in
 * onboarding, and left. `email.service.ts` only sent transactional mail and there
 * was no job watching for the stall. This sweep runs hourly: for every user who
 * signed up 24–72 hours ago with no project of their own, it sends one email that
 * quotes the idea they typed (recovered from their onboarding chat) and links
 * straight back into it.
 *
 * The 24–72h window is deliberately bounded, so a deploy never emails the whole
 * back catalogue of stale signups at once.
 *
 * Exactly-once: the lifecycle ledger claims `no_project_24h:<userId>:1`; a second
 * run (or a second pod) is a no-op. The body is wrapped in `withGlobalJobLock`
 * (`lifecycle-nurture`) so only one region runs the sweep per tick.
 *
 * Local mode: `isEmailConfigured()` is false, so `runLifecycleNurture` returns
 * `{ skipped: 'email_not_configured' }` before any query or claim. No desktop
 * branch — the same code path just short-circuits.
 */
import { withGlobalJobLock } from '../lib/global-job-lock'
import { prisma } from '../lib/prisma'
import { getFrontendUrl } from '../lib/cloud-urls'
import {
  claimLifecycleEmail,
  lifecycleEmailAllowed,
  releaseLifecycleEmail,
  unsubscribeUrl,
} from '../lib/lifecycle-email'
import { isEmailConfigured, sendFirstBuildNudgeEmail } from '../services/email.service'

const HOUR_MS = 60 * 60 * 1000
/** Old enough to have finished onboarding; young enough not to be the back catalogue. */
const MIN_AGE_MS = 24 * HOUR_MS
const MAX_AGE_MS = 72 * HOUR_MS
const DEFAULT_BATCH = 200

/**
 * The example prompts the no-session variant offers. Kept in step with
 * apps/mobile/components/onboarding/cloud/BuildPromptStep.tsx's EXAMPLES (the
 * first three) — mirrored rather than imported because the API build must not
 * depend on the mobile app.
 */
const EXAMPLE_PROMPTS = [
  'A booking page for my salon',
  'A habit tracker app',
  'A landing page for my bakery',
]

/**
 * Mirrors apps/mobile/components/chat/turns/buildBrief.ts. The onboarding step
 * wraps the typed idea in a `::Build Brief::` marker + instructions; this
 * recovers the idea. Kept in sync with that file's marker and separator.
 */
const BUILD_BRIEF_MARKER = '::Build Brief::'
const BUILD_BRIEF_PATTERN = /^::Build Brief::(?:\r?\n|$)/
const INSTRUCTIONS_SEPARATOR = '\n\n---\n'

function parseBuildBriefMessage(text: string): string | null {
  const match = text.match(BUILD_BRIEF_PATTERN)
  if (!match) return null
  const body = text.slice(match[0].length)
  const separator = body.indexOf(INSTRUCTIONS_SEPARATOR)
  const idea = (separator === -1 ? body : body.slice(0, separator)).trim()
  return idea || null
}

export interface LifecycleNurtureSummary {
  candidates: number
  sent: number
  skipped: number
  failed: number
}

/**
 * Run the sweep. Returns the summary, or `{ skipped }` when it did nothing at the
 * top level (email not configured, or another region held the lock).
 */
export async function runLifecycleNurture(
  options: { now?: Date; batchSize?: number } = {},
): Promise<LifecycleNurtureSummary | { skipped: string }> {
  // Before any query or claim — local mode lands here and stops.
  if (!isEmailConfigured()) return { skipped: 'email_not_configured' }

  const lock = await withGlobalJobLock('lifecycle-nurture', () =>
    nurtureSweepBody(options.now ?? new Date(), options.batchSize ?? DEFAULT_BATCH),
  )
  if (!lock.acquired) return { skipped: lock.reason }
  return lock.result
}

/** The sweep itself, split out so the lock wrapper stays a thin shell. */
export async function nurtureSweepBody(now: Date, batchSize: number): Promise<LifecycleNurtureSummary> {
  const summary: LifecycleNurtureSummary = { candidates: 0, sent: 0, skipped: 0, failed: 0 }

  const users = await prisma.user.findMany({
    where: {
      createdAt: {
        gte: new Date(now.getTime() - MAX_AGE_MS),
        lte: new Date(now.getTime() - MIN_AGE_MS),
      },
      lifecycleEmailOptOutAt: null,
    },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
    select: { id: true, email: true },
  })
  if (users.length === 0) return summary

  // A project of their own means they built — no nudge. One query for the whole
  // batch instead of one per user.
  const withProjects = await prisma.project.findMany({
    where: { createdBy: { in: users.map((u) => u.id) } },
    select: { createdBy: true },
  })
  const built = new Set(withProjects.map((p) => p.createdBy).filter((id): id is string => !!id))

  const base = getFrontendUrl()

  for (const user of users) {
    if (!user.email) continue
    summary.candidates += 1
    if (built.has(user.id)) {
      summary.skipped += 1
      continue
    }

    try {
      const session = await prisma.chatSession.findFirst({
        where: {
          createdByUserId: user.id,
          contextType: 'workspace',
          messages: { some: { role: 'user' } },
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, inferredName: true },
      })

      let prompt: string | null = null
      let continueUrl = base
      if (session) {
        continueUrl = `${base}/agent?chatSessionId=${encodeURIComponent(session.id)}`
        const firstMessage = await prisma.chatMessage.findFirst({
          where: { sessionId: session.id, role: 'user' },
          orderBy: { createdAt: 'asc' },
          select: { content: true },
        })
        prompt = (firstMessage ? parseBuildBriefMessage(firstMessage.content) : null)
          ?? (session.inferredName?.trim() || null)
      }

      const ledgerId = await claimLifecycleEmail('no_project_24h', user.id, '1')
      if (!ledgerId) {
        summary.skipped += 1
        continue
      }

      // Re-check the opt-out: it may have been set between the batch query and
      // this send.
      const fresh = await prisma.user.findUnique({
        where: { id: user.id },
        select: { lifecycleEmailOptOutAt: true },
      })
      if (!lifecycleEmailAllowed(fresh)) {
        await releaseLifecycleEmail(ledgerId)
        summary.skipped += 1
        continue
      }

      const result = await sendFirstBuildNudgeEmail({
        to: user.email,
        prompt,
        examples: EXAMPLE_PROMPTS,
        continueUrl,
        unsubscribeUrl: unsubscribeUrl(user.id),
      })
      if (!result.success) {
        await releaseLifecycleEmail(ledgerId)
        summary.failed += 1
        continue
      }
      summary.sent += 1
    } catch (error: any) {
      summary.failed += 1
      console.error('[LifecycleNurture] user failed:', { userId: user.id, err: error?.message ?? error })
    }
  }

  if (summary.sent > 0 || summary.failed > 0) {
    console.log('[LifecycleNurture] cycle complete', summary)
  }
  return summary
}

/** Hourly scheduler; mirrors `startCreditsResetNotifyCron`. */
export function startLifecycleNurtureCron(intervalMs: number = 60 * 60 * 1000): void {
  setTimeout(() => {
    runLifecycleNurture().catch((err) => console.error('[LifecycleNurture] initial run failed:', err))
    setInterval(() => {
      runLifecycleNurture().catch((err) => console.error('[LifecycleNurture] periodic run failed:', err))
    }, intervalMs)
  }, 60_000)
  console.log(`[LifecycleNurture] cron scheduled (every ${Math.round(intervalMs / 60_000)}m)`)
}
