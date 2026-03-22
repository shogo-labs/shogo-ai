// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Email Providers
 *
 * Export all provider implementations and factory functions.
 */

export { SmtpProvider, createSmtpProviderFromEnv } from './smtp.js'
export { SesProvider, createSesProviderFromEnv } from './ses.js'
export { OciEmailProvider, createOciEmailProviderFromEnv } from './oci-email.js'

import type { IEmailProvider, EmailProviderType } from '../types.js'
import { createSmtpProviderFromEnv } from './smtp.js'
import { createSesProviderFromEnv } from './ses.js'
import { createOciEmailProviderFromEnv } from './oci-email.js'

/**
 * Auto-detect and create provider from environment variables.
 *
 * Detection order:
 * 1. EMAIL_PROVIDER env var (explicit selection)
 * 2. OCI_EMAIL_SMTP_HOST present → OCI Email Delivery provider
 * 3. SMTP_HOST present → generic SMTP provider
 * 4. SES_REGION or AWS_REGION present → SES provider
 *
 * @returns Provider instance or null if not configured
 */
export function createProviderFromEnv(): IEmailProvider | null {
  const explicitProvider = process.env.EMAIL_PROVIDER as EmailProviderType | undefined

  if (explicitProvider === 'smtp') {
    return createSmtpProviderFromEnv()
  }

  if (explicitProvider === 'ses') {
    return createSesProviderFromEnv()
  }

  if (explicitProvider === 'oci-email') {
    return createOciEmailProviderFromEnv()
  }

  // Auto-detect based on available env vars
  if (process.env.OCI_EMAIL_SMTP_HOST) {
    return createOciEmailProviderFromEnv()
  }

  if (process.env.SMTP_HOST) {
    return createSmtpProviderFromEnv()
  }

  if (process.env.SES_REGION || process.env.AWS_REGION) {
    return createSesProviderFromEnv()
  }

  return null
}
