// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit tests for src/jobs/voice-monthly-rebill.ts — wave-1.
// Covers: no configs, successful debit + watermark advance, failed debit
// leaves watermark untouched, consumeUsage throws, mixed batch, default
// `now`, and the cron scheduler (initial + interval, error swallow).

import { beforeEach, describe, expect, it, mock } from 'bun:test'

let voiceFindManyImpl: (args: any) => Promise<any[]> = async () => []
let voiceUpdateImpl: (args: any) => Promise<any> = async () => ({})
let consumeUsageImpl: (args: any) => Promise<any> = async () => ({ success: true })
let resolvePlanIdImpl: (workspaceId: string) => Promise<string> = async () => 'free'
let calcCostImpl: (planId: string, kind: string) => { rawUsd: number; billedUsd: number } = () => ({
  rawUsd: 1.15,
  billedUsd: 1.5,
})

const voiceUpdateCalls: any[] = []

mock.module('../../lib/prisma', () => ({
  prisma: {
    voiceProjectConfig: {
      findMany: (args: any) => voiceFindManyImpl(args),
      update: (args: any) => {
        voiceUpdateCalls.push(args)
        return voiceUpdateImpl(args)
      },
    },
  },
}))

mock.module('../../services/billing.service', () => ({
  consumeUsage: (args: any) => consumeUsageImpl(args),
}))

mock.module('../../lib/voice-cost', () => ({
  resolvePlanIdForWorkspace: (w: string) => resolvePlanIdImpl(w),
  calculateVoiceNumberCost: (planId: string, kind: string) => calcCostImpl(planId, kind),
}))

const { runVoiceMonthlyRebill, startVoiceMonthlyRebillCron } = await import(
  '../voice-monthly-rebill'
)

beforeEach(() => {
  voiceFindManyImpl = async () => []
  voiceUpdateImpl = async () => ({})
  consumeUsageImpl = async () => ({ success: true })
  resolvePlanIdImpl = async () => 'free'
  calcCostImpl = () => ({ rawUsd: 1.15, billedUsd: 1.5 })
  voiceUpdateCalls.length = 0
})

