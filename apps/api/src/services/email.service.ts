// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Email Service
 *
 * Server-side email service using @shogo-ai/sdk email module.
 * Sends transactional emails for invitations, notifications, etc.
 */

import { createEmail, createEmailOptional, type IEmailService } from '@shogo-ai/sdk/email/server'

const APP_NAME = process.env.APP_NAME || 'Shogo'

// Singleton email service instance
let emailService: IEmailService | null = null
let initialized = false

/**
 * Get or create the email service singleton.
 *
 * Uses environment variables for configuration:
 * - SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD (SMTP)
 * - AWS_REGION (SES)
 * - EMAIL_FROM or SMTP_FROM_EMAIL (sender address)
 *
 * Returns null if email is not configured (graceful degradation).
 */
export function getEmailService(): IEmailService | null {
  if (!initialized) {
    initialized = true
    emailService = createEmailOptional()

    if (emailService) {
      console.log('[Email] Service initialized successfully')
    } else {
      console.log('[Email] Service not configured - email features disabled')
    }
  }

  return emailService
}

/**
 * Check if email service is available
 */
export function isEmailConfigured(): boolean {
  const service = getEmailService()
  return service !== null && service.isConfigured()
}

/**
 * @internal Test-only — reset the module-scope singleton so the init
 * branch can be re-exercised. Lets unit tests cover both the configured
 * and unconfigured paths in a single bun-test process without forcing a
 * `?cb=` cache-bust module reload (which pollutes lcov with phantom
 * line entries for TypeScript-stripped type annotations).
 */
export function __resetEmailServiceForTesting(): void {
  emailService = null
  initialized = false
}

// ============================================================================
// Internal helper — all public functions delegate to this
// ============================================================================

async function sendTemplateEmail(
  template: string,
  to: string,
  data: Record<string, unknown>,
  options: { headers?: Record<string, string> } = {},
): Promise<{ success: boolean; error?: string }> {
  const email = getEmailService()

  if (!email) {
    console.warn(`[Email] ${template} email skipped - email not configured`)
    return { success: false, error: 'Email service not configured' }
  }

  try {
    const result = await email.sendTemplate({
      to,
      template,
      data: { ...data, appName: APP_NAME },
      ...(options.headers ? { headers: options.headers } : {}),
    })

    if (result.success) {
      console.log(`[Email] ${template} sent to ${to}`)
    } else {
      console.error(`[Email] Failed to send ${template} to ${to}:`, result.error)
    }

    return result
  } catch (error: any) {
    console.error(`[Email] Exception sending ${template} to ${to}:`, error)
    return { success: false, error: error.message }
  }
}

// ============================================================================
// Email Sending Functions
// ============================================================================

/**
 * Send a workspace invitation email
 */
