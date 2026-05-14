// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * voice-meter.ts coverage.
 *
 *   bun test apps/api/src/__tests__/voice-meter.test.ts
 *
 * Covers:
 *   - verifyElevenLabsSignature: all valid/invalid branches.
 *   - recordCallUsage: argument validation, create/update paths,
 *     idempotency (already-billed row), transcript backfill, debit
 *     failure, usageEvent linkage, linkage race (caught update error),
 *     default memberId, inbound/outbound actionType.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { createHmac } from 'node:crypto'

// ---------- Prisma stub ----------
type Row = Record<string, any>

const store = {
  voiceCallMeter: [] as Row[],
  usageEvent: [] as Row[],
}

let nextMeterId = 1
let nextUsageEventId = 1

// Behavior switches set per-test.
const ctrl: {
  debit: () => Promise<any>
  linkageUpdateThrows: boolean
  latestEventOverride: 'none' | 'default'
} = {
  debit: async () => ({ success: true }),
  linkageUpdateThrows: false,
  latestEventOverride: 'default',
}

const mockPrisma: any = {
  voiceCallMeter: {
    findFirst: async ({ where }: any) => {
      const ors: any[] = where?.OR ?? []
      for (const row of store.voiceCallMeter) {
        for (const cond of ors) {
          if (
            cond.conversationId !== undefined &&
            row.conversationId === cond.conversationId
          )
            return row
          if (cond.callSid !== undefined && row.callSid === cond.callSid)
            return row
        }
      }
      return null
    },
    create: async ({ data }: any) => {
      const row: Row = { id: `meter_${nextMeterId++}`, ...data }
      store.voiceCallMeter.push(row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = store.voiceCallMeter.find((r) => r.id === where.id)
      if (!row) throw new Error('voiceCallMeter row not found')
      // Linkage step (`data.usageEventId` only) can be configured to throw,
      // simulating a race where another webhook won the unique index first.
      if (
        ctrl.linkageUpdateThrows &&
        data &&
        Object.keys(data).length === 1 &&
        'usageEventId' in data
      ) {
        throw new Error('unique constraint violation (simulated race)')
      }
      Object.assign(row, data)
      return row
    },
  },
  usageEvent: {
    findFirst: async ({ where }: any) => {
      if (ctrl.latestEventOverride === 'none') return null
      const matches = store.usageEvent
        .filter(
          (e) =>
            e.workspaceId === where.workspaceId &&
            e.actionType === where.actionType,
        )
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )
      return matches[0] ?? null
    },
  },
  subscription: {
    findFirst: async () => null, // → resolvePlanIdForWorkspace returns 'free'
  },
}

mock.module('../lib/prisma', () => ({
  prisma: mockPrisma,
  Prisma: { raw: (s: string) => s, sql: (s: string) => s, empty: '' },
}))

// ---------- billing.service stub ----------
mock.module('../services/billing.service', () => ({
  consumeUsage: async (params: any) => {
    const result = await ctrl.debit()
    if (result?.success) {
      const ev = {
        id: `ue_${nextUsageEventId++}`,
        workspaceId: params.workspaceId,
        actionType: params.actionType,
        createdAt: new Date(),
        actionMetadata: params.actionMetadata,
      }
      store.usageEvent.push(ev)
      return { success: true, remainingIncludedUsd: 100, overageChargedUsd: 0 }
    }
    return result
  },
}))

const { recordCallUsage, verifyElevenLabsSignature } = await import(
  '../lib/voice-meter'
)

beforeEach(() => {
  store.voiceCallMeter.length = 0
  store.usageEvent.length = 0
  nextMeterId = 1
  nextUsageEventId = 1
  ctrl.debit = async () => ({ success: true })
  ctrl.linkageUpdateThrows = false
  ctrl.latestEventOverride = 'default'
})

// =========================================================
// verifyElevenLabsSignature
// =========================================================

