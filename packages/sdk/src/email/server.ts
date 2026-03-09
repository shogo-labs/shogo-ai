// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Email Service - Server Side
 *
 * Main entry point for server-side email functionality.
 * Use this in server functions, API routes, etc.
 *
 * @example
 * ```typescript
 * import { createEmail } from '@shogo-ai/sdk/email/server'
 *
 * // Auto-configured from environment variables
 * const email = createEmail()
 *
 * // Send a templated email
 * await email.sendTemplate({
 *   to: 'user@example.com',
 *   template: 'welcome',
 *   data: { name: 'Alice', appName: 'MyApp' },
 * })
 *
 * // Send raw email
 * await email.send({
 *   to: 'user@example.com',
 *   subject: 'Hello!',
 *   html: '<h1>Hello World</h1>',
 * })
 * ```
 */

import type {
  IEmailService,
  IEmailProvider,
  EmailConfig,
  EmailTemplate,
  SendEmailParams,
  SendTemplateParams,
  EmailResult,
  EmailAddress,
} from './types.js'
import { EmailError, formatEmailAddress } from './types.js'
import { SmtpProvider } from './providers/smtp.js'
import { SesProvider } from './providers/ses.js'
import { createProviderFromEnv } from './providers/index.js'
import {
  EmailTemplateRegistry,
} from './templates.js'
import { createShogoTemplateRegistry } from './templates/index.js'

/**
 * Options for creating an email service
 */
export interface CreateEmailOptions {
  /**
   * Email provider configuration.
   * If not provided, auto-detects from environment variables.
   */
  config?: EmailConfig

  /**
   * Default sender address.
   * Can also be set via EMAIL_FROM or SMTP_FROM_EMAIL env var.
   */
  defaultFrom?: EmailAddress

  /**
   * Include built-in templates (welcome, password-reset, invitation, notification).
   * Default: true
   */
  includeBuiltins?: boolean
}

/**
 * Email service implementation
 */
class EmailService implements IEmailService {
  private provider: IEmailProvider
  private templates: EmailTemplateRegistry
  private defaultFrom: EmailAddress

  constructor(
    provider: IEmailProvider,
    templates: EmailTemplateRegistry,
    defaultFrom: EmailAddress
  ) {
    this.provider = provider
    this.templates = templates
    this.defaultFrom = defaultFrom
  }

  /**
   * Check if the service is configured and ready
   */
  isConfigured(): boolean {
    return this.provider.isConfigured()
  }

  /**
   * Register a custom email template
   */
  registerTemplate<TData extends Record<string, unknown>>(
    template: EmailTemplate<TData>
  ): void {
    this.templates.register(template)
  }

  /**
   * Send a raw email
   */
  async send(params: SendEmailParams): Promise<EmailResult> {
    const emailParams: SendEmailParams = {
      ...params,
      from: params.from ?? this.defaultFrom,
    }

    return this.provider.send(emailParams)
  }

  /**
   * Send a templated email
   */
  async sendTemplate<TData extends Record<string, unknown>>(
    params: SendTemplateParams<TData>
  ): Promise<EmailResult> {
    const { template: templateName, data, ...rest } = params

    // Render the template
    const { subject, html, text } = this.templates.render(templateName, data)

    // Send using the provider
    return this.send({
      ...rest,
      subject,
      html,
      text,
    })
  }
}

/**
 * Create an email service instance.
 *
 * If no config is provided, auto-detects provider from environment variables:
 * - SMTP: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD
 * - SES: AWS_REGION or SES_REGION
 *
 * @example
 * ```typescript
 * // Auto-configured from env
 * const email = createEmail()
 *
 * // With explicit SMTP config
 * const email = createEmail({
 *   config: {
 *     provider: 'smtp',
 *     defaultFrom: 'noreply@myapp.com',
 *     smtp: {
 *       host: 'smtp.example.com',
 *       port: 587,
 *       user: 'user',
 *       password: 'pass',
 *     },
 *   },
 * })
 *
 * // With SES config
 * const email = createEmail({
 *   config: {
 *     provider: 'ses',
 *     defaultFrom: 'noreply@myapp.com',
 *     ses: {
 *       region: 'us-east-1',
 *     },
 *   },
 * })
 * ```
 */
export function createEmail(options: CreateEmailOptions = {}): IEmailService {
  const { config, defaultFrom, includeBuiltins = true } = options

  // Determine the provider
  let provider: IEmailProvider | null = null

  if (config) {
    // Explicit config provided
    if (config.provider === 'smtp' && config.smtp) {
      provider = new SmtpProvider(config.smtp)
    } else if (config.provider === 'ses' && config.ses) {
      provider = new SesProvider(config.ses)
    }
  } else {
    // Auto-detect from environment
    provider = createProviderFromEnv()
  }

  if (!provider) {
    throw EmailError.providerNotConfigured()
  }

  // Determine default from address
  const from =
    defaultFrom ??
    config?.defaultFrom ??
    process.env.EMAIL_FROM ??
    process.env.SMTP_FROM_EMAIL ??
    process.env.SES_FROM_EMAIL

  if (!from) {
    throw EmailError.configMissing('defaultFrom (or EMAIL_FROM env var)')
  }

  // Create template registry with Shogo-branded templates
  const templates = includeBuiltins
    ? createShogoTemplateRegistry()
    : new EmailTemplateRegistry()

  return new EmailService(provider, templates, from)
}

/**
 * Create an email service, returning null if not configured.
 * Useful for optional email functionality.
 *
 * @example
 * ```typescript
 * const email = createEmailOptional()
 *
 * if (email) {
 *   await email.send({ ... })
 * } else {
 *   console.log('Email not configured, skipping')
 * }
 * ```
 */
export function createEmailOptional(
  options: CreateEmailOptions = {}
): IEmailService | null {
  try {
    return createEmail(options)
  } catch {
    return null
  }
}

// Re-export types for convenience
export type { IEmailService, EmailConfig, EmailTemplate, SendEmailParams, SendTemplateParams, EmailResult }
