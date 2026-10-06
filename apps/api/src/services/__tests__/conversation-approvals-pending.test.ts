// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { toPendingApproval } from '../conversation-approvals'

const NOW = new Date('2026-10-06T12:00:00Z')

const card = (patch: Record<string, unknown> = {}, approval: Record<string, unknown> = {}) => ({
  id: 'm1',
  conversationId: 'c1',
  createdAt: new Date('2026-10-06T11:59:00Z'),
  deletedAt: null,
  authorAgentRef: { name: 'Billing agent' },
  blocks: {
    type: 'approval_request',
    approval: { requestId: 'r1', projectId: 'p1', toolName: 'exec', summary: 'Run a command: ls', status: 'pending', ...approval },
  },
  ...patch,
})

describe('toPendingApproval', () => {
  test('an open card becomes a pending approval', () => {
    expect(toPendingApproval(card(), NOW)).toEqual({
      messageId: 'm1',
      conversationId: 'c1',
      requestId: 'r1',
      projectId: 'p1',
      agentName: 'Billing agent',
      toolName: 'exec',
      summary: 'Run a command: ls',
      createdAt: '2026-10-06T11:59:00.000Z',
    })
  })

  test('carries the reason and expiry when set', () => {
    const out = toPendingApproval(card({}, { reason: 'Needs a deploy', expiresAt: '2026-10-06T12:05:00Z' }), NOW)
    expect(out?.reason).toBe('Needs a deploy')
    expect(out?.expiresAt).toBe('2026-10-06T12:05:00Z')
  })

  test('a decided card is not pending', () => {
    expect(toPendingApproval(card({}, { status: 'approved' }), NOW)).toBeNull()
    expect(toPendingApproval(card({}, { status: 'expired' }), NOW)).toBeNull()
  })

  test('a card past its expiry is not pending even if never marked', () => {
    expect(toPendingApproval(card({}, { expiresAt: '2026-10-06T11:59:30Z' }), NOW)).toBeNull()
  })

  test('a deleted message or a plain message is not pending', () => {
    expect(toPendingApproval(card({ deletedAt: new Date() }), NOW)).toBeNull()
    expect(toPendingApproval({ ...card(), blocks: { type: 'text' } }, NOW)).toBeNull()
    expect(toPendingApproval(null, NOW)).toBeNull()
  })

  test('falls back to a generic agent name', () => {
    expect(toPendingApproval(card({ authorAgentRef: null }), NOW)?.agentName).toBe('Agent')
  })
})
