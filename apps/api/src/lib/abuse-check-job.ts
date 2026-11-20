// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Daily abuse-check job (SHO-459).
 *
 * Runs one hour before the analytics digest (so the digest can link flags).
 * Main region only, wrapped in withGlobalJobLock('abuse-check-daily').
 *
 * Flow:
 *   1. Detect clusters of ≥5 free accounts sharing ip/device/message.
 *   2. Query free-account candidates from last 24h proxy_turns.
 *   3. For each candidate, ask the LLM judge.
 *   4. Apply policy: auto-ban (severity≥80, confidence=high, ≥2 turns), flag, or skip.
 *   5. Upsert AbuseFlag rows and call banUser for auto-bans.
 *   6. Send ops alert summary.
 */

import type { PrismaClient } from './prisma'
import { withGlobalJobLock } from './global-job-lock'
import { detectClusters } from '../services/abuse/clusters'
import { gatherCandidates } from '../services/abuse/candidates'
import { judgeCandidate, buildEvidence } from '../services/abuse/judge'
import { applyPolicy } from '../services/abuse/policy'
import { banUser } from '../services/abuse/ban'

const MAIN_REGION_ID = 'us-ashburn-1'
const ABUSE_CHECK_HOUR = parseInt(process.env.ABUSE_CHECK_HOUR || '7', 10) // 1h before digest at 8

function shouldScheduleAbuseCheck(): boolean {
  const region = process.env.REGION_ID
  return !region || region === MAIN_REGION_ID
}

function msUntilNextRun(): number {
  const now = new Date()
  const target = new Date(now)
  target.setUTCHours(ABUSE_CHECK_HOUR, 0, 0, 0)
  if (target <= now) target.setDate(target.getDate() + 1)
  return target.getTime() - now.getTime()
}

async function sendOpsAlert(summary: {
  date: string
  candidates: number
  banned: number
  flagged: number
  paidFlagged: number
}): Promise<void> {
  const msg = [
    `abuse-check ${summary.date}:`,
    `${summary.candidates} candidates,`,
    `${summary.banned} auto-banned,`,
    `${summary.flagged} flagged for review,`,
    `${summary.paidFlagged} paid flagged.`,
  ].join(' ')
  console.log(`[abuse-check] ${msg}`)
  const url = process.env.SHOGO_OPS_ALERT_WEBHOOK
  if (!url) return
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: msg, event: 'abuse_check', detail: summary }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    // Best-effort.
  }
}

export type AbuseCheckResult = {
  candidates: number
  banned: number
  flagged: number
  paidFlagged: number
}

/**
 * Core logic for one full abuse-check pass (no lock).
 * Called by `runAbuseCheck` (inside the lock) and by the replay script.
 * `runDate` defaults to today (UTC); pass a specific date for replay.
 */