describe('verifyElevenLabsSignature', () => {
  const secret = 'whsec_test_super_secret'
  const body = '{"event":"post_call_transcription","conversation_id":"conv_1"}'
  const now = 1_700_000_000

  function sign(ts: number, b: string = body, s: string = secret) {
    return createHmac('sha256', s).update(`${ts}.${b}`).digest('hex')
  }

  test('returns false when header is missing', () => {
    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: null,
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(false)
  })

  test('accepts a valid signature', () => {
    const sig = sign(now)
    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: `t=${now},v0=${sig}`,
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(true)
  })

  test('tolerates extra whitespace and ordering of parts', () => {
    const sig = sign(now)
    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: ` v0=${sig} , t=${now} `,
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(true)
  })

  test('rejects a tampered body', () => {
    const sig = sign(now)
    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: `t=${now},v0=${sig}`,
        rawBody: body + '!',
        nowSeconds: now,
      }),
    ).toBe(false)
  })

  test('rejects a forged v0 of the right length', () => {
    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: `t=${now},v0=${'a'.repeat(64)}`,
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(false)
  })

  test('rejects a v0 of wrong length (safeBufferEqual length guard)', () => {
    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: `t=${now},v0=deadbeef`,
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(false)
  })

  test('rejects when t= is missing', () => {
    const sig = sign(now)
    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: `v0=${sig}`,
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(false)
  })

  test('rejects when v0= is missing', () => {
    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: `t=${now}`,
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(false)
  })

  test('rejects a malformed (non-numeric) timestamp', () => {
    const sig = sign(now)
    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: `t=not-a-number,v0=${sig}`,
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(false)
  })

  test('rejects a timestamp older than 5min default skew', () => {
    const stale = now - 600 // 10min old
    const sig = sign(stale)
    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: `t=${stale},v0=${sig}`,
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(false)
  })

  test('rejects a timestamp newer than skew window (clock skew forward)', () => {
    const future = now + 600
    const sig = sign(future)
    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: `t=${future},v0=${sig}`,
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(false)
  })

  test('respects custom maxSkewSeconds', () => {
    const ts = now - 30
    const sig = sign(ts)
    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: `t=${ts},v0=${sig}`,
        rawBody: body,
        nowSeconds: now,
        maxSkewSeconds: 10, // 30s > 10s window
      }),
    ).toBe(false)

    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: `t=${ts},v0=${sig}`,
        rawBody: body,
        nowSeconds: now,
        maxSkewSeconds: 60,
      }),
    ).toBe(true)
  })

  test('defaults nowSeconds to current wall clock', () => {
    const ts = Math.floor(Date.now() / 1000)
    const sig = sign(ts)
    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: `t=${ts},v0=${sig}`,
        rawBody: body,
      }),
    ).toBe(true)
  })

  test('rejects when secret does not match the signing secret', () => {
    const sig = sign(now, body, 'different-secret')
    expect(
      verifyElevenLabsSignature({
        secret,
        signatureHeader: `t=${now},v0=${sig}`,
        rawBody: body,
        nowSeconds: now,
      }),
    ).toBe(false)
  })
})

// =========================================================
// recordCallUsage
// =========================================================

