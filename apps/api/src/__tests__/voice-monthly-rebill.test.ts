// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit test for the monthly voice-number rebill cron. Mocks the prisma
 * client + billing service so nothing touches the DB. Focuses on the
 * idempotency contract: running the job twice inside a single UTC
 * month is a strict no-op for rows already at the period watermark.
 *
 *   bun test apps/api/src/__tests__/voice-monthly-rebill.test.ts
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'

import { VOICE_RAW_USD } from '../config/usage-plans'
import { MARKUP_MULTIPLIER } from '../lib/usage-cost'

// ---------- mocks ----------

interface VoiceCfg {
  projectId: string
  workspaceId: string
  twilioPhoneSid: string | null
  twilioPhoneNumber: string | null
  monthlyRateDebitedFor: Date | null
}

let rows: VoiceCfg[] = []
let consumeCalls: any[] = []
let updatedWatermarks: Array<{ projectId: string; to: Date }> = []

mock.module('../lib/prisma', () => ({
  prisma: {
    voiceProjectConfig: {
      findMany: async ({ where }: any) => {
        const period = where.OR[1]?.monthlyRateDebitedFor?.lt as Date
        return rows.filter(
          (r) =>
            r.twilioPhoneSid !== null &&
            (r.monthlyRateDebitedFor === null ||
              r.monthlyRateDebitedFor < period),
        )
      },
      update: async ({
        where,
        data,
      }: {
        where: { projectId: string }
        data: { monthlyRateDebitedFor: Date }
      }) => {
        updatedWatermarks.push({
          projectId: where.projectId,
          to: data.monthlyRateDebitedFor,
        })
        const r = rows.find((x) => x.projectId === where.projectId)
        if (r) r.monthlyRateDebitedFor = data.monthlyRateDebitedFor
        return r
      },
    },
  },
}))

mock.module('../services/billing.service', () => ({
  consumeUsage: async (args: any) => {
    consumeCalls.push(args)
    return { success: true, remainingUsd: 99 }
  },
}))

// voice-cost is NOT mocked: we rely on the real `resolveVoiceRate`
// returning VOICE_RAW_USD.numberMonthly ($3). `resolvePlanIdForWorkspace`
// resolves against prisma.subscription which is unmocked here; it will
// fail-safe back to 'free' (the try/catch around the query catches the
// missing model). That's the real production behavior on a fresh ws.

// Must import AFTER mocking
import { runVoiceMonthlyRebill } from '../jobs/voice-monthly-rebill'

describe('runVoiceMonthlyRebill', () => {
  beforeEach(() => {
    rows = []
    consumeCalls = []
    updatedWatermarks = []
  })

  test('debits each active number exactly once per period with raw+billed USD', async () => {
    const now = new Date('2026-05-15T12:00:00Z')
    rows = [
      {
        projectId: 'p1',
        workspaceId: 'w1',
        twilioPhoneSid: 'PN1',
        twilioPhoneNumber: '+14155550001',
        monthlyRateDebitedFor: null,
      },
      {
        projectId: 'p2',
        workspaceId: 'w2',
        twilioPhoneSid: 'PN2',
        twilioPhoneNumber: '+14155550002',
        monthlyRateDebitedFor: new Date('2026-04-01T00:00:00Z'),
      },
    ]

    const summary = await runVoiceMonthlyRebill({ now })
    expect(summary.debited).toBe(2)
    expect(summary.failed).toBe(0)
    expect(consumeCalls.length).toBe(2)

    for (const args of consumeCalls) {
      expect(args.actionType).toBe('voice_number_monthly')
      expect(args.rawUsd).toBeCloseTo(VOICE_RAW_USD.numberMonthly, 10)
      expect(args.billedUsd).toBeCloseTo(
        VOICE_RAW_USD.numberMonthly * MARKUP_MULTIPLIER,
        10,
      )
      expect(args.actionMetadata.rawUsd).toBeCloseTo(VOICE_RAW_USD.numberMonthly, 10)
      expect(args.actionMetadata.billedUsd).toBeCloseTo(
        VOICE_RAW_USD.numberMonthly * MARKUP_MULTIPLIER,
        10,
      )
    }
    expect(updatedWatermarks.length).toBe(2)
  })

  test('re-running inside the same period is a no-op', async () => {
    const now = new Date('2026-05-15T12:00:00Z')
    rows = [
      {
        projectId: 'p1',
        workspaceId: 'w1',
        twilioPhoneSid: 'PN1',
        twilioPhoneNumber: '+14155550001',
        monthlyRateDebitedFor: new Date('2026-05-01T00:00:00Z'),
      },
    ]

    const summary = await runVoiceMonthlyRebill({ now })
    expect(summary.debited).toBe(0)
    expect(summary.processed).toBe(0)
    expect(consumeCalls.length).toBe(0)
  })

  test('skips configs without a twilioPhoneSid', async () => {
    const now = new Date('2026-05-15T12:00:00Z')
    rows = [
      {
        projectId: 'p1',
        workspaceId: 'w1',
        twilioPhoneSid: null,
        twilioPhoneNumber: null,
        monthlyRateDebitedFor: null,
      },
    ]
    const summary = await runVoiceMonthlyRebill({ now })
    expect(summary.processed).toBe(0)
    expect(consumeCalls.length).toBe(0)
  })
})
