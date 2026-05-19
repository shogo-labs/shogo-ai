// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createHmac } from 'node:crypto'

interface Meter {
  id: string
  conversationId: string | null
  callSid: string | null
  projectId: string
  workspaceId: string
  direction: string
  durationSeconds: number
  billedMinutes: number
  startedAt: Date | null
  endedAt: Date | null
  usageEventId: string | null
  transcript?: any
  transcriptSummary?: string
}

const meterStore: Meter[] = []
const usageEvents: Array<{ id: string; workspaceId: string; actionType: string; actionMetadata: any; createdAt: Date }> = []

let consumeUsageImpl: (args: any) => Promise<any> = async () => ({ success: true })
let calcResult = {
  billedMinutes: 2,
  rawUsd: 0.1,
  billedUsd: 0.2,
  rawUsdPerMinute: 0.05,
  billedUsdPerMinute: 0.1,
}
let resolvePlanIdImpl: (workspaceId: string) => Promise<string> = async () => 'plan-free'

const consumeUsageCalls: any[] = []

mock.module('../../lib/prisma', () => ({
  prisma: {
    voiceCallMeter: {
      findFirst: async (args: any) => {
        const orClauses: any[] = args?.where?.OR ?? []
        if (orClauses.length === 0) return null
        for (const m of meterStore) {
          for (const clause of orClauses) {
            if (clause.conversationId && m.conversationId === clause.conversationId) return m
            if (clause.callSid && m.callSid === clause.callSid) return m
          }
        }
        return null
      },
      create: async ({ data }: any) => {
        const meter: Meter = {
          id: `meter-${meterStore.length + 1}`,
          conversationId: data.conversationId ?? null,
          callSid: data.callSid ?? null,
          projectId: data.projectId,
          workspaceId: data.workspaceId,
          direction: data.direction,
          durationSeconds: data.durationSeconds,
          billedMinutes: data.billedMinutes,
          startedAt: data.startedAt ?? null,
          endedAt: data.endedAt ?? null,
          usageEventId: null,
          transcript: data.transcript,
          transcriptSummary: data.transcriptSummary,
        }
        meterStore.push(meter)
        return meter
      },
      update: async ({ where, data }: any) => {
        const m = meterStore.find((x) => x.id === where.id)
        if (!m) throw new Error('meter not found: ' + where.id)
        Object.assign(m, data)
        return m
      },
    },
    usageEvent: {
      findFirst: async (args: any) => {
        const w = args?.where ?? {}
        const matches = usageEvents.filter(
          (e) =>
            (!w.workspaceId || e.workspaceId === w.workspaceId) &&
            (!w.actionType || e.actionType === w.actionType),
        )
        matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        return matches[0] ?? null
      },
    },
  },
}))

mock.module('../../lib/voice-cost', () => ({
  calculateVoiceMinuteCost: (_planId: string, _direction: string, _seconds: number) => ({ ...calcResult }),
  resolvePlanIdForWorkspace: (workspaceId: string) => resolvePlanIdImpl(workspaceId),
}))

mock.module('../../services/billing.service', () => ({
  consumeUsage: async (args: any) => {
    consumeUsageCalls.push(args)
    const r = await consumeUsageImpl(args)
    if (r.success) {
      usageEvents.push({
        id: `ue-${usageEvents.length + 1}`,
        workspaceId: args.workspaceId,
        actionType: args.actionType,
        actionMetadata: args.actionMetadata,
        createdAt: new Date(),
      })
    }
    return r
  },
}))

mock.module('../../lib/crypto-util', () => ({
  safeBufferEqual: (a: Buffer, b: Buffer) => a.length === b.length && a.toString() === b.toString(),
}))

const { recordCallUsage, verifyElevenLabsSignature } = await import('../voice-meter')

beforeEach(() => {
  meterStore.length = 0
  usageEvents.length = 0
  consumeUsageCalls.length = 0
  consumeUsageImpl = async () => ({ success: true })
  calcResult = {
    billedMinutes: 2,
    rawUsd: 0.1,
    billedUsd: 0.2,
    rawUsdPerMinute: 0.05,
    billedUsdPerMinute: 0.1,
  }
  resolvePlanIdImpl = async () => 'plan-free'
})

afterEach(() => {})

describe('recordCallUsage — validation', () => {
  it('throws when both conversationId and callSid are missing', async () => {
    let err: any
    await recordCallUsage({
      projectId: 'p',
      workspaceId: 'w',
      direction: 'inbound',
      durationSeconds: 60,
    } as any).catch((e) => (err = e))
    expect(err).toBeDefined()
    expect(String(err.message)).toContain('conversationId or callSid')
  })
})

