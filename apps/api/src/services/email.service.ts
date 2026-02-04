/**
 * Email Service
 *
 * Server-side email service using @shogo-ai/sdk email module.
 * Sends transactional emails for invitations, notifications, etc.
 */

import { createEmail, createEmailOptional, type IEmailService } from '@shogo-ai/sdk/email/server'

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
// Email Sending Functions
// ============================================================================

/**
 * Send an invitation email
 */
export async function sendInvitationEmail(params: {
  to: string
  inviterName: string
  workspaceName: string
  role: string
  acceptUrl: string
}): Promise<{ success: boolean; error?: string }> {
  const email = getEmailService()

  if (!email) {
    console.warn('[Email] Invitation email skipped - email not configured')
    return { success: false, error: 'Email service not configured' }
  }

  try {
    const result = await email.sendTemplate({
      to: params.to,
      template: 'invitation',
      data: {
        inviterName: params.inviterName,
        resourceName: params.workspaceName,
        resourceType: 'workspace',
        role: params.role,
        acceptUrl: params.acceptUrl,
        appName: process.env.APP_NAME || 'Shogo',
      },
    })

    if (result.success) {
      console.log(`[Email] Invitation sent to ${params.to}`)
    } else {
      console.error(`[Email] Failed to send invitation to ${params.to}:`, result.error)
    }

    return result
  } catch (error: any) {
    console.error(`[Email] Exception sending invitation to ${params.to}:`, error)
    return { success: false, error: error.message }
  }
}

/**
 * Send a welcome email
 */
export async function sendWelcomeEmail(params: {
  to: string
  name: string
  loginUrl?: string
}): Promise<{ success: boolean; error?: string }> {
  const email = getEmailService()

  if (!email) {
    console.warn('[Email] Welcome email skipped - email not configured')
    return { success: false, error: 'Email service not configured' }
  }

  try {
    const result = await email.sendTemplate({
      to: params.to,
      template: 'welcome',
      data: {
        name: params.name,
        appName: process.env.APP_NAME || 'Shogo',
        loginUrl: params.loginUrl,
      },
    })

    if (result.success) {
      console.log(`[Email] Welcome email sent to ${params.to}`)
    } else {
      console.error(`[Email] Failed to send welcome email to ${params.to}:`, result.error)
    }

    return result
  } catch (error: any) {
    console.error(`[Email] Exception sending welcome email to ${params.to}:`, error)
    return { success: false, error: error.message }
  }
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
  const email = getEmailService()

  if (!email) {
    console.warn('[Email] Password reset email skipped - email not configured')
    return { success: false, error: 'Email service not configured' }
  }

  try {
    const result = await email.sendTemplate({
      to: params.to,
      template: 'password-reset',
      data: {
        name: params.name,
        appName: process.env.APP_NAME || 'Shogo',
        resetUrl: params.resetUrl,
        expiresIn: params.expiresIn || '1 hour',
      },
    })

    if (result.success) {
      console.log(`[Email] Password reset email sent to ${params.to}`)
    } else {
      console.error(`[Email] Failed to send password reset to ${params.to}:`, result.error)
    }

    return result
  } catch (error: any) {
    console.error(`[Email] Exception sending password reset to ${params.to}:`, error)
    return { success: false, error: error.message }
  }
}

/**
 * Send a notification email
 */
export async function sendNotificationEmail(params: {
  to: string
  title: string
  message: string
  actionUrl?: string
  actionText?: string
}): Promise<{ success: boolean; error?: string }> {
  const email = getEmailService()

  if (!email) {
    console.warn('[Email] Notification email skipped - email not configured')
    return { success: false, error: 'Email service not configured' }
  }

  try {
    const result = await email.sendTemplate({
      to: params.to,
      template: 'notification',
      data: {
        title: params.title,
        message: params.message,
        actionUrl: params.actionUrl,
        actionText: params.actionText || 'View Details',
        appName: process.env.APP_NAME || 'Shogo',
      },
    })

    if (result.success) {
      console.log(`[Email] Notification sent to ${params.to}`)
    } else {
      console.error(`[Email] Failed to send notification to ${params.to}:`, result.error)
    }

    return result
  } catch (error: any) {
    console.error(`[Email] Exception sending notification to ${params.to}:`, error)
    return { success: false, error: error.message }
  }
}
