/**
 * SMTP Email Service
 *
 * Real implementation of IEmailService using nodemailer.
 * Supports any standard SMTP server (SendGrid, Mailgun, AWS SES, etc.)
 */

import nodemailer from "nodemailer"
import type {
  IEmailService,
  SendEmailParams,
  EmailResult,
  SmtpConfig,
  EmailAddress,
} from "./types"
import { EmailError } from "./types"

/**
 * SmtpEmailService implements IEmailService with nodemailer SMTP integration.
 *
 * Usage:
 * ```typescript
 * const service = new SmtpEmailService({
 *   host: 'smtp.example.com',
 *   port: 587,
 *   user: 'user@example.com',
 *   password: 'password',
 *   fromEmail: 'noreply@example.com',
 *   fromName: 'My App'
 * })
 *
 * const result = await service.sendEmail({
 *   to: 'recipient@example.com',
 *   subject: 'Hello',
 *   html: '<h1>Hello World</h1>'
 * })
 * ```
 */
export class SmtpEmailService implements IEmailService {
  private transporter: nodemailer.Transporter
  private config: SmtpConfig

  constructor(config: SmtpConfig) {
    // Validate required config fields (fail fast)
    this.validateConfig(config)
    this.config = config

    // Create nodemailer transporter
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure ?? config.port === 465, // Use TLS for port 465
      auth: {
        user: config.user,
        pass: config.password,
      },
    })
  }

  /**
   * Validate required config fields, throw immediately if missing
   */
  private validateConfig(config: SmtpConfig): void {
    const required: (keyof SmtpConfig)[] = ["host", "port", "user", "password", "fromEmail"]

    for (const field of required) {
      if (!config[field]) {
        throw new EmailError(
          "config_missing",
          `SMTP configuration missing required field: ${field}`
        )
      }
    }
  }

  /**
   * Check if the email service is configured and ready
   */
  isConfigured(): boolean {
    return !!(
      this.config.host &&
      this.config.port &&
      this.config.user &&
      this.config.password &&
      this.config.fromEmail
    )
  }

  /**
   * Format email address for nodemailer
   */
  private formatAddress(address: string | EmailAddress): string {
    if (typeof address === "string") {
      return address
    }
    return address.name ? `"${address.name}" <${address.email}>` : address.email
  }

  /**
   * Send an email via SMTP
   */
  async sendEmail(params: SendEmailParams): Promise<EmailResult> {
    const { to, subject, html, text, from } = params

    // Determine sender address
    const fromAddress = from
      ? this.formatAddress(from)
      : this.config.fromName
        ? `"${this.config.fromName}" <${this.config.fromEmail}>`
        : this.config.fromEmail

    try {
      const info = await this.transporter.sendMail({
        from: fromAddress,
        to: this.formatAddress(to),
        subject,
        html,
        text: text || this.stripHtml(html), // Generate plain text if not provided
      })

      return {
        success: true,
        messageId: info.messageId,
      }
    } catch (error: any) {
      // Map nodemailer errors to EmailError codes
      const errorCode = this.mapErrorCode(error)
      const errorMessage = error.message || "Failed to send email"

      return {
        success: false,
        error: errorMessage,
      }
    }
  }

  /**
   * Map nodemailer error to EmailErrorCode
   */
  private mapErrorCode(error: any): string {
    const code = error.code || error.errno || ""
    const message = (error.message || "").toLowerCase()

    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || message.includes("connection")) {
      return "connection_error"
    }

    if (code === "EAUTH" || message.includes("auth") || message.includes("credentials")) {
      return "authentication_error"
    }

    if (message.includes("recipient") || message.includes("mailbox") || message.includes("not found")) {
      return "invalid_recipient"
    }

    return "send_failed"
  }

  /**
   * Strip HTML tags to create plain text version
   */
  private stripHtml(html: string): string {
    return html
      .replace(/<style[^>]*>.*?<\/style>/gi, "")
      .replace(/<script[^>]*>.*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim()
  }
}

/**
 * Create an SmtpEmailService from environment variables.
 *
 * Required environment variables:
 * - SMTP_HOST: SMTP server hostname
 * - SMTP_PORT: SMTP server port
 * - SMTP_USER: SMTP authentication username
 * - SMTP_PASSWORD: SMTP authentication password
 * - SMTP_FROM_EMAIL: Default sender email address
 *
 * Optional:
 * - SMTP_FROM_NAME: Default sender display name
 * - SMTP_SECURE: Use TLS/SSL (default: auto based on port)
 *
 * Returns null if SMTP is not configured, allowing graceful degradation.
 */
export function createSmtpEmailServiceFromEnv(): SmtpEmailService | null {
  const host = process.env.SMTP_HOST
  const port = process.env.SMTP_PORT
  const user = process.env.SMTP_USER
  const password = process.env.SMTP_PASSWORD
  const fromEmail = process.env.SMTP_FROM_EMAIL

  // Return null if SMTP is not configured (graceful degradation)
  if (!host || !port || !user || !password || !fromEmail) {
    return null
  }

  const config: SmtpConfig = {
    host,
    port: parseInt(port, 10),
    user,
    password,
    fromEmail,
    fromName: process.env.SMTP_FROM_NAME,
    secure: process.env.SMTP_SECURE === "true" ? true : undefined,
  }

  return new SmtpEmailService(config)
}
