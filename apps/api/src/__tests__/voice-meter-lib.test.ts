// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for `src/lib/voice-meter.ts`.
 *
 * Covers both exported functions:
 *   - recordCallUsage(): upsert + idempotent debit. Branches:
 *       - missing both ids → throws
 *       - direction → actionType mapping (inbound/outbound)
 *       - new-row create path + transcript inclusion
 *       - existing-row update path (id backfill, durationSeconds max,
 *         startedAt only if not present, endedAt always overwrites,
 *         transcript patch even for already-billed rows)
 *       - alreadyBilled → no debit, returns alreadyBilled:true
 *       - debit failure → usageEventRecorded:false
 *       - happy path → links usageEventId, swallows link-race errors
 *       - memberId default to 'voice-webhook'
 *   - verifyElevenLabsSignature(): valid sig, missing pieces, skew,
 *     malformed signature header
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHmac } from 'node:crypto'

// ─── voice-cost mock ──────────────────────────────────────────────────

const voiceCostSpies = {
  resolvePlanIdForWorkspace: mock(async (_w: string) => 'plan-pro'),
  calculateVoiceMinuteCost: mock((_p: any, _d: any, durationSeconds: number) => ({
    billedMinutes: Math.ceil(durationSeconds / 60),
    rawUsd: 0.10,
    billedUsd: 0.12,
    rawUsdPerMinute: 0.10,
    billedUsdPerMinute: 0.12,
  })),
}
mock.module('../lib/voice-cost', () => voiceCostSpies)

// ─── billing.service mock ─────────────────────────────────────────────

const billingSpies = {
  consumeUsage: mock(async (_args: any) => ({ success: true })),
}
mock.module('../services/billing.service', () => billingSpies)

// ─── Prisma mock ──────────────────────────────────────────────────────

interface MeterRow {
  id: string
  projectId: string
  workspaceId: string
  conversationId: string | null
  callSid: string | null
  direction: string
  durationSeconds: number
  billedMinutes: number
  startedAt: Date | null
  endedAt: Date | null
  usageEventId: string | null
  transcript: unknown
  transcriptSummary: string | null
}

let meters: Map<string, MeterRow>
let usageEvents: Array<{ id: string; workspaceId: string; actionType: string; createdAt: Date; actionMetadata: any }>
let updateThrowOnLink = false
let nextMeterId = 1
let nextEventId = 1

function makeMeter(partial: Partial<MeterRow>): MeterRow {
  return {
    id: `mtr_${nextMeterId++}`,
    projectId: 'p1',
    workspaceId: 'w1',
    conversationId: null,
    callSid: null,
    direction: 'inbound',
    durationSeconds: 0,
    billedMinutes: 0,
    startedAt: null,
    endedAt: null,
    usageEventId: null,
    transcript: null,
    transcriptSummary: null,
    ...partial,
  }
}

