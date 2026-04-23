// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Daily cron that charges the monthly Twilio number recurring fee
 * (`voice_number_monthly`) for every provisioned number whose
 * `monthlyRateDebitedFor` watermark is older than the current UTC
 * period (start of this month).
 *
 * Safe to re-run: the watermark is advanced inside the debit
 * transaction, so any second run inside the same period is a strict
 * no-op. If a debit fails (e.g. insufficient credits) the watermark
 * stays put so the next run retries. The Project Settings > Phone tab
 * also pre-flights `numberSetup + numberMonthly` against the ledger
 * when a customer provisions a number, so failures here are rare.
 */

import { prisma } from '../lib/prisma'
import { consumeCredits } from '../services/billing.service'
import {
  resolvePlanIdForWorkspace,
  resolveVoiceRate,
} from '../lib/voice-cost'

function startOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0))
}

export interface VoiceMonthlyRebillSummary {
  processed: number
  debited: number
  skipped: number
  failed: number
  period: Date
}

export async function runVoiceMonthlyRebill(
  options: { now?: Date } = {},
): Promise<VoiceMonthlyRebillSummary> {
  const now = options.now ?? new Date()
  const period = startOfMonthUtc(now)

  const configs = await prisma.voiceProjectConfig.findMany({
    where: {
      twilioPhoneSid: { not: null },
      OR: [
        { monthlyRateDebitedFor: null },
        { monthlyRateDebitedFor: { lt: period } },
      ],
    },
    select: {
      projectId: true,
      workspaceId: true,
      twilioPhoneSid: true,
      twilioPhoneNumber: true,
    },
  })

  const summary: VoiceMonthlyRebillSummary = {
    processed: configs.length,
    debited: 0,
    skipped: 0,
    failed: 0,
    period,
  }

  for (const cfg of configs) {
    try {
      const planId = await resolvePlanIdForWorkspace(cfg.workspaceId)
      const cost = resolveVoiceRate(planId, 'numberMonthly')
      const result = await consumeCredits(
        cfg.workspaceId,
        cfg.projectId,
        'voice-rebill',
        'voice_number_monthly',
        cost,
        {
          projectId: cfg.projectId,
          twilioPhoneSid: cfg.twilioPhoneSid,
          twilioPhoneNumber: cfg.twilioPhoneNumber,
          creditsForPeriod: cost,
          periodStart: period.toISOString(),
        },
      )

      if (!result.success) {
        console.warn(
          '[VoiceRebill] debit failed, leaving watermark for retry',
          {
            projectId: cfg.projectId,
            reason: result.error,
          },
        )
        summary.failed += 1
        continue
      }

      // Advance the watermark so the next run is a no-op for this
      // config until the next month boundary.
      await prisma.voiceProjectConfig.update({
        where: { projectId: cfg.projectId },
        data: { monthlyRateDebitedFor: period },
      })
      summary.debited += 1
    } catch (err) {
      summary.failed += 1
      console.error('[VoiceRebill] unexpected error:', err)
    }
  }

  if (summary.processed > 0) {
    console.log('[VoiceRebill] cycle complete', summary)
  }
  return summary
}

/**
 * Start a setInterval-based scheduler that runs the rebill once per
 * day. Intended to be called from `server.ts` at boot, mirroring the
 * storage-recalc cron already in place.
 */
export function startVoiceMonthlyRebillCron(
  intervalMs: number = 24 * 60 * 60 * 1000,
) {
  setTimeout(() => {
    runVoiceMonthlyRebill().catch((err) =>
      console.error('[VoiceRebill] initial run failed:', err),
    )
    setInterval(() => {
      runVoiceMonthlyRebill().catch((err) =>
        console.error('[VoiceRebill] periodic run failed:', err),
      )
    }, intervalMs)
  }, 20_000)
  console.log(
    `[VoiceRebill] monthly-number rebill cron scheduled (every ${Math.round(
      intervalMs / 3600000,
    )}h)`,
  )
}
