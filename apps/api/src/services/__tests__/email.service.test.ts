// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// ─── controllable fake IEmailService ─────────────────────────────────────────

type SendTemplateArgs = { to: string; template: string; data: Record<string, unknown> }

const sendCalls: SendTemplateArgs[] = []
let sendTemplateImpl: (
  args: SendTemplateArgs,
) => Promise<{ success: boolean; error?: string }> = async () => ({ success: true })

const fakeEmailService = {
  isConfigured: () => true,
  sendTemplate: async (args: SendTemplateArgs) => {
    sendCalls.push(args)
    return sendTemplateImpl(args)
  },
}

mock.module('@shogo-ai/sdk/email/server', () => ({
  createEmail: () => fakeEmailService,
  createEmailOptional: () => fakeEmailService,
}))

const svc = await import('../email.service')

beforeEach(() => {
  sendCalls.length = 0
  sendTemplateImpl = async () => ({ success: true })
  process.env.APP_NAME = 'Shogo'
})

afterEach(() => {
  delete process.env.APP_NAME
})

// ─── getEmailService / isEmailConfigured ─────────────────────────────────────

describe('getEmailService / isEmailConfigured', () => {
  it('returns the same singleton across calls', () => {
    const a = svc.getEmailService()
    const b = svc.getEmailService()
    expect(a).toBe(b)
    expect(a).not.toBeNull()
  })

  it('isEmailConfigured returns true when the service reports configured', () => {
    expect(svc.isEmailConfigured()).toBe(true)
  })
})

// ─── shared assertions on the template wrappers ─────────────────────────────

function lastSend() {
  return sendCalls[sendCalls.length - 1]!
}