export async function sendInvitationEmail(params: {
  to: string
  inviterName: string
  workspaceName: string
  role: string
  acceptUrl: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail('workspace-invite', params.to, {
    inviterName: params.inviterName,
    workspaceName: params.workspaceName,
    role: params.role,
    acceptUrl: params.acceptUrl,
  })
}

/**
 * Send a welcome email
 */
export async function sendWelcomeEmail(params: {
  to: string
  name: string
  loginUrl?: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail('welcome', params.to, {
    name: params.name,
    ...(params.loginUrl ? { loginUrl: params.loginUrl } : {}),
  })
}

/**
 * Send a password reset email
 */
export async function sendPasswordResetEmail(params: {
  to: string
  name?: string
  resetUrl: string
  expiresIn?: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail('password-reset', params.to, {
    ...(params.name ? { name: params.name } : {}),
    resetUrl: params.resetUrl,
    expiresIn: params.expiresIn || '1 hour',
  })
}

/**
 * Send an email verification email
 */
export async function sendEmailVerificationEmail(params: {
  to: string
  name?: string
  verifyUrl: string
  expiresIn?: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail('email-verification', params.to, {
    ...(params.name ? { name: params.name } : {}),
    verifyUrl: params.verifyUrl,
    expiresIn: params.expiresIn || '24 hours',
  })
}

/**
 * Send a project invitation email
 */
export async function sendProjectInviteEmail(params: {
  to: string
  inviterName: string
  projectName: string
  workspaceName?: string
  role: string
  acceptUrl: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail('project-invite', params.to, {
    inviterName: params.inviterName,
    projectName: params.projectName,
    workspaceName: params.workspaceName,
    role: params.role,
    acceptUrl: params.acceptUrl,
  })
}

/**
 * Send an "invite accepted" notification to the inviter
 */
export async function sendInviteAcceptedEmail(params: {
  to: string
  inviteeName: string
  inviteeEmail: string
  resourceName: string
  resourceType?: string
  dashboardUrl: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail('invite-accepted', params.to, {
    inviteeName: params.inviteeName,
    inviteeEmail: params.inviteeEmail,
    resourceName: params.resourceName,
    resourceType: params.resourceType || 'workspace',
    dashboardUrl: params.dashboardUrl,
  })
}

/**
 * Send a plan upgraded confirmation email
 */
export async function sendPlanUpgradedEmail(params: {
  to: string
  workspaceName: string
  planName: string
  billingInterval?: string
  seats?: number
  includedUsdTotal?: string
  dashboardUrl: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail('plan-upgraded', params.to, {
    workspaceName: params.workspaceName,
    planName: params.planName,
    billingInterval: params.billingInterval || 'Monthly',
    seats: String(Math.max(1, Math.floor(params.seats ?? 1))),
    includedUsdTotal: params.includedUsdTotal || 'Unlimited',
    dashboardUrl: params.dashboardUrl,
  })
}

/**
 * Send the "your free trial ends soon" reminder. Triggered by Stripe's
 * `customer.subscription.trial_will_end` (about 3 days before the trial ends).
 * Requires a `trial-ending` template on the email provider.
 */
export async function sendTrialEndingEmail(params: {
  to: string
  workspaceName: string
  planName: string
  trialEndsAt: string
  dashboardUrl: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail('trial-ending', params.to, {
    workspaceName: params.workspaceName,
    planName: params.planName,
    trialEndsAt: params.trialEndsAt,
    dashboardUrl: params.dashboardUrl,
  })
}

/**
 * Tell the owner their trial checkout was cancelled because the card or account
 * already used a free trial, so they can subscribe without one. Nothing was
 * charged. Requires a `trial-unavailable` template on the email provider.
 */
export async function sendTrialUnavailableEmail(params: {
  to: string
  workspaceName: string
  planName: string
  dashboardUrl: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail('trial-unavailable', params.to, {
    workspaceName: params.workspaceName,
    planName: params.planName,
    dashboardUrl: params.dashboardUrl,
  })
}

/**
 * Send a payment receipt email
 */
export async function sendPaymentReceiptEmail(params: {
  to: string
  workspaceName: string
  planName: string
  amount: string
  currency?: string
  invoiceDate: string
  invoiceUrl?: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail('payment-receipt', params.to, {
    workspaceName: params.workspaceName,
    planName: params.planName,
    amount: params.amount,
    currency: params.currency || '$',
    invoiceDate: params.invoiceDate,
    ...(params.invoiceUrl ? { invoiceUrl: params.invoiceUrl } : {}),
  })
}

/**
 * Send a payment failed email
 */
export async function sendPaymentFailedEmail(params: {
  to: string
  workspaceName: string
  planName: string
  amount: string
  currency?: string
  retryUrl: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail('payment-failed', params.to, {
    workspaceName: params.workspaceName,
    planName: params.planName,
    amount: params.amount,
    currency: params.currency || '$',
    retryUrl: params.retryUrl,
  })
}

/**
 * Send a "confirm your payment" email when the customer's bank requires
 * authentication (3-D Secure / RBI e-mandate rules) before an off-session
 * charge can complete. `confirmUrl` is Stripe's hosted invoice page.
 */
export async function sendPaymentActionRequiredEmail(params: {
  to: string
  workspaceName: string
  planName: string
  amount: string
  currency?: string
  confirmUrl: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail('payment-action-required', params.to, {
    workspaceName: params.workspaceName,
    planName: params.planName,
    amount: params.amount,
    currency: params.currency || '$',
    confirmUrl: params.confirmUrl,
  })
}

/**
 * Send an on-demand usage (overage) charged email. Fired when a mid-cycle
 * overage block is invoiced so the charge never arrives unannounced.
 */
export async function sendOverageChargedEmail(params: {
  to: string
  workspaceName: string
  amount: string
  currency?: string
  periodOverageUsd: string
  invoiceUrl?: string
  manageUrl: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail('usage-overage-charged', params.to, {
    workspaceName: params.workspaceName,
    amount: params.amount,
    currency: params.currency || '$',
    periodOverageUsd: params.periodOverageUsd,
    manageUrl: params.manageUrl,
    ...(params.invoiceUrl ? { invoiceUrl: params.invoiceUrl } : {}),
  })
}

/**
 * Send a proactive "approaching usage limit" email (included usage nearly
 * exhausted, or nearing the configured spend cap). `limitLabel` selects the
 * wording, e.g. 'included usage' or 'spending cap'.
 */
export async function sendApproachingLimitEmail(params: {
  to: string
  workspaceName: string
  currency?: string
  usedUsd: string
  limitUsd: string
  limitLabel: string
  percentUsed: string
  manageUrl: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail('usage-approaching-limit', params.to, {
    workspaceName: params.workspaceName,
    currency: params.currency || '$',
    usedUsd: params.usedUsd,
    limitUsd: params.limitUsd,
    limitLabel: params.limitLabel,
    percentUsed: params.percentUsed,
    manageUrl: params.manageUrl,
  })
}

/**
 * Send the "your build is ready" lifecycle email (SHO-258 §4). At most one per
 * user per day — the caller enforces the frequency, not the template.
 *
 * `List-Unsubscribe` plus `List-Unsubscribe-Post` are set because this is the
 * one non-transactional message we send; Gmail/Yahoo require the header on
 * bulk senders and it makes the opt-out a one-click POST.
 */
export async function sendBuildReadyEmail(params: {
  to: string
  projectName: string
  summary: string
  projectUrl: string
  preferencesUrl: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail(
    'build-ready',
    params.to,
    {
      projectName: params.projectName,
      summary: params.summary,
      projectUrl: params.projectUrl,
      preferencesUrl: params.preferencesUrl,
    },
    {
      headers: {
        'List-Unsubscribe': `<${params.preferencesUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    },
  )
}

/**
 * Send the "your agent is back" lifecycle email once per cap (SHO-258 §4),
 * when the exhausted 5-hour window reopens.
 */
export async function sendCreditsResetEmail(params: {
  to: string
  projectName: string
  resetAt: string
  continueUrl: string
  preferencesUrl: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail(
    'credits-reset',
    params.to,
    {
      projectName: params.projectName,
      resetAt: params.resetAt,
      continueUrl: params.continueUrl,
      preferencesUrl: params.preferencesUrl,
    },
    {
      headers: {
        'List-Unsubscribe': `<${params.preferencesUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    },
  )
}

/**
 * Send a member joined notification email
 */
export async function sendMemberJoinedEmail(params: {
  to: string
  memberName: string
  memberEmail: string
  workspaceName: string
  role?: string
  dashboardUrl: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail('member-joined', params.to, {
    memberName: params.memberName,
    memberEmail: params.memberEmail,
    workspaceName: params.workspaceName,
    role: params.role || 'Editor',
    dashboardUrl: params.dashboardUrl,
  })
}

/**
 * Send a member removed notification email
 */
export async function sendMemberRemovedEmail(params: {
  to: string
  workspaceName: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail('member-removed', params.to, {
    workspaceName: params.workspaceName,
  })
}

/**
 * Send an account deleted confirmation email
 */
export async function sendAccountDeletedEmail(params: {
  to: string
  name?: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail('account-deleted', params.to, {
    name: params.name,
    email: params.to,
  })
}


/**
 * Send the daily channels digest (unread mentions, thread replies, and DMs)
 */
export async function sendChannelDigestEmail(params: {
  to: string
  workspaceName: string
  countLabel: string
  summary: string
  channelsUrl: string
  settingsUrl: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail('channel-digest', params.to, {
    workspaceName: params.workspaceName,
    countLabel: params.countLabel,
    summary: params.summary,
    channelsUrl: params.channelsUrl,
    settingsUrl: params.settingsUrl,
  })
}
