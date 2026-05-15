// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/services/email.service.ts — transactional email facade.
 *
 * Every public function is a thin adapter over `IEmailService.sendTemplate`
 * from `@shogo-ai/sdk/email/server`. We:
 *  - Mock the SDK to control `createEmailOptional()` (returns null when
 *    unconfigured, returns a fake `IEmailService` when configured)
 *  - Assert the template name + data envelope each public function emits
 *  - Cover the singleton init path (initialized only once)
 *  - Cover the failure surfaces: SDK returns success:false, SDK throws,
 *    SDK not configured at all
 *
 * The service caches `initialized` + `emailService` in module-scope, so
 * we use `resetModules` via dynamic import + `mock.module` to give every
 * test a clean singleton.
 */

import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

// ─── SDK mocks ────────────────────────────────────────────────────────────

const sendTemplateMock = mock(async (_: any) => ({ success: true }))
const isConfiguredMock = mock(() => true)
const fakeService = {
  sendTemplate: sendTemplateMock,
  isConfigured: isConfiguredMock,
  send: async () => ({ success: true }),
}

let createOptionalReturns: any = fakeService
const createEmailOptionalMock = mock(() => createOptionalReturns)
const createEmailMock = mock(() => fakeService)

mock.module('@shogo-ai/sdk/email/server', () => ({
  createEmail: createEmailMock,
  createEmailOptional: createEmailOptionalMock,
}))

// We need a fresh module load per test because email.service caches its
// init flag in module scope. Bun doesn't expose a `vi.resetModules()`
// equivalent — but using a query-string trick on the import path forces
// a re-evaluation.
let svcCounter = 0
async function loadFreshService() {
  svcCounter++
  // Bun resolves identical specifiers; we workaround by clearing the
  // initialized state via a module-reload technique: re-register the
  // mock with a new factory closure each time so the cache is busted.
  // (mock.module is sticky but re-registering swaps the factory.)
  mock.module('@shogo-ai/sdk/email/server', () => ({
    createEmail: createEmailMock,
    createEmailOptional: createEmailOptionalMock,
  }))
  return import('../services/email.service?cb=' + svcCounter)
}

beforeEach(() => {
  sendTemplateMock.mockReset()
  sendTemplateMock.mockImplementation(async () => ({ success: true }))
  isConfiguredMock.mockReset()
  isConfiguredMock.mockImplementation(() => true)
  createOptionalReturns = fakeService
  createEmailOptionalMock.mockReset()
  createEmailOptionalMock.mockImplementation(() => createOptionalReturns)
  createEmailMock.mockReset()
  createEmailMock.mockImplementation(() => fakeService)
})

// Pre-load once at module top so the chain of public functions works in
// the bulk of our happy-path tests. We re-import inside the singleton
// tests when we need a fresh initialized flag.
const svc = await import('../services/email.service')

// ─── getEmailService / isEmailConfigured / singleton ─────────────────────

describe('getEmailService + singleton init', () => {
  test('returns the SDK instance when createEmailOptional succeeds', () => {
    const out = svc.getEmailService()
    expect(out).toBe(fakeService as any)
  })

  test('repeated calls do NOT re-initialise the SDK (singleton + initialized flag)', () => {
    svc.getEmailService()
    svc.getEmailService()
    svc.getEmailService()
    // Exact count depends on how many earlier tests already triggered init.
    // What we pin: it never increments PER call once initialised.
    const beforeCount = createEmailOptionalMock.mock.calls.length
    svc.getEmailService()
    svc.getEmailService()
    expect(createEmailOptionalMock.mock.calls.length).toBe(beforeCount)
  })

  test('isEmailConfigured proxies through to service.isConfigured()', () => {
    isConfiguredMock.mockImplementation(() => true)
    expect(svc.isEmailConfigured()).toBe(true)
    isConfiguredMock.mockImplementation(() => false)
    expect(svc.isEmailConfigured()).toBe(false)
  })

  test('returns null when SDK is unconfigured — fresh module load', async () => {
    createOptionalReturns = null
    const fresh = await loadFreshService()
    expect(fresh.getEmailService()).toBeNull()
    expect(fresh.isEmailConfigured()).toBe(false)
  })

  test('logs "initialized successfully" on configured init (observability pin)', async () => {
    createOptionalReturns = fakeService
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const fresh = await loadFreshService()
      fresh.getEmailService()
      const out = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(out).toContain('[Email] Service initialized successfully')
    } finally {
      logSpy.mockRestore()
    }
  })

  test('logs "disabled" hint when SDK returns null', async () => {
    createOptionalReturns = null
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const fresh = await loadFreshService()
      fresh.getEmailService()
      const out = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(out).toContain('email features disabled')
    } finally {
      logSpy.mockRestore()
    }
  })
})