describe('recordCallUsage — first call (create + debit)', () => {
  it('creates a meter, debits usage, links usageEventId, returns inbound action', async () => {
    const r = await recordCallUsage({
      projectId: 'p1',
      workspaceId: 'w1',
      direction: 'inbound',
      durationSeconds: 90,
      conversationId: 'conv-1',
      callSid: 'CA1',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      endedAt: new Date('2026-01-01T00:01:30Z'),
      fromNumber: '+1',
      toNumber: '+2',
      agentId: 'agent-x',
      transcript: [{ role: 'user', message: 'hi' }],
      transcriptSummary: 'a greeting',
    })
    expect(r.alreadyBilled).toBe(false)
    expect(r.usageEventRecorded).toBe(true)
    expect(r.actionType).toBe('voice_minutes_inbound')
    expect(r.billedMinutes).toBe(2)
    expect(r.billedUsd).toBe(0.2)
    expect(meterStore).toHaveLength(1)
    expect(meterStore[0].usageEventId).toBe('ue-1')
    expect(consumeUsageCalls).toHaveLength(1)
    expect(consumeUsageCalls[0].memberId).toBe('voice-webhook')
    expect(consumeUsageCalls[0].actionType).toBe('voice_minutes_inbound')
  })

  it('uses outbound action type when direction=outbound', async () => {
    const r = await recordCallUsage({
      projectId: 'p',
      workspaceId: 'w',
      direction: 'outbound',
      durationSeconds: 30,
      callSid: 'CAo',
    })
    expect(r.actionType).toBe('voice_minutes_outbound')
    expect(consumeUsageCalls[0].actionType).toBe('voice_minutes_outbound')
  })

  it('honors caller-provided memberId', async () => {
    await recordCallUsage({
      projectId: 'p',
      workspaceId: 'w',
      direction: 'inbound',
      durationSeconds: 30,
      conversationId: 'cv',
      memberId: 'm-real',
    })
    expect(consumeUsageCalls[0].memberId).toBe('m-real')
  })
})

describe('recordCallUsage — second call (dedupe)', () => {
  it('returns alreadyBilled:true when meter has usageEventId', async () => {
    await recordCallUsage({
      projectId: 'p',
      workspaceId: 'w',
      direction: 'inbound',
      durationSeconds: 60,
      conversationId: 'conv-dup',
    })
    consumeUsageCalls.length = 0
    const r2 = await recordCallUsage({
      projectId: 'p',
      workspaceId: 'w',
      direction: 'inbound',
      durationSeconds: 60,
      conversationId: 'conv-dup',
    })
    expect(r2.alreadyBilled).toBe(true)
    expect(r2.usageEventRecorded).toBe(false)
    expect(consumeUsageCalls).toHaveLength(0)
  })

  it('backfills callSid on existing meter that had only conversationId', async () => {
    await recordCallUsage({
      projectId: 'p',
      workspaceId: 'w',
      direction: 'inbound',
      durationSeconds: 60,
      conversationId: 'c1',
    })
    await recordCallUsage({
      projectId: 'p',
      workspaceId: 'w',
      direction: 'inbound',
      durationSeconds: 60,
      conversationId: 'c1',
      callSid: 'CA-back',
    })
    expect(meterStore[0].callSid).toBe('CA-back')
  })

  it('backfills conversationId on existing meter that had only callSid', async () => {
    await recordCallUsage({
      projectId: 'p',
      workspaceId: 'w',
      direction: 'inbound',
      durationSeconds: 60,
      callSid: 'CA-only',
    })
    await recordCallUsage({
      projectId: 'p',
      workspaceId: 'w',
      direction: 'inbound',
      durationSeconds: 60,
      callSid: 'CA-only',
      conversationId: 'c-back',
    })
    expect(meterStore[0].conversationId).toBe('c-back')
  })

  it('keeps the larger durationSeconds across webhooks', async () => {
    await recordCallUsage({
      projectId: 'p', workspaceId: 'w', direction: 'inbound',
      durationSeconds: 30, conversationId: 'cv',
    })
    await recordCallUsage({
      projectId: 'p', workspaceId: 'w', direction: 'inbound',
      durationSeconds: 120, conversationId: 'cv',
    })
    expect(meterStore[0].durationSeconds).toBe(120)
  })

  it('allows transcript backfill on already-billed meter without re-debiting', async () => {
    await recordCallUsage({
      projectId: 'p', workspaceId: 'w', direction: 'inbound',
      durationSeconds: 60, conversationId: 'cv',
    })
    consumeUsageCalls.length = 0
    const r2 = await recordCallUsage({
      projectId: 'p', workspaceId: 'w', direction: 'inbound',
      durationSeconds: 60, conversationId: 'cv',
      transcript: [{ role: 'agent', message: 'hi' }],
      transcriptSummary: 'late summary',
    })
    expect(r2.alreadyBilled).toBe(true)
    expect(consumeUsageCalls).toHaveLength(0)
    expect(meterStore[0].transcript).toEqual([{ role: 'agent', message: 'hi' }])
    expect(meterStore[0].transcriptSummary).toBe('late summary')
  })

  it('updates endedAt on later webhook and fills startedAt only if missing', async () => {
    const t1 = new Date('2026-01-01T00:00:00Z')
    const t2 = new Date('2026-01-01T00:05:00Z')
    const t3 = new Date('2026-01-01T00:07:00Z')
    await recordCallUsage({
      projectId: 'p', workspaceId: 'w', direction: 'inbound',
      durationSeconds: 60, conversationId: 'cv',
      startedAt: t1,
    })
    await recordCallUsage({
      projectId: 'p', workspaceId: 'w', direction: 'inbound',
      durationSeconds: 60, conversationId: 'cv',
      startedAt: t2,
      endedAt: t3,
    })
    expect(meterStore[0].startedAt?.toISOString()).toBe(t1.toISOString())
    expect(meterStore[0].endedAt?.toISOString()).toBe(t3.toISOString())
  })
})