describe('recordCallUsage', () => {
  const base = {
    projectId: 'proj_1',
    workspaceId: 'ws_1',
    direction: 'inbound' as const,
    durationSeconds: 90,
  }

  test('throws when neither conversationId nor callSid is provided', async () => {
    await expect(recordCallUsage({ ...base })).rejects.toThrow(
      /conversationId or callSid is required/,
    )
  })

  test('creates a new VoiceCallMeter row and debits usage (happy path)', async () => {
    const result = await recordCallUsage({
      ...base,
      conversationId: 'conv_a',
      startedAt: new Date('2026-05-14T10:00:00Z'),
      endedAt: new Date('2026-05-14T10:01:30Z'),
      fromNumber: '+15550001',
      toNumber: '+15550002',
      agentId: 'agent_x',
      transcript: [{ role: 'user', message: 'hi', time_in_call_secs: 1 }],
      transcriptSummary: 'A quick hello.',
    })

    expect(result.usageEventRecorded).toBe(true)
    expect(result.alreadyBilled).toBe(false)
    expect(result.actionType).toBe('voice_minutes_inbound')
    expect(result.billedMinutes).toBe(2) // 90s → ceil → 2 minutes
    expect(result.rawUsd).toBeGreaterThan(0)
    expect(result.billedUsd).toBeGreaterThanOrEqual(result.rawUsd)

    expect(store.voiceCallMeter).toHaveLength(1)
    const row = store.voiceCallMeter[0]
    expect(row.conversationId).toBe('conv_a')
    expect(row.durationSeconds).toBe(90)
    expect(row.transcript).toEqual([
      { role: 'user', message: 'hi', time_in_call_secs: 1 },
    ])
    expect(row.transcriptSummary).toBe('A quick hello.')
    expect(row.usageEventId).toMatch(/^ue_/) // linkage applied
    expect(store.usageEvent).toHaveLength(1)
    expect(store.usageEvent[0].actionType).toBe('voice_minutes_inbound')
    expect(store.usageEvent[0].actionMetadata.agentId).toBe('agent_x')
    expect(store.usageEvent[0].actionMetadata.direction).toBe('inbound')
  })

  test('zero-duration call still bills the minimum 1 minute', async () => {
    const result = await recordCallUsage({
      ...base,
      durationSeconds: 0,
      conversationId: 'conv_zero',
    })
    expect(result.billedMinutes).toBe(1)
    expect(result.rawUsd).toBeGreaterThan(0)
  })

  test('outbound direction maps to voice_minutes_outbound action', async () => {
    const result = await recordCallUsage({
      ...base,
      direction: 'outbound',
      conversationId: 'conv_out',
    })
    expect(result.actionType).toBe('voice_minutes_outbound')
    expect(store.usageEvent[0].actionType).toBe('voice_minutes_outbound')
  })

  test('idempotency: a second webhook for the same call does not re-bill', async () => {
    const first = await recordCallUsage({
      ...base,
      conversationId: 'conv_dup',
    })
    expect(first.usageEventRecorded).toBe(true)
    expect(store.usageEvent).toHaveLength(1)

    const second = await recordCallUsage({
      ...base,
      conversationId: 'conv_dup',
      callSid: 'CAxxx', // late Twilio webhook backfilling callSid
      durationSeconds: 100, // higher; should be kept
    })
    expect(second.alreadyBilled).toBe(true)
    expect(second.usageEventRecorded).toBe(false)

    // Still exactly one usage event total.
    expect(store.usageEvent).toHaveLength(1)
    // Backfilled callSid and kept the larger durationSeconds.
    expect(store.voiceCallMeter[0].callSid).toBe('CAxxx')
    expect(store.voiceCallMeter[0].durationSeconds).toBe(100)
  })

  test('transcript-only update on an already-billed row backfills transcript fields', async () => {
    await recordCallUsage({ ...base, conversationId: 'conv_t' })
    expect(store.voiceCallMeter[0].usageEventId).toMatch(/^ue_/)
    expect(store.usageEvent).toHaveLength(1)

    const late = await recordCallUsage({
      ...base,
      conversationId: 'conv_t',
      transcript: [{ role: 'agent', message: 'thanks' }],
      transcriptSummary: 'Closed cleanly.',
      endedAt: new Date('2026-05-14T10:05:00Z'),
    })
    expect(late.alreadyBilled).toBe(true)
    expect(late.usageEventRecorded).toBe(false)
    expect(store.voiceCallMeter[0].transcript).toEqual([
      { role: 'agent', message: 'thanks' },
    ])
    expect(store.voiceCallMeter[0].transcriptSummary).toBe('Closed cleanly.')
    expect(store.voiceCallMeter[0].endedAt).toEqual(
      new Date('2026-05-14T10:05:00Z'),
    )
    // Still exactly one usage event.
    expect(store.usageEvent).toHaveLength(1)
  })

  test('matches an existing row by callSid when only callSid is provided second', async () => {
    // First webhook: Twilio with only callSid.
    await recordCallUsage({
      ...base,
      callSid: 'CAonly1',
    })
    expect(store.voiceCallMeter).toHaveLength(1)

    // Second webhook: EL with same callSid + new conversationId.
    await recordCallUsage({
      ...base,
      callSid: 'CAonly1',
      conversationId: 'conv_late',
    })
    expect(store.voiceCallMeter).toHaveLength(1) // no second row created
    expect(store.voiceCallMeter[0].conversationId).toBe('conv_late')
  })

  test('debit failure → usageEventRecorded:false, no linkage, retryable', async () => {
    ctrl.debit = async () => ({
      success: false,
      reason: 'insufficient_balance',
    })

    const result = await recordCallUsage({
      ...base,
      conversationId: 'conv_fail',
    })
    expect(result.usageEventRecorded).toBe(false)
    expect(result.alreadyBilled).toBe(false)
    // Meter row created but with no usageEventId — reconciler can retry.
    expect(store.voiceCallMeter).toHaveLength(1)
    expect(store.voiceCallMeter[0].usageEventId).toBeUndefined()
    expect(store.usageEvent).toHaveLength(0)
  })

  test('linkage update race is swallowed (no throw to caller)', async () => {
    ctrl.linkageUpdateThrows = true
    const result = await recordCallUsage({
      ...base,
      conversationId: 'conv_race',
    })
    expect(result.usageEventRecorded).toBe(true)
    // Linkage swallowed → row has no usageEventId stamped, but the
    // public API still reports the debit as recorded.
    expect(store.voiceCallMeter[0].usageEventId).toBeUndefined()
  })

  test('no latest UsageEvent found → skips linkage cleanly', async () => {
    ctrl.latestEventOverride = 'none'
    const result = await recordCallUsage({
      ...base,
      conversationId: 'conv_nolink',
    })
    expect(result.usageEventRecorded).toBe(true)
    expect(store.voiceCallMeter[0].usageEventId).toBeUndefined()
  })

  test('default memberId is "voice-webhook" when caller omits one', async () => {
    let captured: any = null
    ctrl.debit = async () => {
      // peek at the next call's params via overriding consumeUsage indirectly
      return { success: true }
    }
    // Re-patch billing module to capture memberId.
    mock.module('../services/billing.service', () => ({
      consumeUsage: async (params: any) => {
        captured = params
        const ev = {
          id: `ue_${nextUsageEventId++}`,
          workspaceId: params.workspaceId,
          actionType: params.actionType,
          createdAt: new Date(),
          actionMetadata: params.actionMetadata,
        }
        store.usageEvent.push(ev)
        return { success: true }
      },
    }))
    const { recordCallUsage: recordFresh } = await import('../lib/voice-meter')

    await recordFresh({ ...base, conversationId: 'conv_mid' })
    expect(captured?.memberId).toBe('voice-webhook')

    await recordFresh({
      ...base,
      conversationId: 'conv_mid2',
      memberId: 'user_42',
    })
    expect(captured?.memberId).toBe('user_42')

    // Restore stub.
    mock.module('../services/billing.service', () => ({
      consumeUsage: async (params: any) => {
        const result = await ctrl.debit()
        if (result?.success) {
          const ev = {
            id: `ue_${nextUsageEventId++}`,
            workspaceId: params.workspaceId,
            actionType: params.actionType,
            createdAt: new Date(),
            actionMetadata: params.actionMetadata,
          }
          store.usageEvent.push(ev)
          return { success: true }
        }
        return result
      },
    }))
  })

  test('larger durationSeconds wins on update (Math.max)', async () => {
    await recordCallUsage({
      ...base,
      conversationId: 'conv_dur',
      durationSeconds: 30,
    })
    expect(store.voiceCallMeter[0].durationSeconds).toBe(30)

    await recordCallUsage({
      ...base,
      conversationId: 'conv_dur',
      durationSeconds: 10, // smaller → should NOT shrink
    })
    expect(store.voiceCallMeter[0].durationSeconds).toBe(30)
  })

  test('startedAt is only set on update when not previously present', async () => {
    const t1 = new Date('2026-05-14T10:00:00Z')
    const t2 = new Date('2026-05-14T11:00:00Z')

    await recordCallUsage({
      ...base,
      conversationId: 'conv_start',
      startedAt: t1,
    })
    expect(store.voiceCallMeter[0].startedAt).toEqual(t1)

    // Duplicate webhook with a different startedAt should NOT overwrite.
    await recordCallUsage({
      ...base,
      conversationId: 'conv_start',
      startedAt: t2,
    })
    expect(store.voiceCallMeter[0].startedAt).toEqual(t1)
  })
})
