// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Email Module
 *
 * Provides email sending capabilities for Shogo SDK apps.
 *
 * @example Server-side usage (recommended)
 * ```typescript
 * import { createEmail } from '@shogo-ai/sdk/email/server'
 *
 * const email = createEmail()
 *
 * await email.sendTemplate({
 *   to: 'user@example.com',
 *   template: 'welcome',
 *   data: { name: 'Alice', appName: 'MyApp' },
 * })
 * ```
 *
 * @example Types-only import (for client code)
 * ```typescript
 * import type { EmailResult, SendTemplateParams } from '@shogo-ai/sdk/email'
 * ```
 */

// Types (safe to import anywhere)
export type {
  // Core types
  EmailAddress,
  SendEmailParams,
  SendTemplateParams,
  EmailResult,

  // Config types
  EmailProviderType,
  EmailConfig,
  SmtpConfig,
  SesConfig,
  OciEmailConfig,

  // Template types
  EmailTemplate,
  TemplateRegistry,

  // Service interface
  IEmailService,
  IEmailProvider,

  // Error types
  EmailErrorCode,
} from './types.js'

export { EmailError, formatEmailAddress } from './types.js'

// Template utilities (safe anywhere - no side effects)
export {
  interpolate,
  htmlToText,
  EmailTemplateRegistry,
  createTemplateRegistry,

  // Built-in templates
  welcomeTemplate,
  passwordResetTemplate,
  invitationTemplate,
  notificationTemplate,
  builtinTemplates,
} from './templates.js'
