// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { APPROVAL_CATEGORY, approvalPushFor } from '../approval-push'

const card = (approval: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  id: 'm1',
  authorAgentRef: { name: 'Billing agent' },
  blocks: { type: 'approval_request', approval: { requestId: 'r1', projectId: 'p1', summary: 'Run a command: ls', status: 'pending', ...approval } },
  ...over,
})

describe('approvalPushFor', () => {
  test('an open card becomes an actionable push', () => {
    expect(approvalPushFor(card())).toEqual({
      agentName: 'Billing agent',
      title: 'Billing agent needs approval',
      body: 'Run a command: ls',
      categoryId: APPROVAL_CATEGORY,
      data: { approvalMessageId: 'm1', approvalRequestId: 'r1', projectId: 'p1' },
    })
  })

  test('a card already answered, or any other message, gets none', () => {
    expect(approvalPushFor(card({ status: 'approved' }))).toBeNull()
    expect(approvalPushFor({ id: 'm', blocks: { type: 'text' } })).toBeNull()
    expect(approvalPushFor({ id: 'm', blocks: null })).toBeNull()
    expect(approvalPushFor({ id: 'm' })).toBeNull()
  })

  test('falls back to plain words and clips long commands', () => {
    expect(approvalPushFor(card({ summary: '' }, { authorAgentRef: null }))).toMatchObject({
      agentName: 'An agent',
      title: 'An agent needs approval',
      body: 'Waiting for your OK',
    })
    expect(approvalPushFor(card({ summary: 'x'.repeat(500) }))?.body).toHaveLength(180)
  })

  test('a missing project is null, not undefined', () => {
    expect(approvalPushFor(card({ projectId: undefined }))?.data.projectId).toBeNull()
  })
})
