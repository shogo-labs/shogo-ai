/**
 * Email Service Module
 *
 * Provides email sending capabilities with SMTP integration.
 * The email service is optional - if not configured, email-dependent
 * features should gracefully degrade.
 */

// Types and interfaces
export * from './types'

// SMTP implementation
export { SmtpEmailService, createSmtpEmailServiceFromEnv } from './smtp'

// Template functions
export {
  loadTemplate,
  renderEmailTemplate,
  renderInvitationEmail,
  type TemplateName,
  type InvitationTemplateVars,
} from './templates'
