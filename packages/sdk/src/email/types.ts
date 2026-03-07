// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Email Module Types
 *
 * Type definitions for the email system.
 * Designed for simplicity - template strings with {{variable}} interpolation.
 */

// ============================================================================
// Email Address Types
// ============================================================================

/**
 * Email address - can be a simple string or object with name
 */
export type EmailAddress = string | { email: string; name?: string }

/**
 * Normalize email address to string format
 */
export function formatEmailAddress(address: EmailAddress): string {
  if (typeof address === 'string') {
    return address
  }
  return address.name ? `"${address.name}" <${address.email}>` : address.email
}

// ============================================================================
// Send Email Parameters
// ============================================================================

/**
 * Parameters for sending an email
 */
export interface SendEmailParams {
  /** Recipient email address(es) */
  to: EmailAddress | EmailAddress[]
  /** Email subject line */
  subject: string
  /** HTML content of the email */
  html: string
  /** Plain text content (auto-generated from HTML if not provided) */
  text?: string
  /** Sender email address (uses default from config if not specified) */
  from?: EmailAddress
  /** Reply-to address */
  replyTo?: EmailAddress
  /** CC recipients */
  cc?: EmailAddress | EmailAddress[]
  /** BCC recipients */
  bcc?: EmailAddress | EmailAddress[]
}

/**
 * Parameters for sending a templated email
 */
export interface SendTemplateParams<TData extends Record<string, unknown> = Record<string, unknown>> {
  /** Recipient email address(es) */
  to: EmailAddress | EmailAddress[]
  /** Template name */
  template: string
  /** Template data for variable interpolation */
  data: TData
  /** Sender email address (uses default from config if not specified) */
  from?: EmailAddress
  /** Reply-to address */
  replyTo?: EmailAddress
  /** CC recipients */
  cc?: EmailAddress | EmailAddress[]
  /** BCC recipients */
  bcc?: EmailAddress | EmailAddress[]
}

/**
 * Result from sending an email
 */
export interface EmailResult {
  /** Whether the email was sent successfully */
  success: boolean
  /** Message ID from the email provider (if successful) */
  messageId?: string
  /** Error message (if failed) */
  error?: string
}

// ============================================================================
// Provider Configuration
// ============================================================================

/**
 * Supported email providers
 */
export type EmailProviderType = 'smtp' | 'ses'

/**
 * SMTP configuration
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
  /** Use TLS/SSL (default: true for port 465, STARTTLS for others) */
  secure?: boolean
}

/**
 * AWS SES configuration
 */
export interface SesConfig {
  /** AWS region (e.g., 'us-east-1') */
  region: string
  /** AWS access key ID (optional if using IAM role) */
  accessKeyId?: string
  /** AWS secret access key (optional if using IAM role) */
  secretAccessKey?: string
}

/**
 * Email provider configuration
 */
export interface EmailConfig {
  /** Provider type */
  provider: EmailProviderType
  /** Default sender email address */
  defaultFrom: EmailAddress
  /** Provider-specific configuration */
  smtp?: SmtpConfig
  ses?: SesConfig
}

// ============================================================================
// Template Types
// ============================================================================

/**
 * Email template definition
 */
export interface EmailTemplate<TData extends Record<string, unknown> = Record<string, unknown>> {
  /** Template name (identifier) */
  name: string
  /** Subject line template (supports {{variable}} interpolation) */
  subject: string
  /** HTML body template (supports {{variable}} interpolation) */
  html: string
  /** Plain text body template (optional, auto-generated from HTML if not provided) */
  text?: string
  /** Default data values */
  defaults?: Partial<TData>
}

/**
 * Template registry type
 */
export type TemplateRegistry = Record<string, EmailTemplate>

// ============================================================================
// Email Service Interface
// ============================================================================

/**
 * Email service interface - the main API
 */
export interface IEmailService {
  /**
   * Send a raw email with explicit subject/body
   */
  send(params: SendEmailParams): Promise<EmailResult>

  /**
   * Send a templated email
   */
  sendTemplate<TData extends Record<string, unknown>>(
    params: SendTemplateParams<TData>
  ): Promise<EmailResult>

  /**
   * Register a custom template
   */
  registerTemplate<TData extends Record<string, unknown>>(
    template: EmailTemplate<TData>
  ): void

  /**
   * Check if the service is configured and ready
   */
  isConfigured(): boolean
}

// ============================================================================
// Provider Interface
// ============================================================================

/**
 * Email provider interface - implemented by SMTP, SES, etc.
 */
export interface IEmailProvider {
  /**
   * Send an email via this provider
   */
  send(params: SendEmailParams): Promise<EmailResult>

  /**
   * Check if provider is configured
   */
  isConfigured(): boolean
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Email error codes
 */
export type EmailErrorCode =
  | 'config_missing'
  | 'connection_error'
  | 'authentication_error'
  | 'invalid_recipient'
  | 'send_failed'
  | 'template_not_found'
  | 'provider_not_configured'

/**
 * Email error class
 */
export class EmailError extends Error {
  code: EmailErrorCode
  cause?: unknown

  constructor(code: EmailErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'EmailError'
    this.code = code
    this.cause = cause
  }

  static configMissing(field: string): EmailError {
    return new EmailError('config_missing', `Missing required config: ${field}`)
  }

  static templateNotFound(name: string): EmailError {
    return new EmailError('template_not_found', `Template not found: ${name}`)
  }

  static providerNotConfigured(): EmailError {
    return new EmailError('provider_not_configured', 'Email provider is not configured')
  }
}