describe('recordCallUsage — debit failure path', () => {
  it('returns usageEventRecorded:false and leaves usageEventId null when consumeUsage fails', async () => {
    consumeUsageImpl = async () => ({ success: false, reason: 'insufficient' })
    const r = await recordCallUsage({
      projectId: 'p', workspaceId: 'w', direction: 'inbound',
      durationSeconds: 60, conversationId: 'cv',
    })
    expect(r.usageEventRecorded).toBe(false)
    expect(r.alreadyBilled).toBe(false)
    expect(meterStore[0].usageEventId).toBeNull()
  })
})

describe('verifyElevenLabsSignature', () => {
  const secret = 'super-secret'
  function makeHeader(rawBody: string, ts: number) {
    const sig = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')
    return `t=${ts},v0=${sig}`
  }

  it('returns false when header is null', () => {
    expect(verifyElevenLabsSignature({ secret, signatureHeader: null, rawBody: '{}' })).toBe(false)
  })
  it('returns false when t= is missing', () => {
    expect(
      verifyElevenLabsSignature({ secret, signatureHeader: 'v0=abc', rawBody: '{}' }),
    ).toBe(false)
  })
  it('returns false when v0= is missing', () => {
    expect(
      verifyElevenLabsSignature({ secret, signatureHeader: 't=123', rawBody: '{}' }),
    ).toBe(false)
  })
  it('returns false when t is non-numeric', () => {
    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: 't=oops,v0=deadbeef',
        rawBody: '{}',
      }),
    ).toBe(false)
  })
  it('returns false when timestamp exceeds skew', () => {
    const now = 2_000_000
    const old = now - 1000
    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: makeHeader('{}', old),
        rawBody: '{}',
        nowSeconds: now,
        maxSkewSeconds: 300,
      }),
    ).toBe(false)
  })
  it('returns true on a valid signature within skew', () => {
    const now = 2_000_000
    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: makeHeader('{"a":1}', now),
        rawBody: '{"a":1}',
        nowSeconds: now,
      }),
    ).toBe(true)
  })
  it('uses Date.now() default when nowSeconds is omitted', () => {
    const live = Math.floor(Date.now() / 1000)
    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: makeHeader('hi', live),
        rawBody: 'hi',
      }),
    ).toBe(true)
  })
  it('returns false on a tampered body', () => {
    const now = 2_000_000
    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: makeHeader('original', now),
        rawBody: 'mutated',
        nowSeconds: now,
      }),
    ).toBe(false)
  })
  it('respects custom maxSkewSeconds', () => {
    const now = 2_000_000
    const old = now - 100
    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: makeHeader('x', old),
        rawBody: 'x',
        nowSeconds: now,
        maxSkewSeconds: 10,
      }),
    ).toBe(false)
  })
})
