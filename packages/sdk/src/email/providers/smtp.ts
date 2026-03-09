// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SMTP Email Provider
 *
 * Uses nodemailer to send emails via any SMTP server.
 * Works with AWS SES SMTP, SendGrid SMTP, Mailgun SMTP, etc.
 */

import type {
  IEmailProvider,
  SendEmailParams,
  EmailResult,
  SmtpConfig,
  EmailAddress,
} from '../types.js'
import { EmailError, formatEmailAddress } from '../types.js'

/**
 * SMTP provider implementation using nodemailer
 */
export class SmtpProvider implements IEmailProvider {
  private config: SmtpConfig
  private transporter: any // nodemailer.Transporter - lazy loaded

  constructor(config: SmtpConfig) {
    this.validateConfig(config)
    this.config = config
  }

  /**
   * Validate required config fields
   */
  private validateConfig(config: SmtpConfig): void {
    const required: (keyof SmtpConfig)[] = ['host', 'port', 'user', 'password']

    for (const field of required) {
      if (!config[field]) {
        throw EmailError.configMissing(`smtp.${field}`)
      }
    }
  }

  /**
   * Lazy-load nodemailer and create transporter
   */
  private async getTransporter(): Promise<any> {
    if (this.transporter) {
      return this.transporter
    }

    // Dynamic import to avoid bundling nodemailer in client builds
    const nodemailer = await import('nodemailer')

    this.transporter = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure ?? this.config.port === 465,
      auth: {
        user: this.config.user,
        pass: this.config.password,
      },
    })

    return this.transporter
  }

  /**
   * Format recipients for nodemailer
   */
  private formatRecipients(addresses: EmailAddress | EmailAddress[]): string {
    const list = Array.isArray(addresses) ? addresses : [addresses]
    return list.map(formatEmailAddress).join(', ')
  }

  /**
   * Strip HTML tags to create plain text version
   */
  private stripHtml(html: string): string {
    return html
      .replace(/<style[^>]*>.*?<\/style>/gi, '')
      .replace(/<script[^>]*>.*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  /**
   * Check if provider is configured
   */
  isConfigured(): boolean {
    return !!(
      this.config.host &&
      this.config.port &&
      this.config.user &&
      this.config.password
    )
  }

  /**
   * Send an email via SMTP
   */
  async send(params: SendEmailParams): Promise<EmailResult> {
    const { to, subject, html, text, from, replyTo, cc, bcc } = params

    if (!from) {
      throw EmailError.configMissing('from address')
    }

    try {
      const transporter = await this.getTransporter()

      const mailOptions: any = {
        from: formatEmailAddress(from),
        to: this.formatRecipients(to),
        subject,
        html,
        text: text || this.stripHtml(html),
      }

      if (replyTo) {
        mailOptions.replyTo = formatEmailAddress(replyTo)
      }

      if (cc) {
        mailOptions.cc = this.formatRecipients(cc)
      }

      if (bcc) {
        mailOptions.bcc = this.formatRecipients(bcc)
      }

      const info = await transporter.sendMail(mailOptions)

      return {
        success: true,
        messageId: info.messageId,
      }
    } catch (error: any) {
      const errorMessage = error.message || 'Failed to send email'
      const errorCode = this.mapErrorCode(error)

      return {
        success: false,
        error: `[${errorCode}] ${errorMessage}`,
      }
    }
  }

  /**
   * Map nodemailer error to error code
   */
  private mapErrorCode(error: any): string {
    const code = error.code || error.errno || ''
    const message = (error.message || '').toLowerCase()

    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || message.includes('connection')) {
      return 'connection_error'
    }

    if (code === 'EAUTH' || message.includes('auth') || message.includes('credentials')) {
      return 'authentication_error'
    }

    if (message.includes('recipient') || message.includes('mailbox') || message.includes('not found')) {
      return 'invalid_recipient'
    }

    return 'send_failed'
  }
}

/**
 * Create SMTP provider from environment variables
 *
 * Required env vars:
 * - SMTP_HOST
 * - SMTP_PORT
 * - SMTP_USER
 * - SMTP_PASSWORD
 *
 * Optional:
 * - SMTP_SECURE (true/false)
 */
export function createSmtpProviderFromEnv(): SmtpProvider | null {
  const host = process.env.SMTP_HOST
  const port = process.env.SMTP_PORT
  const user = process.env.SMTP_USER
  const password = process.env.SMTP_PASSWORD

  if (!host || !port || !user || !password) {
    return null
  }

  return new SmtpProvider({
    host,
    port: parseInt(port, 10),
    user,
    password,
    secure: process.env.SMTP_SECURE === 'true' ? true : undefined,
  })
}
