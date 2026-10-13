// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect, beforeEach, mock } from 'bun:test'

const notifications: any[] = []
const failedEmails: any[] = []
const actionEmails: any[] = []

mock.module('../../lib/prisma', () => ({
  prisma: {
    workspace: { findUnique: async () => ({ name: 'Acme' }) },
    member: {
      findMany: async () => [{ user: { email: 'owner@acme.test' } }, { user: { email: 'owner@acme.test' } }],
    },
  },
}))

mock.module('../notification.service', () => ({
  notifyWorkspaceBillingAdmins: async (workspaceId: string, input: any) => {
    notifications.push({ workspaceId, ...input })
  },
}))

mock.module('../email.service', () => ({
  sendOverageChargedEmail: async () => true,
  sendApproachingLimitEmail: async () => true,
  sendPaymentReceiptEmail: async () => true,
  sendPaymentFailedEmail: async (params: any) => { failedEmails.push(params); return true },
  sendPaymentActionRequiredEmail: async (params: any) => { actionEmails.push(params); return true },
}))

mock.module('../../lib/cloud-urls', () => ({
  getFrontendUrl: () => 'https://studio.test',
}))

const { notifyPaymentFailed, notifyPaymentActionRequired } = await import('../billing-alerts.service')

beforeEach(() => {
  notifications.length = 0
  failedEmails.length = 0
  actionEmails.length = 0
})

describe('notifyPaymentFailed', () => {
  it('links the email to the hosted invoice when one is provided', async () => {
    await notifyPaymentFailed('ws1', {
      planName: 'Pro',
      amountUsd: 20,
      invoiceId: 'in_1',
      invoiceUrl: 'https://invoice.stripe.test/i/in_1',
    })

    expect(failedEmails).toHaveLength(1)
    expect(failedEmails[0]).toMatchObject({
      to: 'owner@acme.test',
      workspaceName: 'Acme',
      amount: '20.00',
      retryUrl: 'https://invoice.stripe.test/i/in_1',
    })
    expect(notifications[0]).toMatchObject({
      type: 'payment_failed',
      dedupeKey: 'payment_failed:in_1',
      metadata: { invoiceUrl: 'https://invoice.stripe.test/i/in_1' },
    })
  })

  it('falls back to the billing page without an invoice link', async () => {
    await notifyPaymentFailed('ws1', { planName: 'Pro', amountUsd: 20 })
    expect(failedEmails[0].retryUrl).toBe('https://studio.test/billing?workspace=ws1')
  })
})

describe('notifyPaymentActionRequired', () => {
  it('sends the confirm-payment email and an in-app notice keyed on the invoice', async () => {
    await notifyPaymentActionRequired('ws1', {
      planName: 'On-demand usage',
      amountUsd: 25,
      invoiceId: 'in_2',
      invoiceUrl: 'https://invoice.stripe.test/i/in_2',
    })

    expect(actionEmails).toEqual([
      {
        to: 'owner@acme.test',
        workspaceName: 'Acme',
        planName: 'On-demand usage',
        amount: '25.00',
        confirmUrl: 'https://invoice.stripe.test/i/in_2',
      },
    ])
    expect(failedEmails).toHaveLength(0)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({
      workspaceId: 'ws1',
      type: 'payment_failed',
      title: 'Confirm your payment for Acme',
      dedupeKey: 'payment_action_required:in_2',
      metadata: { actionRequired: true, invoiceUrl: 'https://invoice.stripe.test/i/in_2' },
    })
  })
})