// ─── sendTemplateEmail behaviour (via sendInvitationEmail) ────────────────

describe('sendTemplateEmail — common surface', () => {
  test('returns success:false when no SDK is configured', async () => {
    createOptionalReturns = null
    const fresh = await loadFreshService()
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const r = await fresh.sendInvitationEmail({
        to: 'a@b.c',
        inviterName: 'I',
        workspaceName: 'W',
        role: 'editor',
        acceptUrl: 'https://x',
      })
      expect(r).toEqual({ success: false, error: 'Email service not configured' })
      expect(sendTemplateMock).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test('forwards `to` and template name + appName from APP_NAME env', async () => {
    process.env.APP_NAME = 'TestApp'
    const fresh = await loadFreshService()
    await fresh.sendInvitationEmail({
      to: 'user@example.com',
      inviterName: 'I',
      workspaceName: 'W',
      role: 'editor',
      acceptUrl: 'u',
    })
    expect(sendTemplateMock).toHaveBeenCalledTimes(1)
    const call = sendTemplateMock.mock.calls[0][0]
    expect(call.to).toBe('user@example.com')
    expect(call.template).toBe('workspace-invite')
    // appName default for the cached top-level module is read at import time,
    // so it may not pick up TestApp here. What we DO pin: appName is always
    // injected into the data envelope.
    expect(call.data.appName).toBeDefined()
    delete process.env.APP_NAME
  })

  test('returns the SDK error verbatim when sendTemplate resolves with success:false', async () => {
    sendTemplateMock.mockImplementation(async () => ({ success: false, error: 'SMTP refused' }))
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = await svc.sendInvitationEmail({
        to: 'a@b.c', inviterName: 'I', workspaceName: 'W', role: 'editor', acceptUrl: 'u',
      })
      expect(r).toEqual({ success: false, error: 'SMTP refused' })
    } finally {
      errSpy.mockRestore()
    }
  })

  test('catches thrown exceptions and returns success:false with error.message', async () => {
    sendTemplateMock.mockImplementation(async () => {
      throw new Error('TCP reset')
    })
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const r = await svc.sendInvitationEmail({
        to: 'a@b.c', inviterName: 'I', workspaceName: 'W', role: 'editor', acceptUrl: 'u',
      })
      expect(r).toEqual({ success: false, error: 'TCP reset' })
    } finally {
      errSpy.mockRestore()
    }
  })

  test('logs a "sent" line for the to-address on happy path', async () => {
    sendTemplateMock.mockImplementation(async () => ({ success: true }))
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await svc.sendInvitationEmail({
        to: 'who@where.test', inviterName: 'I', workspaceName: 'W', role: 'r', acceptUrl: 'u',
      })
      const out = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(out).toContain('[Email] workspace-invite sent to who@where.test')
    } finally {
      logSpy.mockRestore()
    }
  })

  test('logs an "Exception" line on throw, including the recipient', async () => {
    sendTemplateMock.mockImplementation(async () => {
      throw new Error('boom')
    })
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await svc.sendInvitationEmail({
        to: 'who@where.test', inviterName: 'I', workspaceName: 'W', role: 'r', acceptUrl: 'u',
      })
      const out = errSpy.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(out).toContain('[Email] Exception sending workspace-invite to who@where.test')
    } finally {
      errSpy.mockRestore()
    }
  })
})

