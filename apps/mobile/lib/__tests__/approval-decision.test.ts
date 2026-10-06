// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { beforeEach, describe, expect, mock, test } from 'bun:test'

let allowed = true
const haptic: string[] = []

mock.module('../approval-lock', () => ({ confirmApproval: async () => allowed }))
mock.module('../haptics', () => ({
  haptics: {
    success: () => haptic.push('success'),
    warning: () => haptic.push('warning'),
    error: () => haptic.push('error'),
    impact: () => haptic.push('impact'),
    selection: () => haptic.push('selection'),
  },
}))
mock.module('../team-chat-api', () => ({ teamChatApi: () => ({ decideApproval: async () => ({}) }) }))

beforeEach(() => {
  allowed = true
  haptic.length = 0
})

describe('answerApproval', () => {
  test('approving sends the answer, buzzes success and tells listeners', async () => {
    const { answerApproval, subscribeApprovalDecided } = await import('../approval-decision')
    const heard: unknown[] = []
    const off = subscribeApprovalDecided((e) => heard.push(e))
    const sent: unknown[] = []
    const out = await answerApproval('m1', 'approve', { send: async (id, d) => void sent.push([id, d]) })
    off()
    expect(out).toEqual({ ok: true, decision: 'approve' })
    expect(sent).toEqual([['m1', 'approve']])
    expect(haptic).toEqual(['success'])
    expect(heard).toEqual([{ messageId: 'm1', decision: 'approve' }])
  })

  test('denying never asks for a biometric', async () => {
    allowed = false
    const { answerApproval } = await import('../approval-decision')
    const out = await answerApproval('m1', 'deny', { send: async () => {} })
    expect(out).toEqual({ ok: true, decision: 'deny' })
    expect(haptic).toEqual(['impact'])
  })

  test('a refused biometric sends nothing', async () => {
    allowed = false
    const { answerApproval } = await import('../approval-decision')
    let called = false
    const out = await answerApproval('m1', 'approve', { send: async () => void (called = true) })
    expect(out).toEqual({ ok: false, reason: 'cancelled' })
    expect(called).toBe(false)
    expect(haptic).toEqual(['warning'])
  })

  test('a server refusal is reported in plain words and does not tell listeners', async () => {
    const { answerApproval, subscribeApprovalDecided } = await import('../approval-decision')
    const heard: unknown[] = []
    const off = subscribeApprovalDecided((e) => heard.push(e))
    const out = await answerApproval('m1', 'approve', {
      send: async () => {
        throw { response: { data: { error: { code: 'expired', message: 'x' } } } }
      },
    })
    off()
    expect(out).toEqual({ ok: false, reason: 'failed', message: 'This request timed out, so the action was not run' })
    expect(heard).toEqual([])
    expect(haptic).toEqual(['error'])
  })

  test('an already answered request keeps the server message', async () => {
    const { approvalErrorMessage } = await import('../approval-decision')
    expect(approvalErrorMessage({ response: { data: { error: { code: 'already_decided', message: 'Already approved by Sam' } } } })).toBe(
      'Already approved by Sam',
    )
    expect(approvalErrorMessage(new Error('Network down'))).toBe('Network down')
    expect(approvalErrorMessage({})).toBe('Could not send that answer')
  })
})
