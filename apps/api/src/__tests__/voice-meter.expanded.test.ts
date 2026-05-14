// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { withPrismaExports } from './helpers/prisma-mock-exports'

const meterRows = new Map<string, any>()
const updates: any[] = []
const consumeUsage = mock(async () => ({ success: true }))

mock.module('../services/billing.service', () => ({
  consumeUsage,
}))

mock.module('../lib/voice-cost', () => ({
  resolvePlanIdForWorkspace: async () => 'pro',
  calculateVoiceMinuteCost: (_planId: string, direction: string, seconds: number) => ({
    billedMinutes: Math.ceil(seconds / 60),
    rawUsd: direction === 'inbound' ? 0.02 : 0.04,
    billedUsd: direction === 'inbound' ? 0.03 : 0.05,
    rawUsdPerMinute: 0.01,
    billedUsdPerMinute: 0.02,
  }),
}))

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    voiceCallMeter: {
      findFirst: mock(async ({ where }: any) => {
        const ids = where.OR.map((clause: any) => clause.conversationId ?? clause.callSid)
        return [...meterRows.values()].find((row) =>
          ids.includes(row.conversationId) || ids.includes(row.callSid)
        ) ?? null
      }),
      create: mock(async ({ data }: any) => {
        const row = { id: `meter-${meterRows.size + 1}`, usageEventId: null, ...data }
        meterRows.set(row.id, row)
        return row
      }),
      update: mock(async ({ where, data }: any) => {
        updates.push({ where, data })
        const row = meterRows.get(where.id)
        if (row) Object.assign(row, data)
        return row
      }),
    },
    usageEvent: {
      findFirst: mock(async () => ({ id: 'usage-1', actionMetadata: {} })),
    },
  },
}))

let recordCallUsage: typeof import('../lib/voice-meter').recordCallUsage
let verifyElevenLabsSignature: typeof import('../lib/voice-meter').verifyElevenLabsSignature

beforeEach(async () => {
  meterRows.clear()
  updates.length = 0
  consumeUsage.mockClear()
  const mod = await import('../lib/voice-meter')
  recordCallUsage = mod.recordCallUsage
  verifyElevenLabsSignature = mod.verifyElevenLabsSignature
})

afterEach(() => {
  meterRows.clear()
})

describe('recordCallUsage', () => {
  test('requires at least one provider call id', async () => {
    await expect(recordCallUsage({
      projectId: 'p1',
      workspaceId: 'w1',
      direction: 'inbound',
      durationSeconds: 30,
    })).rejects.toThrow(/conversationId or callSid/)
  })

  test('creates a meter, debits usage, and links the latest usage event', async () => {
    const result = await recordCallUsage({
      projectId: 'p1',
      workspaceId: 'w1',
      direction: 'outbound',
      durationSeconds: 61,
      conversationId: 'conv-1',
      callSid: 'call-1',
      memberId: 'member-1',
      transcript: [{ role: 'user', message: 'hello' }],
      transcriptSummary: 'summary',
    })

    expect(result).toMatchObject({
      meterId: 'meter-1',
      usageEventRecorded: true,
      alreadyBilled: false,
      billedMinutes: 2,
      actionType: 'voice_minutes_outbound',
    })
    expect(consumeUsage).toHaveBeenCalledTimes(1)
    expect(consumeUsage.mock.calls[0][0]).toMatchObject({
      workspaceId: 'w1',
      projectId: 'p1',
      memberId: 'member-1',
      actionType: 'voice_minutes_outbound',
    })
    expect(updates.at(-1)).toEqual({
      where: { id: 'meter-1' },
      data: { usageEventId: 'usage-1' },
    })
  })

  test('backfills missing ids and transcript without double billing an existing meter', async () => {
    meterRows.set('existing', {
      id: 'existing',
      projectId: 'p1',
      workspaceId: 'w1',
      conversationId: null,
      callSid: 'call-1',
      durationSeconds: 10,
      billedMinutes: 1,
      startedAt: null,
      usageEventId: 'usage-old',
    })

    const result = await recordCallUsage({
      projectId: 'p1',
      workspaceId: 'w1',
      direction: 'inbound',
      durationSeconds: 90,
      conversationId: 'conv-late',
      callSid: 'call-1',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      endedAt: new Date('2026-01-01T00:03:00Z'),
      transcriptSummary: 'late summary',
    })

    expect(result).toMatchObject({
      meterId: 'existing',
      usageEventRecorded: false,
      alreadyBilled: true,
      actionType: 'voice_minutes_inbound',
    })
    expect(consumeUsage).not.toHaveBeenCalled()
    expect(updates[0].data).toMatchObject({
      conversationId: 'conv-late',
      durationSeconds: 90,
      billedMinutes: 1,
      transcriptSummary: 'late summary',
    })
  })

  test('leaves usageEventId unset when billing declines the debit', async () => {
    consumeUsage.mockImplementationOnce(async () => ({ success: false }) as any)

    const result = await recordCallUsage({
      projectId: 'p1',
      workspaceId: 'w1',
      direction: 'inbound',
      durationSeconds: 12,
      callSid: 'call-failed',
    })

    expect(result).toMatchObject({
      usageEventRecorded: false,
      alreadyBilled: false,
    })
    expect(updates.some((u) => u.data.usageEventId)).toBe(false)
  })
})

describe('verifyElevenLabsSignature', () => {
  function sign(secret: string, timestamp: number, body: string) {
    const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
    return `t=${timestamp},v0=${digest}`
  }

  test('accepts a valid signature', () => {
    expect(verifyElevenLabsSignature({
      secret: 'secret',
      rawBody: '{"ok":true}',
      signatureHeader: sign('secret', 1000, '{"ok":true}'),
      nowSeconds: 1001,
    })).toBe(true)
  })

  test('rejects missing, malformed, stale, and mismatched signatures', () => {
    expect(verifyElevenLabsSignature({
      secret: 'secret',
      rawBody: '{}',
      signatureHeader: null,
      nowSeconds: 1000,
    })).toBe(false)
    expect(verifyElevenLabsSignature({
      secret: 'secret',
      rawBody: '{}',
      signatureHeader: 't=nope,v0=abc',
      nowSeconds: 1000,
    })).toBe(false)
    expect(verifyElevenLabsSignature({
      secret: 'secret',
      rawBody: '{}',
      signatureHeader: sign('secret', 1, '{}'),
      nowSeconds: 1000,
    })).toBe(false)
    expect(verifyElevenLabsSignature({
      secret: 'secret',
      rawBody: '{"tampered":true}',
      signatureHeader: sign('secret', 1000, '{}'),
      nowSeconds: 1000,
    })).toBe(false)
  })
})
