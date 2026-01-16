/**
 * Email Service Types
 *
 * Pure type definitions for the email layer.
 * NO runtime imports - interface contract only.
 */

// ============================================================
// EMAIL ADDRESS TYPES
// ============================================================

/**
 * Email address with optional display name
 */
export interface EmailAddress {
  email: string
  name?: string
}

// ============================================================
// SEND EMAIL TYPES
// ============================================================

/**
 * Parameters for sending an email
 */
export interface SendEmailParams {
  /** Recipient email address */
  to: string | EmailAddress
  /** Email subject line */
  subject: string
  /** HTML content of the email */
  html: string
  /** Plain text content (optional, for email clients that don't support HTML) */
  text?: string
  /** Sender email address (optional, uses default from config if not specified) */
  from?: string | EmailAddress
}

/**
 * Result from sending an email
 */
export interface EmailResult {
  /** Whether the email was sent successfully */
  success: boolean
  /** Message ID from the email provider (if successful) */
  messageId?: string
  /** Error details (if failed) */
  error?: string
}

// ============================================================
// SMTP CONFIGURATION
// ============================================================

/**
 * SMTP server configuration
 */
export interface SmtpConfig {
  /** SMTP server hostname */
  host: string
  /** SMTP server port */
  port: number
  /** SMTP authentication username */
  user: string
  /** SMTP authentication password */
  password: string
  /** Default sender email address */
  fromEmail: string
  /** Default sender display name */
  fromName?: string
  /** Use TLS/SSL (default: true for port 465, STARTTLS for others) */
  secure?: boolean
}

// ============================================================
// ERROR TYPES
// ============================================================

/**
 * Email error codes
 */
export type EmailErrorCode =
  | "connection_error"
  | "authentication_error"
  | "invalid_recipient"
  | "send_failed"
  | "template_not_found"
  | "template_render_error"
  | "config_missing"
  | "service_unavailable"

/**
 * Email error class with error code
 */
export class EmailError extends Error {
  code: EmailErrorCode
  originalError?: unknown

  constructor(code: EmailErrorCode, message: string, originalError?: unknown) {
    super(message)
    this.name = "EmailError"
    this.code = code
    this.originalError = originalError
  }
}

/**
 * Type guard to check if error is an EmailError
 */
export function isEmailError(error: unknown): error is EmailError {
  return error instanceof EmailError
}

/**
 * Helper to create an EmailError
 */
export function createEmailError(
  code: EmailErrorCode,
  message: string,
  originalError?: unknown
): EmailError {
  return new EmailError(code, message, originalError)
}

// ============================================================
// SERVICE INTERFACE
// ============================================================

/**
 * Email service interface - contract for email providers
 *
 * Implementations:
 * - SmtpEmailService: Real SMTP integration via nodemailer
 * - MockEmailService: In-memory mock for testing
 *
 * Note: The email service is OPTIONAL in the environment.
 * If not configured, email-dependent features should gracefully
 * degrade (log warnings but don't throw errors).
 */
export interface IEmailService {
  /**
   * Send an email
   *
   * @param params - Email parameters (to, subject, html, etc.)
   * @returns Result with success status and messageId
   */
  sendEmail(params: SendEmailParams): Promise<EmailResult>

  /**
   * Check if the email service is configured and ready
   *
   * @returns true if service is ready to send emails
   */
  isConfigured(): boolean
}