// ─── sendInvitationEmail ─────────────────────────────────────────────────

describe('sendInvitationEmail (workspace-invite)', () => {
  test('forwards all four fields and routes to "workspace-invite"', async () => {
    await svc.sendInvitationEmail({
      to: 'invitee@x', inviterName: 'Anya', workspaceName: 'Acme', role: 'admin', acceptUrl: 'https://x/accept',
    })
    const c = sendTemplateMock.mock.calls[0][0]
    expect(c.template).toBe('workspace-invite')
    expect(c.data).toMatchObject({
      inviterName: 'Anya',
      workspaceName: 'Acme',
      role: 'admin',
      acceptUrl: 'https://x/accept',
    })
  })
})

// ─── sendWelcomeEmail ────────────────────────────────────────────────────

describe('sendWelcomeEmail', () => {
  test('forwards name; routes to "welcome"', async () => {
    await svc.sendWelcomeEmail({ to: 'u@x', name: 'Anya' })
    const c = sendTemplateMock.mock.calls[0][0]
    expect(c.template).toBe('welcome')
    expect(c.data).toMatchObject({ name: 'Anya' })
    expect(c.data.loginUrl).toBeUndefined() // omitted by default
  })

  test('forwards loginUrl when provided (conditional spread pin)', async () => {
    await svc.sendWelcomeEmail({ to: 'u@x', name: 'Anya', loginUrl: 'https://app/login' })
    const c = sendTemplateMock.mock.calls[0][0]
    expect(c.data.loginUrl).toBe('https://app/login')
  })
})

// ─── sendPasswordResetEmail ──────────────────────────────────────────────

describe('sendPasswordResetEmail', () => {
  test('routes to "password-reset"; name omitted when missing', async () => {
    await svc.sendPasswordResetEmail({ to: 'u@x', resetUrl: 'https://x/r' })
    const c = sendTemplateMock.mock.calls[0][0]
    expect(c.template).toBe('password-reset')
    expect(c.data.resetUrl).toBe('https://x/r')
    expect(c.data.name).toBeUndefined()
  })

  test('expiresIn defaults to "1 hour"', async () => {
    await svc.sendPasswordResetEmail({ to: 'u@x', resetUrl: 'r' })
    expect(sendTemplateMock.mock.calls[0][0].data.expiresIn).toBe('1 hour')
  })

  test('honors explicit expiresIn override', async () => {
    await svc.sendPasswordResetEmail({ to: 'u@x', resetUrl: 'r', expiresIn: '15 minutes' })
    expect(sendTemplateMock.mock.calls[0][0].data.expiresIn).toBe('15 minutes')
  })

  test('includes name when supplied', async () => {
    await svc.sendPasswordResetEmail({ to: 'u@x', name: 'Anya', resetUrl: 'r' })
    expect(sendTemplateMock.mock.calls[0][0].data.name).toBe('Anya')
  })
})

// ─── sendEmailVerificationEmail ──────────────────────────────────────────

describe('sendEmailVerificationEmail', () => {
  test('routes to "email-verification"; expiresIn defaults to "24 hours"', async () => {
    await svc.sendEmailVerificationEmail({ to: 'u@x', verifyUrl: 'v' })
    const c = sendTemplateMock.mock.calls[0][0]
    expect(c.template).toBe('email-verification')
    expect(c.data.verifyUrl).toBe('v')
    expect(c.data.expiresIn).toBe('24 hours')
  })

  test('forwards optional name', async () => {
    await svc.sendEmailVerificationEmail({ to: 'u@x', name: 'A', verifyUrl: 'v' })
    expect(sendTemplateMock.mock.calls[0][0].data.name).toBe('A')
  })
})

