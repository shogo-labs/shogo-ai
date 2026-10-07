// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { approvalActionFrom, approvalCategoryActions, failedAnswerBody } from '../agent-actions'

const response = (actionIdentifier: string, data: Record<string, unknown> = { approvalMessageId: 'm1' }) => ({
  actionIdentifier,
  notification: { request: { identifier: 'n1', content: { data } } },
})

describe('approvalCategoryActions', () => {
  test('Approve needs an unlocked phone, Deny is destructive and stays in the background', () => {
    const [approve, deny] = approvalCategoryActions({ requireBiometric: false })
    expect(approve).toMatchObject({ identifier: 'approve', buttonTitle: 'Approve', options: { opensAppToForeground: false, isAuthenticationRequired: true } })
    expect(deny).toMatchObject({ identifier: 'deny', buttonTitle: 'Deny', options: { opensAppToForeground: false, isDestructive: true } })
  })

  test('with the Face ID setting on, Approve opens the app so the prompt can show', () => {
    const [approve, deny] = approvalCategoryActions({ requireBiometric: true })
    expect(approve.options.opensAppToForeground).toBe(true)
    expect(deny.options.opensAppToForeground).toBe(false)
  })
})

describe('approvalActionFrom', () => {
  test('reads Approve and Deny taps', () => {
    expect(approvalActionFrom(response('approve'))).toEqual({ messageId: 'm1', decision: 'approve', notificationId: 'n1' })
    expect(approvalActionFrom(response('deny'))).toEqual({ messageId: 'm1', decision: 'deny', notificationId: 'n1' })
  })

  test('a plain tap on the notification is not an answer', () => {
    expect(approvalActionFrom(response('expo.modules.notifications.actions.DEFAULT'))).toBeNull()
  })

  test('an answer without a card to answer is ignored', () => {
    expect(approvalActionFrom(response('approve', {}))).toBeNull()
    expect(approvalActionFrom(response('approve', { approvalMessageId: '' }))).toBeNull()
    expect(approvalActionFrom(response('approve', { approvalMessageId: 5 }))).toBeNull()
    expect(approvalActionFrom(null)).toBeNull()
    expect(approvalActionFrom({ actionIdentifier: 'approve' })).toBeNull()
  })

  test('works without a notification id', () => {
    expect(approvalActionFrom({ actionIdentifier: 'deny', notification: { request: { content: { data: { approvalMessageId: 'm9' } } } } })).toEqual({
      messageId: 'm9',
      decision: 'deny',
      notificationId: null,
    })
  })
})

describe('failedAnswerBody', () => {
  test('says which answer failed and why', () => {
    expect(failedAnswerBody('approve', 'Already approved by Sam')).toBe('Approval not sent: Already approved by Sam')
    expect(failedAnswerBody('deny', 'Network down')).toBe('Denial not sent: Network down')
  })
})