describe('template wrappers — happy path', () => {
  it('sendInvitationEmail passes through and merges appName', async () => {
    const res = await svc.sendInvitationEmail({
      to: 'a@b.test',
      inviterName: 'Ada',
      workspaceName: 'WS',
      role: 'editor',
      acceptUrl: 'https://x/y',
    })
    expect(res.success).toBe(true)
    expect(lastSend().template).toBe('workspace-invite')
    expect(lastSend().to).toBe('a@b.test')
    expect(lastSend().data).toMatchObject({
      inviterName: 'Ada',
      workspaceName: 'WS',
      role: 'editor',
      acceptUrl: 'https://x/y',
      appName: 'Shogo',
    })
  })

  it('sendWelcomeEmail omits loginUrl when not provided', async () => {
    await svc.sendWelcomeEmail({ to: 'a@b.test', name: 'Ada' })
    expect(lastSend().template).toBe('welcome')
    expect(lastSend().data).toEqual({ name: 'Ada', appName: 'Shogo' })
  })

  it('sendWelcomeEmail forwards loginUrl when provided', async () => {
    await svc.sendWelcomeEmail({ to: 'a@b.test', name: 'Ada', loginUrl: 'https://app' })
    expect(lastSend().data.loginUrl).toBe('https://app')
  })

  it('sendPasswordResetEmail defaults expiresIn to "1 hour" and omits name when missing', async () => {
    await svc.sendPasswordResetEmail({ to: 'a@b.test', resetUrl: 'u' })
    expect(lastSend().data).toEqual({
      resetUrl: 'u',
      expiresIn: '1 hour',
      appName: 'Shogo',
    })
  })

  it('sendPasswordResetEmail forwards name + expiresIn when supplied', async () => {
    await svc.sendPasswordResetEmail({
      to: 'a@b.test',
      name: 'Ada',
      resetUrl: 'u',
      expiresIn: '30 minutes',
    })
    expect(lastSend().data).toMatchObject({ name: 'Ada', expiresIn: '30 minutes' })
  })

  it('sendEmailVerificationEmail defaults expiresIn to "24 hours"', async () => {
    await svc.sendEmailVerificationEmail({ to: 'a@b.test', verifyUrl: 'v' })
    expect(lastSend().template).toBe('email-verification')
    expect(lastSend().data.expiresIn).toBe('24 hours')
  })

  it('sendProjectInviteEmail forwards optional workspaceName', async () => {
    await svc.sendProjectInviteEmail({
      to: 'a@b.test',
      inviterName: 'Ada',
      projectName: 'Proj',
      workspaceName: 'WS',
      role: 'editor',
      acceptUrl: 'u',
    })
    expect(lastSend().data.workspaceName).toBe('WS')
  })

  it('sendInviteAcceptedEmail defaults resourceType to "workspace"', async () => {
    await svc.sendInviteAcceptedEmail({
      to: 'a@b.test',
      inviteeName: 'X',
      inviteeEmail: 'x@y',
      resourceName: 'WS',
      dashboardUrl: 'u',
    })
    expect(lastSend().data.resourceType).toBe('workspace')
  })

  it('sendInviteAcceptedEmail forwards a custom resourceType', async () => {
    await svc.sendInviteAcceptedEmail({
      to: 'a@b.test',
      inviteeName: 'X',
      inviteeEmail: 'x@y',
      resourceName: 'P',
      resourceType: 'project',
      dashboardUrl: 'u',
    })
    expect(lastSend().data.resourceType).toBe('project')
  })

  it('sendPlanUpgradedEmail applies defaults for billingInterval / seats / includedUsdTotal', async () => {
    await svc.sendPlanUpgradedEmail({
      to: 'a@b.test',
      workspaceName: 'WS',
      planName: 'Pro',
      dashboardUrl: 'u',
    })
    expect(lastSend().data).toMatchObject({
      billingInterval: 'Monthly',
      seats: '1',
      includedUsdTotal: 'Unlimited',
    })
  })

  it('sendPlanUpgradedEmail clamps seats to >=1 and floors floats', async () => {
    await svc.sendPlanUpgradedEmail({
      to: 'a@b.test',
      workspaceName: 'WS',
      planName: 'Pro',
      seats: 0,
      dashboardUrl: 'u',
    })
    expect(lastSend().data.seats).toBe('1')

    await svc.sendPlanUpgradedEmail({
      to: 'a@b.test',
      workspaceName: 'WS',
      planName: 'Pro',
      seats: 12.9,
      dashboardUrl: 'u',
    })
    expect(lastSend().data.seats).toBe('12')
  })

  it('sendPlanUpgradedEmail forwards custom billingInterval / includedUsdTotal', async () => {
    await svc.sendPlanUpgradedEmail({
      to: 'a@b.test',
      workspaceName: 'WS',
      planName: 'Pro',
      billingInterval: 'Annual',
      includedUsdTotal: '$1000',
      seats: 5,
      dashboardUrl: 'u',
    })
    expect(lastSend().data).toMatchObject({
      billingInterval: 'Annual',
      includedUsdTotal: '$1000',
      seats: '5',
    })
  })

  it('sendPaymentReceiptEmail defaults currency to "$" and omits invoiceUrl when absent', async () => {
    await svc.sendPaymentReceiptEmail({
      to: 'a@b.test',
      workspaceName: 'WS',
      planName: 'Pro',
      amount: '10',
      invoiceDate: '2026-01-01',
    })
    expect(lastSend().data).toEqual({
      workspaceName: 'WS',
      planName: 'Pro',
      amount: '10',
      currency: '$',
      invoiceDate: '2026-01-01',
      appName: 'Shogo',
    })
  })

  it('sendPaymentReceiptEmail forwards custom currency + invoiceUrl', async () => {
    await svc.sendPaymentReceiptEmail({
      to: 'a@b.test',
      workspaceName: 'WS',
      planName: 'Pro',
      amount: '10',
      currency: '€',
      invoiceDate: '2026-01-01',
      invoiceUrl: 'https://invoice',
    })
    expect(lastSend().data).toMatchObject({ currency: '€', invoiceUrl: 'https://invoice' })
  })

  it('sendPaymentFailedEmail defaults currency to "$"', async () => {
    await svc.sendPaymentFailedEmail({
      to: 'a@b.test',
      workspaceName: 'WS',
      planName: 'Pro',
      amount: '10',
      retryUrl: 'u',
    })
    expect(lastSend().data.currency).toBe('$')
  })

  it('sendMemberJoinedEmail defaults role to "Editor"', async () => {
    await svc.sendMemberJoinedEmail({
      to: 'a@b.test',
      memberName: 'M',
      memberEmail: 'm@n',
      workspaceName: 'WS',
      dashboardUrl: 'u',
    })
    expect(lastSend().data.role).toBe('Editor')
  })

  it('sendMemberRemovedEmail passes only workspaceName + appName', async () => {
    await svc.sendMemberRemovedEmail({ to: 'a@b.test', workspaceName: 'WS' })
    expect(lastSend().data).toEqual({ workspaceName: 'WS', appName: 'Shogo' })
  })

  it('sendAccountDeletedEmail mirrors `to` into `email` and forwards optional `name`', async () => {
    await svc.sendAccountDeletedEmail({ to: 'a@b.test', name: 'Ada' })
    expect(lastSend().data).toEqual({
      name: 'Ada',
      email: 'a@b.test',
      appName: 'Shogo',
    })
  })

  it('falls back to APP_NAME="Shogo" when env unset (module loaded with current value, so we just assert non-empty)', async () => {
    // APP_NAME was 'Shogo' when the module loaded (set in beforeAll-equivalent).
    // Just verify the constant gets merged into every data payload.
    await svc.sendMemberRemovedEmail({ to: 'a@b.test', workspaceName: 'WS' })
    expect(typeof lastSend().data.appName).toBe('string')
    expect((lastSend().data.appName as string).length).toBeGreaterThan(0)
  })
})

// ─── failure modes inside sendTemplateEmail ─────────────────────────────────

describe('sendTemplateEmail failure modes', () => {
  it('forwards { success: false, error } from the underlying service', async () => {
    sendTemplateImpl = async () => ({ success: false, error: 'SES throttled' })
    const errs: string[] = []
    const orig = console.error
    console.error = (...a: any[]) => errs.push(a.join(' '))
    try {
      const res = await svc.sendWelcomeEmail({ to: 'a@b.test', name: 'Ada' })
      expect(res).toEqual({ success: false, error: 'SES throttled' })
      expect(errs.some((e) => e.includes('Failed to send welcome to a@b.test'))).toBe(true)
    } finally {
      console.error = orig
    }
  })

  it('catches synchronous exceptions from sendTemplate and returns the .message', async () => {
    sendTemplateImpl = async () => { throw new Error('network down') }
    const res = await svc.sendWelcomeEmail({ to: 'a@b.test', name: 'Ada' })
    expect(res).toEqual({ success: false, error: 'network down' })
  })
})