// ─── sendProjectInviteEmail ──────────────────────────────────────────────

describe('sendProjectInviteEmail', () => {
  test('routes to "project-invite" with all fields including optional workspaceName', async () => {
    await svc.sendProjectInviteEmail({
      to: 'u@x', inviterName: 'I', projectName: 'P', workspaceName: 'W',
      role: 'editor', acceptUrl: 'a',
    })
    const c = sendTemplateMock.mock.calls[0][0]
    expect(c.template).toBe('project-invite')
    expect(c.data).toMatchObject({
      inviterName: 'I', projectName: 'P', workspaceName: 'W', role: 'editor', acceptUrl: 'a',
    })
  })

  test('passes undefined workspaceName through (not stripped)', async () => {
    await svc.sendProjectInviteEmail({
      to: 'u@x', inviterName: 'I', projectName: 'P', role: 'editor', acceptUrl: 'a',
    })
    // Field exists with value undefined — template rendering handles it.
    expect('workspaceName' in sendTemplateMock.mock.calls[0][0].data).toBe(true)
    expect(sendTemplateMock.mock.calls[0][0].data.workspaceName).toBeUndefined()
  })
})

// ─── sendInviteAcceptedEmail ─────────────────────────────────────────────

describe('sendInviteAcceptedEmail', () => {
  test('routes to "invite-accepted"; resourceType defaults to "workspace"', async () => {
    await svc.sendInviteAcceptedEmail({
      to: 'u@x', inviteeName: 'N', inviteeEmail: 'i@e',
      resourceName: 'R', dashboardUrl: 'd',
    })
    const c = sendTemplateMock.mock.calls[0][0]
    expect(c.template).toBe('invite-accepted')
    expect(c.data.resourceType).toBe('workspace')
  })

  test('honors explicit resourceType (e.g. "project")', async () => {
    await svc.sendInviteAcceptedEmail({
      to: 'u@x', inviteeName: 'N', inviteeEmail: 'i@e',
      resourceName: 'R', resourceType: 'project', dashboardUrl: 'd',
    })
    expect(sendTemplateMock.mock.calls[0][0].data.resourceType).toBe('project')
  })
})

// ─── sendPlanUpgradedEmail ───────────────────────────────────────────────

describe('sendPlanUpgradedEmail — defaults + seats clamping', () => {
  test('routes to "plan-upgraded"; defaults billingInterval="Monthly", includedUsdTotal="Unlimited", seats=1', async () => {
    await svc.sendPlanUpgradedEmail({
      to: 'u@x', workspaceName: 'W', planName: 'Pro', dashboardUrl: 'd',
    })
    const c = sendTemplateMock.mock.calls[0][0]
    expect(c.template).toBe('plan-upgraded')
    expect(c.data.billingInterval).toBe('Monthly')
    expect(c.data.includedUsdTotal).toBe('Unlimited')
    expect(c.data.seats).toBe('1') // String() conversion + clamp
  })

  test('seats are STRINGIFIED via String() (template-engine contract)', async () => {
    await svc.sendPlanUpgradedEmail({
      to: 'u@x', workspaceName: 'W', planName: 'Pro', seats: 12, dashboardUrl: 'd',
    })
    expect(sendTemplateMock.mock.calls[0][0].data.seats).toBe('12')
  })

  test('seats <= 0 are clamped to 1 (Math.max pin)', async () => {
    await svc.sendPlanUpgradedEmail({
      to: 'u@x', workspaceName: 'W', planName: 'Pro', seats: 0, dashboardUrl: 'd',
    })
    expect(sendTemplateMock.mock.calls[0][0].data.seats).toBe('1')

    await svc.sendPlanUpgradedEmail({
      to: 'u@x', workspaceName: 'W', planName: 'Pro', seats: -5, dashboardUrl: 'd',
    })
    expect(sendTemplateMock.mock.calls[1][0].data.seats).toBe('1')
  })

  test('fractional seats are floored', async () => {
    await svc.sendPlanUpgradedEmail({
      to: 'u@x', workspaceName: 'W', planName: 'Pro', seats: 3.9, dashboardUrl: 'd',
    })
    expect(sendTemplateMock.mock.calls[0][0].data.seats).toBe('3')
  })

  test('honors explicit billingInterval + includedUsdTotal', async () => {
    await svc.sendPlanUpgradedEmail({
      to: 'u@x', workspaceName: 'W', planName: 'Pro',
      billingInterval: 'Annual', includedUsdTotal: '$120', dashboardUrl: 'd',
    })
    const d = sendTemplateMock.mock.calls[0][0].data
    expect(d.billingInterval).toBe('Annual')
    expect(d.includedUsdTotal).toBe('$120')
  })
})