describe('runVoiceMonthlyRebill', () => {
  it('returns a zeroed summary when no configs are due', async () => {
    voiceFindManyImpl = async () => []
    const s = await runVoiceMonthlyRebill({ now: new Date('2026-05-15T12:00:00Z') })
    expect(s).toMatchObject({ processed: 0, debited: 0, skipped: 0, failed: 0 })
    expect(s.period.toISOString()).toBe('2026-05-01T00:00:00.000Z')
  })

  it('debits a config and advances its watermark on success', async () => {
    voiceFindManyImpl = async () => [
      {
        projectId: 'p1',
        workspaceId: 'w1',
        twilioPhoneSid: 'PN1',
        twilioPhoneNumber: '+15550000001',
      },
    ]
    consumeUsageImpl = async () => ({ success: true })
    const s = await runVoiceMonthlyRebill({ now: new Date('2026-05-15T00:00:00Z') })
    expect(s).toMatchObject({ processed: 1, debited: 1, skipped: 0, failed: 0 })
    expect(voiceUpdateCalls.length).toBe(1)
    expect(voiceUpdateCalls[0].where).toEqual({ projectId: 'p1' })
    expect(voiceUpdateCalls[0].data.monthlyRateDebitedFor.toISOString()).toBe(
      '2026-05-01T00:00:00.000Z',
    )
  })

  it('passes rawUsd, billedUsd, and actionMetadata to consumeUsage', async () => {
    voiceFindManyImpl = async () => [
      {
        projectId: 'pX',
        workspaceId: 'wX',
        twilioPhoneSid: 'PNX',
        twilioPhoneNumber: '+15559999999',
      },
    ]
    calcCostImpl = () => ({ rawUsd: 2.05, billedUsd: 3 })
    let captured: any = null
    consumeUsageImpl = async (args) => {
      captured = args
      return { success: true }
    }
    await runVoiceMonthlyRebill({ now: new Date('2026-05-15T00:00:00Z') })
    expect(captured).toMatchObject({
      workspaceId: 'wX',
      projectId: 'pX',
      memberId: 'voice-rebill',
      actionType: 'voice_number_monthly',
      rawUsd: 2.05,
      billedUsd: 3,
    })
    expect(captured.actionMetadata).toMatchObject({
      projectId: 'pX',
      twilioPhoneSid: 'PNX',
      twilioPhoneNumber: '+15559999999',
      rawUsd: 2.05,
      billedUsd: 3,
    })
    expect(captured.actionMetadata.periodStart).toBe('2026-05-01T00:00:00.000Z')
  })

  it('does NOT advance watermark when consumeUsage returns success:false', async () => {
    voiceFindManyImpl = async () => [
      {
        projectId: 'p-fail',
        workspaceId: 'w-fail',
        twilioPhoneSid: 'PN-F',
        twilioPhoneNumber: '+1',
      },
    ]
    consumeUsageImpl = async () => ({ success: false, error: 'insufficient_balance' })
    const s = await runVoiceMonthlyRebill({ now: new Date('2026-05-15T00:00:00Z') })
    expect(s).toMatchObject({ processed: 1, debited: 0, failed: 1 })
    expect(voiceUpdateCalls.length).toBe(0)
  })

  it('counts a failure when consumeUsage throws', async () => {
    voiceFindManyImpl = async () => [
      {
        projectId: 'p-throw',
        workspaceId: 'w-throw',
        twilioPhoneSid: 'PN-T',
        twilioPhoneNumber: '+1',
      },
    ]
    consumeUsageImpl = async () => {
      throw new Error('stripe down')
    }
    const s = await runVoiceMonthlyRebill({ now: new Date('2026-05-15T00:00:00Z') })
    expect(s.failed).toBe(1)
    expect(voiceUpdateCalls.length).toBe(0)
  })

  it('handles a mixed batch (success + soft-fail + throw)', async () => {
    voiceFindManyImpl = async () => [
      { projectId: 'ok', workspaceId: 'wA', twilioPhoneSid: 'a', twilioPhoneNumber: 'a' },
      { projectId: 'soft', workspaceId: 'wB', twilioPhoneSid: 'b', twilioPhoneNumber: 'b' },
      { projectId: 'hard', workspaceId: 'wC', twilioPhoneSid: 'c', twilioPhoneNumber: 'c' },
    ]
    consumeUsageImpl = async ({ projectId }) => {
      if (projectId === 'ok') return { success: true }
      if (projectId === 'soft') return { success: false, error: 'limit_reached' }
      throw new Error('boom')
    }
    const s = await runVoiceMonthlyRebill({ now: new Date('2026-05-15T00:00:00Z') })
    expect(s).toMatchObject({ processed: 3, debited: 1, failed: 2 })
    expect(voiceUpdateCalls.length).toBe(1)
    expect(voiceUpdateCalls[0].where.projectId).toBe('ok')
  })

  it('uses current month when options.now is not provided', async () => {
    voiceFindManyImpl = async () => []
    const s = await runVoiceMonthlyRebill()
    const now = new Date()
    const expected = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    expect(s.period.toISOString()).toBe(expected.toISOString())
  })
})

describe('startVoiceMonthlyRebillCron', () => {
  it('schedules initial and recurring runs and swallows their errors', async () => {
    const origSetTimeout = globalThis.setTimeout
    const origSetInterval = globalThis.setInterval
    let timeoutCb: (() => void) | null = null
    let intervalCb: (() => void) | null = null
    ;(globalThis as any).setTimeout = (cb: () => void) => {
      timeoutCb = cb
      return 0 as any
    }
    ;(globalThis as any).setInterval = (cb: () => void) => {
      intervalCb = cb
      return 0 as any
    }
    try {
      voiceFindManyImpl = async () => {
        throw new Error('db down')
      }
      startVoiceMonthlyRebillCron(1000)
      expect(typeof timeoutCb).toBe('function')
      timeoutCb!()
      expect(typeof intervalCb).toBe('function')
      intervalCb!()
      await new Promise((r) => origSetTimeout(r, 5))
    } finally {
      ;(globalThis as any).setTimeout = origSetTimeout
      ;(globalThis as any).setInterval = origSetInterval
    }
  })
})
