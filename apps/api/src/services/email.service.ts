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

// ============================================================================
// Internal helper — all public functions delegate to this
// ============================================================================

async function sendTemplateEmail(
  template: string,
  to: string,
  data: Record<string, unknown>,
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
  creditsTotal?: string
  dashboardUrl: string
}): Promise<{ success: boolean; error?: string }> {
  return sendTemplateEmail('plan-upgraded', params.to, {
    workspaceName: params.workspaceName,
    planName: params.planName,
    billingInterval: params.billingInterval || 'Monthly',
    creditsTotal: params.creditsTotal || 'Unlimited',
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