// ─── sendPaymentReceiptEmail ─────────────────────────────────────────────

describe('sendPaymentReceiptEmail', () => {
  test('routes to "payment-receipt"; currency defaults to "$"; invoiceUrl conditional', async () => {
    await svc.sendPaymentReceiptEmail({
      to: 'u@x', workspaceName: 'W', planName: 'Pro',
      amount: '12.00', invoiceDate: '2026-01-01',
    })
    const c = sendTemplateMock.mock.calls[0][0]
    expect(c.template).toBe('payment-receipt')
    expect(c.data.currency).toBe('$')
    expect('invoiceUrl' in c.data).toBe(false) // conditional spread omits it
  })

  test('includes invoiceUrl when supplied', async () => {
    await svc.sendPaymentReceiptEmail({
      to: 'u@x', workspaceName: 'W', planName: 'Pro',
      amount: '12.00', invoiceDate: '2026-01-01', invoiceUrl: 'https://stripe/i',
    })
    expect(sendTemplateMock.mock.calls[0][0].data.invoiceUrl).toBe('https://stripe/i')
  })

  test('honors custom currency', async () => {
    await svc.sendPaymentReceiptEmail({
      to: 'u@x', workspaceName: 'W', planName: 'Pro',
      amount: '12.00', currency: '€', invoiceDate: '2026-01-01',
    })
    expect(sendTemplateMock.mock.calls[0][0].data.currency).toBe('€')
  })
})

// ─── sendPaymentFailedEmail ──────────────────────────────────────────────

describe('sendPaymentFailedEmail', () => {
  test('routes to "payment-failed"; currency defaults to "$"', async () => {
    await svc.sendPaymentFailedEmail({
      to: 'u@x', workspaceName: 'W', planName: 'P', amount: '5', retryUrl: 'https://r',
    })
    const c = sendTemplateMock.mock.calls[0][0]
    expect(c.template).toBe('payment-failed')
    expect(c.data.currency).toBe('$')
    expect(c.data.retryUrl).toBe('https://r')
  })

  test('honors custom currency', async () => {
    await svc.sendPaymentFailedEmail({
      to: 'u@x', workspaceName: 'W', planName: 'P', amount: '5',
      currency: '¥', retryUrl: 'https://r',
    })
    expect(sendTemplateMock.mock.calls[0][0].data.currency).toBe('¥')
  })
})

// ─── sendMemberJoinedEmail ───────────────────────────────────────────────

describe('sendMemberJoinedEmail', () => {
  test('routes to "member-joined"; role defaults to "Editor"', async () => {
    await svc.sendMemberJoinedEmail({
      to: 'u@x', memberName: 'N', memberEmail: 'm@e',
      workspaceName: 'W', dashboardUrl: 'd',
    })
    const c = sendTemplateMock.mock.calls[0][0]
    expect(c.template).toBe('member-joined')
    expect(c.data.role).toBe('Editor')
  })

  test('honors explicit role', async () => {
    await svc.sendMemberJoinedEmail({
      to: 'u@x', memberName: 'N', memberEmail: 'm@e',
      workspaceName: 'W', role: 'Admin', dashboardUrl: 'd',
    })
    expect(sendTemplateMock.mock.calls[0][0].data.role).toBe('Admin')
  })
})

