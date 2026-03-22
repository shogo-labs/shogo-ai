// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * OCI Email Delivery Provider
 *
 * Uses OCI Email Delivery's SMTP interface via nodemailer.
 * OCI Email Delivery is standard SMTP, so this delegates to SmtpProvider
 * with OCI-specific configuration and env var names.
 *
 * @see https://docs.oracle.com/en-us/iaas/Content/Email/home.htm
 */

import type {
  IEmailProvider,
  SendEmailParams,
  EmailResult,
} from '../types.js'
import { SmtpProvider } from './smtp.js'

export interface OciEmailConfig {
  host: string
  port: number
  user: string
  password: string
  fromAddress?: string
}

/**
 * OCI Email Delivery provider — thin wrapper over SmtpProvider
 * with OCI-specific defaults (port 587, STARTTLS).
 */
export class OciEmailProvider implements IEmailProvider {
  private smtp: SmtpProvider
  private fromAddress?: string

  constructor(config: OciEmailConfig) {
    this.fromAddress = config.fromAddress
    this.smtp = new SmtpProvider({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      secure: config.port === 465,
    })
  }

  isConfigured(): boolean {
    return this.smtp.isConfigured()
  }

  async send(params: SendEmailParams): Promise<EmailResult> {
    const effective: SendEmailParams = {
      ...params,
      from: params.from ?? this.fromAddress,
    }
    return this.smtp.send(effective)
  }
}

/**
 * Create OCI Email Delivery provider from environment variables.
 *
 * Required:
 *   OCI_EMAIL_SMTP_HOST
 *   OCI_EMAIL_SMTP_USER
 *   OCI_EMAIL_SMTP_PASS
 *
 * Optional:
 *   OCI_EMAIL_SMTP_PORT  (default: 587)
 *   OCI_EMAIL_FROM_ADDRESS
 */
export function createOciEmailProviderFromEnv(): OciEmailProvider | null {
  const host = process.env.OCI_EMAIL_SMTP_HOST
  const user = process.env.OCI_EMAIL_SMTP_USER
  const password = process.env.OCI_EMAIL_SMTP_PASS

  if (!host || !user || !password) {
    return null
  }

  const port = parseInt(process.env.OCI_EMAIL_SMTP_PORT || '587', 10)

  return new OciEmailProvider({
    host,
    port,
    user,
    password,
    fromAddress: process.env.OCI_EMAIL_FROM_ADDRESS,
  })
}