export async function runAbuseCheckCore(
  prismaClient: PrismaClient,
  options: { runDate?: string; dryRun?: boolean } = {},
): Promise<AbuseCheckResult> {
  const db = prismaClient as any
  const now = new Date()
  const runDate = options.runDate ?? now.toISOString().split('T')[0]
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  console.log(`[abuse-check] Starting run for ${runDate} (dryRun=${options.dryRun ?? false})`)

  // 1. Detect clusters.
  const clusterKeys = await detectClusters(db, since)
  console.log(`[abuse-check] ${clusterKeys.size} cluster members detected`)

  // 2. Gather candidates.
  const candidates = await gatherCandidates(db, since, clusterKeys)
  console.log(`[abuse-check] ${candidates.length} candidates after pre-filter`)

  let autoBanned = 0
  let flagged = 0
  let paidFlagged = 0

  for (const candidate of candidates) {
    // Check whether still free at decision time.
    const hasActiveSub = await db.subscription.findFirst({
      where: {
        status: { in: ['active', 'trialing', 'past_due'] },
        workspace: { members: { some: { userId: candidate.userId } } },
      },
      select: { id: true },
    })
    const isFreeAccount = !hasActiveSub

    // 3. Judge.
    const result = await judgeCandidate(
      candidate.turns,
      candidate.clusterKey ? `This account belongs to cluster ${candidate.clusterKey}.` : undefined,
    )
    if (!result) continue // malformed JSON on both attempts

    for (const verdict of result.verdicts) {
      // 4. Policy.
      const decision = applyPolicy({ verdict, isFreeAccount })
      if (decision === 'none') continue

      const isBan = decision === 'ban' && !options.dryRun
      const evidence = buildEvidence(verdict.turnIds, candidate.turns)

      // 5. Upsert AbuseFlag.
      let flagId: string | null = null
      if (!options.dryRun) {
        const flag = await db.abuseFlag.upsert({
          where: {
            userId_runDate_category: {
              userId: candidate.userId,
              runDate,
              category: verdict.category,
            },
          },
          create: {
            userId: candidate.userId,
            runDate,
            category: verdict.category,
            severity: verdict.severity,
            confidence: verdict.confidence,
            summary: verdict.summary,
            evidence,
            clusterKey: candidate.clusterKey ?? null,
            status: isBan ? 'banned' : 'flagged',
            decidedByUserId: null,
            decidedAt: isBan ? new Date() : null,
            model: result.model,
          },
          update: {
            severity: verdict.severity,
            confidence: verdict.confidence,
            summary: verdict.summary,
            evidence,
            clusterKey: candidate.clusterKey ?? null,
            status: isBan ? 'banned' : 'flagged',
            decidedByUserId: null,
            decidedAt: isBan ? new Date() : null,
            model: result.model,
          },
        })
        flagId = flag.id
      }

      if (isBan) {
        await banUser({
          userId: candidate.userId,
          reason: `auto-ban: ${verdict.category} (severity=${verdict.severity}, confidence=${verdict.confidence})`,
          bannedByUserId: null,
          flagIds: flagId ? [flagId] : [],
        })
        autoBanned++
        console.log(
          `[abuse-check] AUTO-BAN userId=${candidate.userId} email=${candidate.email} category=${verdict.category} severity=${verdict.severity}`,
        )
      } else {
        if (!isFreeAccount) paidFlagged++
        else flagged++
        console.log(
          `[abuse-check] FLAG userId=${candidate.userId} email=${candidate.email} category=${verdict.category} severity=${verdict.severity} decision=${decision}`,
        )
      }
    }
  }

  const summary = {
    date: runDate,
    candidates: candidates.length,
    banned: autoBanned,
    flagged,
    paidFlagged,
  }
  if (!options.dryRun) await sendOpsAlert(summary)

  return { candidates: candidates.length, banned: autoBanned, flagged, paidFlagged }
}

/**
 * Locked entry-point for the daily scheduler.
 * `withGlobalJobLock` is the outermost await in the body (required by
 * scripts/check-multiregion-cron-locks.ts).
 */
export async function runAbuseCheck(
  prismaClient: PrismaClient,
  options: { runDate?: string; dryRun?: boolean } = {},
): Promise<AbuseCheckResult> {
  const locked = await withGlobalJobLock('abuse-check-daily', () =>
    runAbuseCheckCore(prismaClient, options),
  )
  if (!locked.acquired) return { candidates: 0, banned: 0, flagged: 0, paidFlagged: 0 }
  return locked.result
}

let abuseCheckTimer: ReturnType<typeof setTimeout> | null = null

export function startAbuseCheckJob(prismaClient: PrismaClient): void {
  if (!shouldScheduleAbuseCheck()) {
    console.log(
      `[abuse-check] Not the main region (REGION_ID=${process.env.REGION_ID}); scheduler not started.`,
    )
    return
  }

  function scheduleNext() {
    const delay = msUntilNextRun()
    const nextRun = new Date(Date.now() + delay)
    console.log(`[abuse-check] Next run at ${nextRun.toISOString()} (in ${Math.round(delay / 60000)}m)`)

    abuseCheckTimer = setTimeout(async () => {
      try {
        await runAbuseCheck(prismaClient)
      } catch (err: any) {
        console.error('[abuse-check] Job failed:', err.message)
      }
      scheduleNext()
    }, delay)
  }

  scheduleNext()
  console.log('[abuse-check] Scheduler started')
}

export function stopAbuseCheckJob(): void {
  if (abuseCheckTimer) {
    clearTimeout(abuseCheckTimer)
    abuseCheckTimer = null
  }
}
