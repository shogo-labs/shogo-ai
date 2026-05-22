// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it, mock } from 'bun:test'

// Test isolated in its own file so the email-service singleton can be
// initialized with createEmailOptional() returning NULL. Bun's mock.module
// is scoped per test file, so the singleton state in email.service.ts is
// fresh here.

mock.module('@shogo-ai/sdk/email/server', () => ({
  createEmail: () => {
    throw new Error('createEmail not expected when optional resolves null')
  },
  createEmailOptional: () => null,
}))

const svc = await import('../email.service')

describe('email.service — not configured branch', () => {
  it('getEmailService returns null and caches the decision', () => {
    expect(svc.getEmailService()).toBeNull()
    // Second call should return cached null without re-invoking createEmailOptional.
    expect(svc.getEmailService()).toBeNull()
  })

  it('isEmailConfigured returns false', () => {
    expect(svc.isEmailConfigured()).toBe(false)
  })

  it('sendInvitationEmail returns the not-configured error shape', async () => {
    const res = await svc.sendInvitationEmail({
      to: 'a@b.test',
      inviterName: 'Ada',
      workspaceName: 'WS',
      role: 'editor',
      acceptUrl: 'https://x/y',
    })
    expect(res).toEqual({ success: false, error: 'Email service not configured' })
  })

  it('all template wrappers return the same shape when email is not configured', async () => {
    const results = await Promise.all([
      svc.sendWelcomeEmail({ to: 'a@b.test', name: 'Ada' }),
      svc.sendPasswordResetEmail({ to: 'a@b.test', resetUrl: 'u' }),
      svc.sendEmailVerificationEmail({ to: 'a@b.test', verifyUrl: 'u' }),
      svc.sendProjectInviteEmail({
        to: 'a@b.test',
        inviterName: 'I',
        projectName: 'P',
        role: 'r',
        acceptUrl: 'u',
      }),
      svc.sendInviteAcceptedEmail({
        to: 'a@b.test',
        inviteeName: 'X',
        inviteeEmail: 'x@y',
        resourceName: 'WS',
        dashboardUrl: 'u',
      }),
      svc.sendPlanUpgradedEmail({
        to: 'a@b.test',
        workspaceName: 'WS',
        planName: 'Pro',
        dashboardUrl: 'u',
      }),
      svc.sendPaymentReceiptEmail({
        to: 'a@b.test',
        workspaceName: 'WS',
        planName: 'Pro',
        amount: '10',
        invoiceDate: '2026-01-01',
      }),
      svc.sendPaymentFailedEmail({
        to: 'a@b.test',
        workspaceName: 'WS',
        planName: 'Pro',
        amount: '10',
        retryUrl: 'u',
      }),
      svc.sendMemberJoinedEmail({
        to: 'a@b.test',
        memberName: 'M',
        memberEmail: 'm@n',
        workspaceName: 'WS',
        dashboardUrl: 'u',
      }),
      svc.sendMemberRemovedEmail({ to: 'a@b.test', workspaceName: 'WS' }),
      svc.sendAccountDeletedEmail({ to: 'a@b.test' }),
    ])
    for (const r of results) {
      expect(r).toEqual({ success: false, error: 'Email service not configured' })
    }
  })
})