const prismaMock = {
  voiceCallMeter: {
    findFirst: async ({ where }: any) => {
      const orArr: any[] = where?.OR ?? []
      for (const m of meters.values()) {
        for (const cond of orArr) {
          if (cond.conversationId && cond.conversationId === m.conversationId) return m
          if (cond.callSid && cond.callSid === m.callSid) return m
        }
      }
      return null
    },
    create: async ({ data }: any) => {
      const row = makeMeter({ ...data, id: `mtr_${nextMeterId++}` })
      meters.set(row.id, row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = meters.get(where.id)
      if (!row) throw new Error('not found')
      if (data.usageEventId !== undefined && updateThrowOnLink) {
        throw new Error('race')
      }
      Object.assign(row, data)
      return row
    },
  },
  usageEvent: {
    findFirst: async ({ where, orderBy }: any) => {
      let rows = usageEvents.filter(
        (e) => e.workspaceId === where.workspaceId && e.actionType === where.actionType,
      )
      if (orderBy?.createdAt === 'desc') {
        rows = rows.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      }
      return rows[0] ?? null
    },
  },
}

mock.module('../lib/prisma', () => ({ prisma: prismaMock }))

// ─── Reset between tests ──────────────────────────────────────────────

beforeEach(() => {
  meters = new Map()
  usageEvents = []
  updateThrowOnLink = false
  nextMeterId = 1
  nextEventId = 1
  voiceCostSpies.resolvePlanIdForWorkspace.mockClear()
  voiceCostSpies.calculateVoiceMinuteCost.mockClear()
  billingSpies.consumeUsage.mockClear()
  voiceCostSpies.resolvePlanIdForWorkspace.mockImplementation(async () => 'plan-pro')
  voiceCostSpies.calculateVoiceMinuteCost.mockImplementation((_p, _d, s) => ({
    billedMinutes: Math.ceil(s / 60),
    rawUsd: 0.10,
    billedUsd: 0.12,
    rawUsdPerMinute: 0.10,
    billedUsdPerMinute: 0.12,
  }))
  billingSpies.consumeUsage.mockImplementation(async () => ({ success: true }))
})

// Import AFTER mocks are wired
const { recordCallUsage, verifyElevenLabsSignature } = await import('../lib/voice-meter')

// Helper: simulate consumeUsage having inserted a usage event
function seedUsageEvent(workspaceId: string, actionType: string, meta: any = {}) {
  usageEvents.push({
    id: `ue_${nextEventId++}`,
    workspaceId,
    actionType,
    createdAt: new Date(),
    actionMetadata: meta,
  })
}

// ═══════════════════════════════════════════════════════════════════════
// recordCallUsage()
// ═══════════════════════════════════════════════════════════════════════

describe('recordCallUsage()', () => {
  test('throws when both conversationId and callSid are missing', async () => {
    await expect(
      recordCallUsage({
        projectId: 'p1',
        workspaceId: 'w1',
        direction: 'inbound',
        durationSeconds: 60,
      }),
    ).rejects.toThrow(/conversationId or callSid is required/)
  })

  test('inbound direction maps to voice_minutes_inbound', async () => {
    billingSpies.consumeUsage.mockImplementation(async (args: any) => {
      seedUsageEvent(args.workspaceId, args.actionType)
      return { success: true }
    })
    const res = await recordCallUsage({
      projectId: 'p1', workspaceId: 'w1', direction: 'inbound',
      durationSeconds: 90, conversationId: 'conv_1',
    })
    expect(res.actionType).toBe('voice_minutes_inbound')
    expect(billingSpies.consumeUsage.mock.calls[0][0].actionType).toBe('voice_minutes_inbound')
  })

  test('outbound direction maps to voice_minutes_outbound', async () => {
    billingSpies.consumeUsage.mockImplementation(async (args: any) => {
      seedUsageEvent(args.workspaceId, args.actionType)
      return { success: true }
    })
    const res = await recordCallUsage({
      projectId: 'p1', workspaceId: 'w1', direction: 'outbound',
      durationSeconds: 30, callSid: 'CA_1',
    })
    expect(res.actionType).toBe('voice_minutes_outbound')
  })

  test('happy path: new meter, debit success, links usageEventId', async () => {
    billingSpies.consumeUsage.mockImplementation(async (args: any) => {
      seedUsageEvent(args.workspaceId, args.actionType)
      return { success: true }
    })
    const res = await recordCallUsage({
      projectId: 'p1', workspaceId: 'w1', direction: 'inbound',
      durationSeconds: 120, conversationId: 'conv_2',
      transcript: [{ role: 'user', message: 'hi' }],
      transcriptSummary: 'Greeting',
    })
    expect(res.usageEventRecorded).toBe(true)
    expect(res.alreadyBilled).toBe(false)
    expect(res.billedMinutes).toBe(2)
    const stored = meters.get(res.meterId)!
    expect(stored.usageEventId).toMatch(/^ue_/)
    expect(stored.transcript).toEqual([{ role: 'user', message: 'hi' }])
    expect(stored.transcriptSummary).toBe('Greeting')
    expect(stored.durationSeconds).toBe(120)
  })

  test('floors fractional durationSeconds on new-row create', async () => {
    billingSpies.consumeUsage.mockImplementation(async (args: any) => {
      seedUsageEvent(args.workspaceId, args.actionType)
      return { success: true }
    })
    const res = await recordCallUsage({
      projectId: 'p1', workspaceId: 'w1', direction: 'inbound',
      durationSeconds: 61.9, conversationId: 'conv_3',
    })
    expect(meters.get(res.meterId)!.durationSeconds).toBe(61)
  })

  test('defaults memberId to "voice-webhook" when not provided', async () => {
    billingSpies.consumeUsage.mockImplementation(async (args: any) => {
      seedUsageEvent(args.workspaceId, args.actionType)
      return { success: true }
    })
    await recordCallUsage({
      projectId: 'p1', workspaceId: 'w1', direction: 'inbound',
      durationSeconds: 30, conversationId: 'conv_4',
    })
    expect(billingSpies.consumeUsage.mock.calls[0][0].memberId).toBe('voice-webhook')
  })

  test('uses explicit memberId when provided', async () => {
    billingSpies.consumeUsage.mockImplementation(async (args: any) => {
      seedUsageEvent(args.workspaceId, args.actionType)
      return { success: true }
    })
    await recordCallUsage({
      projectId: 'p1', workspaceId: 'w1', direction: 'inbound',
      durationSeconds: 30, conversationId: 'conv_5', memberId: 'mem_42',
    })
    expect(billingSpies.consumeUsage.mock.calls[0][0].memberId).toBe('mem_42')
  })

  test('debit failure → usageEventRecorded false, alreadyBilled false', async () => {
    billingSpies.consumeUsage.mockImplementation(async () => ({ success: false }))
    const res = await recordCallUsage({
      projectId: 'p1', workspaceId: 'w1', direction: 'inbound',
      durationSeconds: 60, conversationId: 'conv_fail',
    })
    expect(res.usageEventRecorded).toBe(false)
    expect(res.alreadyBilled).toBe(false)
    expect(meters.get(res.meterId)!.usageEventId).toBe(null)
  })

  test('idempotent: existing row with usageEventId set → no debit, alreadyBilled=true', async () => {
    const existing = makeMeter({
      conversationId: 'conv_dup',
      direction: 'inbound',
      durationSeconds: 100,
      billedMinutes: 2,
      usageEventId: 'ue_prev',
    })
    meters.set(existing.id, existing)

    const res = await recordCallUsage({
      projectId: 'p1', workspaceId: 'w1', direction: 'inbound',
      durationSeconds: 100, conversationId: 'conv_dup',
    })
    expect(res.alreadyBilled).toBe(true)
    expect(res.usageEventRecorded).toBe(false)
    expect(billingSpies.consumeUsage).not.toHaveBeenCalled()
  })

  test('existing row: backfills callSid when first webhook had only conversationId', async () => {
    const existing = makeMeter({ conversationId: 'conv_x', callSid: null })
    meters.set(existing.id, existing)

    billingSpies.consumeUsage.mockImplementation(async (args: any) => {
      seedUsageEvent(args.workspaceId, args.actionType)
      return { success: true }
    })
    await recordCallUsage({
      projectId: 'p1', workspaceId: 'w1', direction: 'inbound',
      durationSeconds: 60, conversationId: 'conv_x', callSid: 'CA_x',
    })
    expect(meters.get(existing.id)!.callSid).toBe('CA_x')
  })

  test('existing row: does NOT overwrite callSid when both webhooks carry one', async () => {
    const existing = makeMeter({ conversationId: 'conv_y', callSid: 'CA_orig' })
    meters.set(existing.id, existing)

    billingSpies.consumeUsage.mockImplementation(async (args: any) => {
      seedUsageEvent(args.workspaceId, args.actionType)
      return { success: true }
    })
    await recordCallUsage({
      projectId: 'p1', workspaceId: 'w1', direction: 'inbound',
      durationSeconds: 60, conversationId: 'conv_y', callSid: 'CA_other',
    })
    expect(meters.get(existing.id)!.callSid).toBe('CA_orig')
  })

  test('existing row: durationSeconds takes the max of stored vs incoming', async () => {
    const existing = makeMeter({ conversationId: 'conv_max', durationSeconds: 200 })
    meters.set(existing.id, existing)

    billingSpies.consumeUsage.mockImplementation(async (args: any) => {
      seedUsageEvent(args.workspaceId, args.actionType)
      return { success: true }
    })
    await recordCallUsage({
      projectId: 'p1', workspaceId: 'w1', direction: 'inbound',
      durationSeconds: 50, conversationId: 'conv_max',
    })
    expect(meters.get(existing.id)!.durationSeconds).toBe(200)
  })

  test('existing row: startedAt only set when not already present', async () => {
    const original = new Date('2026-01-01T00:00:00Z')
    const existing = makeMeter({ conversationId: 'conv_st', startedAt: original })
    meters.set(existing.id, existing)
    billingSpies.consumeUsage.mockImplementation(async (args: any) => {
      seedUsageEvent(args.workspaceId, args.actionType)
      return { success: true }
    })
    await recordCallUsage({
      projectId: 'p1', workspaceId: 'w1', direction: 'inbound',
      durationSeconds: 60, conversationId: 'conv_st',
      startedAt: new Date('2026-01-02T00:00:00Z'),
    })
    expect(meters.get(existing.id)!.startedAt).toEqual(original)
  })

  test('existing row: endedAt is overwritten whenever provided', async () => {
    const original = new Date('2026-01-01T00:00:00Z')
    const next = new Date('2026-01-02T00:00:00Z')
    const existing = makeMeter({ conversationId: 'conv_end', endedAt: original })
    meters.set(existing.id, existing)
    billingSpies.consumeUsage.mockImplementation(async (args: any) => {
      seedUsageEvent(args.workspaceId, args.actionType)
      return { success: true }
    })
    await recordCallUsage({
      projectId: 'p1', workspaceId: 'w1', direction: 'inbound',
      durationSeconds: 60, conversationId: 'conv_end', endedAt: next,
    })
    expect(meters.get(existing.id)!.endedAt).toEqual(next)
  })

  test('transcript patch applies even for already-billed rows (no debit)', async () => {
    const existing = makeMeter({
      conversationId: 'conv_tr',
      usageEventId: 'ue_prev',
      transcript: null,
    })
    meters.set(existing.id, existing)
    const res = await recordCallUsage({
      projectId: 'p1', workspaceId: 'w1', direction: 'inbound',
      durationSeconds: 60, conversationId: 'conv_tr',
      transcript: [{ role: 'agent', message: 'late arrival' }],
      transcriptSummary: 'after the fact',
    })
    expect(res.alreadyBilled).toBe(true)
    expect(meters.get(existing.id)!.transcript).toEqual([
      { role: 'agent', message: 'late arrival' },
    ])
    expect(meters.get(existing.id)!.transcriptSummary).toBe('after the fact')
    expect(billingSpies.consumeUsage).not.toHaveBeenCalled()
  })

  test('linking usageEventId swallows race errors (does not throw)', async () => {
    billingSpies.consumeUsage.mockImplementation(async (args: any) => {
      seedUsageEvent(args.workspaceId, args.actionType)
      return { success: true }
    })
    updateThrowOnLink = true
    const res = await recordCallUsage({
      projectId: 'p1', workspaceId: 'w1', direction: 'inbound',
      durationSeconds: 60, conversationId: 'conv_race',
    })
    expect(res.usageEventRecorded).toBe(true)
    expect(meters.get(res.meterId)!.usageEventId).toBe(null)
  })

  test('happy path with no usageEvent found in DB → skips linking but reports success', async () => {
    billingSpies.consumeUsage.mockImplementation(async () => ({ success: true }))
    const res = await recordCallUsage({
      projectId: 'p1', workspaceId: 'w1', direction: 'inbound',
      durationSeconds: 60, conversationId: 'conv_nolink',
    })
    expect(res.usageEventRecorded).toBe(true)
    expect(meters.get(res.meterId)!.usageEventId).toBe(null)
  })

  test('passes provider numbers and metadata into consumeUsage actionMetadata', async () => {
    billingSpies.consumeUsage.mockImplementation(async (args: any) => {
      seedUsageEvent(args.workspaceId, args.actionType)
      return { success: true }
    })
    await recordCallUsage({
      projectId: 'p1', workspaceId: 'w1', direction: 'inbound',
      durationSeconds: 60, conversationId: 'conv_meta', callSid: 'CA_meta',
      fromNumber: '+15551234567', toNumber: '+15557654321', agentId: 'agent_1',
    })
    const meta = billingSpies.consumeUsage.mock.calls[0][0].actionMetadata
    expect(meta.fromNumber).toBe('+15551234567')
    expect(meta.toNumber).toBe('+15557654321')
    expect(meta.agentId).toBe('agent_1')
    expect(meta.conversationId).toBe('conv_meta')
    expect(meta.callSid).toBe('CA_meta')
    expect(meta.direction).toBe('inbound')
  })

  test('only conversationId provided: matches existing row by conversationId only', async () => {
    const existing = makeMeter({ conversationId: 'conv_only', callSid: null })
    meters.set(existing.id, existing)
    billingSpies.consumeUsage.mockImplementation(async (args: any) => {
      seedUsageEvent(args.workspaceId, args.actionType)
      return { success: true }
    })
    const res = await recordCallUsage({
      projectId: 'p1', workspaceId: 'w1', direction: 'inbound',
      durationSeconds: 60, conversationId: 'conv_only',
    })
    expect(res.meterId).toBe(existing.id)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// verifyElevenLabsSignature()
// ═══════════════════════════════════════════════════════════════════════

describe('verifyElevenLabsSignature()', () => {
  const SECRET = 'wsec_test_abc123'
  const NOW = 1_700_000_000

  function signed(body: string, ts: number = NOW, secret = SECRET) {
    const expected = createHmac('sha256', secret)
      .update(`${ts}.${body}`)
      .digest('hex')
    return `t=${ts},v0=${expected}`
  }

  test('returns true for a valid signature', () => {
    const body = '{"event":"post_call_transcription"}'
    expect(
      verifyElevenLabsSignature({
        secret: SECRET,
        signatureHeader: signed(body),
        rawBody: body,
        nowSeconds: NOW,
      }),
    ).toBe(true)
  })

  test('returns false when header is null', () => {
    expect(
      verifyElevenLabsSignature({
        secret: SECRET, signatureHeader: null, rawBody: '{}', nowSeconds: NOW,
      }),
    ).toBe(false)
  })

  test('returns false when signature is wrong', () => {
    const body = '{"a":1}'
    expect(
      verifyElevenLabsSignature({
        secret: SECRET,
        signatureHeader: `t=${NOW},v0=` + 'f'.repeat(64),
        rawBody: body,
        nowSeconds: NOW,
      }),
    ).toBe(false)
  })

  test('returns false when timestamp missing', () => {
    expect(
      verifyElevenLabsSignature({
        secret: SECRET,
        signatureHeader: 'v0=deadbeef',
        rawBody: '{}',
        nowSeconds: NOW,
      }),
    ).toBe(false)
  })

  test('returns false when v0 missing', () => {
    expect(
      verifyElevenLabsSignature({
        secret: SECRET,
        signatureHeader: `t=${NOW}`,
        rawBody: '{}',
        nowSeconds: NOW,
      }),
    ).toBe(false)
  })

  test('returns false when timestamp is not a number', () => {
    expect(
      verifyElevenLabsSignature({
        secret: SECRET,
        signatureHeader: 't=NOT_A_NUMBER,v0=' + 'a'.repeat(64),
        rawBody: '{}',
        nowSeconds: NOW,
      }),
    ).toBe(false)
  })

  test('returns false when timestamp exceeds default 5-min skew', () => {
    const body = '{}'
    const stale = NOW - 600 // 10 min old
    expect(
      verifyElevenLabsSignature({
        secret: SECRET,
        signatureHeader: signed(body, stale),
        rawBody: body,
        nowSeconds: NOW,
      }),
    ).toBe(false)
  })

  test('accepts when timestamp within custom skew window', () => {
    const body = '{}'
    const old = NOW - 600
    expect(
      verifyElevenLabsSignature({
        secret: SECRET,
        signatureHeader: signed(body, old),
        rawBody: body,
        nowSeconds: NOW,
        maxSkewSeconds: 3600,
      }),
    ).toBe(true)
  })

  test('returns false when secret is wrong (decoded sig mismatches)', () => {
    const body = '{}'
    expect(
      verifyElevenLabsSignature({
        secret: 'wsec_other',
        signatureHeader: signed(body, NOW, SECRET),
        rawBody: body,
        nowSeconds: NOW,
      }),
    ).toBe(false)
  })

  test('tolerates whitespace around comma-separated parts', () => {
    const body = '{}'
    const expected = createHmac('sha256', SECRET).update(`${NOW}.${body}`).digest('hex')
    expect(
      verifyElevenLabsSignature({
        secret: SECRET,
        signatureHeader: ` t=${NOW} , v0=${expected} `,
        rawBody: body,
        nowSeconds: NOW,
      }),
    ).toBe(true)
  })

  test('uses Date.now()/1000 when nowSeconds not provided (sanity)', () => {
    const body = '{}'
    const nowSec = Math.floor(Date.now() / 1000)
    expect(
      verifyElevenLabsSignature({
        secret: SECRET,
        signatureHeader: signed(body, nowSec),
        rawBody: body,
      }),
    ).toBe(true)
  })

  test('rejects future timestamp beyond skew', () => {
    const body = '{}'
    const future = NOW + 600
    expect(
      verifyElevenLabsSignature({
        secret: SECRET,
        signatureHeader: signed(body, future),
        rawBody: body,
        nowSeconds: NOW,
      }),
    ).toBe(false)
  })

  test('signature includes body so different body fails verification', () => {
    const body1 = '{"a":1}'
    const body2 = '{"a":2}'
    const sig = signed(body1)
    expect(
      verifyElevenLabsSignature({
        secret: SECRET, signatureHeader: sig, rawBody: body2, nowSeconds: NOW,
      }),
    ).toBe(false)
  })
})

afterAll(() => {
  mock.restore()
})