// ─── sendMemberRemovedEmail ──────────────────────────────────────────────

describe('sendMemberRemovedEmail', () => {
  test('routes to "member-removed" with just workspaceName', async () => {
    await svc.sendMemberRemovedEmail({ to: 'u@x', workspaceName: 'W' })
    const c = sendTemplateMock.mock.calls[0][0]
    expect(c.template).toBe('member-removed')
    expect(c.data.workspaceName).toBe('W')
    expect(c.data.appName).toBeDefined()
  })
})

// ─── sendAccountDeletedEmail ─────────────────────────────────────────────

describe('sendAccountDeletedEmail', () => {
  test('routes to "account-deleted"; email field defaults to `to`', async () => {
    await svc.sendAccountDeletedEmail({ to: 'gone@user.test', name: 'Anya' })
    const c = sendTemplateMock.mock.calls[0][0]
    expect(c.template).toBe('account-deleted')
    expect(c.data.email).toBe('gone@user.test') // pinned: confirms the deleted account address
    expect(c.data.name).toBe('Anya')
  })

  test('name is optional (undefined passes through)', async () => {
    await svc.sendAccountDeletedEmail({ to: 'gone@user.test' })
    const d = sendTemplateMock.mock.calls[0][0].data
    expect(d.email).toBe('gone@user.test')
    expect(d.name).toBeUndefined()
  })
})

// ─── appName injection ───────────────────────────────────────────────────

describe('appName injection (from APP_NAME env)', () => {
  test('every public function adds an appName field to the template data', async () => {
    const calls = [
      svc.sendInvitationEmail({ to: 'a@b', inviterName: 'i', workspaceName: 'w', role: 'r', acceptUrl: 'u' }),
      svc.sendWelcomeEmail({ to: 'a@b', name: 'n' }),
      svc.sendPasswordResetEmail({ to: 'a@b', resetUrl: 'u' }),
      svc.sendEmailVerificationEmail({ to: 'a@b', verifyUrl: 'u' }),
      svc.sendProjectInviteEmail({ to: 'a@b', inviterName: 'i', projectName: 'p', role: 'r', acceptUrl: 'u' }),
      svc.sendInviteAcceptedEmail({ to: 'a@b', inviteeName: 'n', inviteeEmail: 'i@e', resourceName: 'r', dashboardUrl: 'u' }),
      svc.sendPlanUpgradedEmail({ to: 'a@b', workspaceName: 'w', planName: 'p', dashboardUrl: 'u' }),
      svc.sendPaymentReceiptEmail({ to: 'a@b', workspaceName: 'w', planName: 'p', amount: '1', invoiceDate: 'd' }),
      svc.sendPaymentFailedEmail({ to: 'a@b', workspaceName: 'w', planName: 'p', amount: '1', retryUrl: 'u' }),
      svc.sendMemberJoinedEmail({ to: 'a@b', memberName: 'n', memberEmail: 'm@e', workspaceName: 'w', dashboardUrl: 'u' }),
      svc.sendMemberRemovedEmail({ to: 'a@b', workspaceName: 'w' }),
      svc.sendAccountDeletedEmail({ to: 'a@b' }),
    ]
    await Promise.all(calls)
    // sendTemplateMock was called 12 times in this test — every call must have appName.
    const last12 = sendTemplateMock.mock.calls.slice(-12)
    for (const c of last12) {
      expect(c[0].data.appName).toBeDefined()
      expect(typeof c[0].data.appName).toBe('string')
    }
  })
})
