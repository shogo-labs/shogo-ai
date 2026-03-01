/**
 * AWS SES Email Provider
 *
 * Uses AWS SDK v3 to send emails via SES API directly.
 * More efficient than SMTP for high-volume sending.
 */

import type {
  IEmailProvider,
  SendEmailParams,
  EmailResult,
  SesConfig,
  EmailAddress,
} from '../types.js'
import { EmailError, formatEmailAddress } from '../types.js'

/**
 * AWS SES provider implementation using AWS SDK v3
 */
export class SesProvider implements IEmailProvider {
  private config: SesConfig
  private client: any // SESClient - lazy loaded

  constructor(config: SesConfig) {
    this.validateConfig(config)
    this.config = config
  }

  /**
   * Validate required config fields
   */
  private validateConfig(config: SesConfig): void {
    if (!config.region) {
      throw EmailError.configMissing('ses.region')
    }
  }

  /**
   * Lazy-load AWS SDK and create client
   */
  private async getClient(): Promise<any> {
    if (this.client) {
      return this.client
    }

    // Dynamic import to avoid bundling AWS SDK in client builds
    const { SESClient } = await import('@aws-sdk/client-ses')

    const clientConfig: any = {
      region: this.config.region,
    }

    // Only set credentials if explicitly provided
    // Otherwise, SDK will use default credential chain (IAM role, env vars, etc.)
    if (this.config.accessKeyId && this.config.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      }
    }

    this.client = new SESClient(clientConfig)
    return this.client
  }

  /**
   * Format recipients as array of strings
   */
  private formatRecipients(addresses: EmailAddress | EmailAddress[]): string[] {
    const list = Array.isArray(addresses) ? addresses : [addresses]
    return list.map((addr) =>
      typeof addr === 'string' ? addr : addr.email
    )
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
    return !!this.config.region
  }

  /**
   * Send an email via SES
   */
  async send(params: SendEmailParams): Promise<EmailResult> {
    const { to, subject, html, text, from, replyTo, cc, bcc } = params

    if (!from) {
      throw EmailError.configMissing('from address')
    }

    try {
      const client = await this.getClient()
      const { SendEmailCommand } = await import('@aws-sdk/client-ses')

      const destination: any = {
        ToAddresses: this.formatRecipients(to),
      }

      if (cc) {
        destination.CcAddresses = this.formatRecipients(cc)
      }

      if (bcc) {
        destination.BccAddresses = this.formatRecipients(bcc)
      }

      const command = new SendEmailCommand({
        Source: formatEmailAddress(from),
        Destination: destination,
        Message: {
          Subject: {
            Data: subject,
            Charset: 'UTF-8',
          },
          Body: {
            Html: {
              Data: html,
              Charset: 'UTF-8',
            },
            Text: {
              Data: text || this.stripHtml(html),
              Charset: 'UTF-8',
            },
          },
        },
        ReplyToAddresses: replyTo ? [formatEmailAddress(replyTo)] : undefined,
      })

      const response = await client.send(command)

      return {
        success: true,
        messageId: response.MessageId,
      }
    } catch (error: any) {
      const errorMessage = error.message || 'Failed to send email'

      return {
        success: false,
        error: `[ses_error] ${errorMessage}`,
      }
    }
  }
}

/**
 * Create SES provider from environment variables
 *
 * Required env vars:
 * - AWS_REGION (or SES_REGION)
 *
 * Optional (uses default credential chain if not set):
 * - AWS_ACCESS_KEY_ID
 * - AWS_SECRET_ACCESS_KEY
 */
export function createSesProviderFromEnv(): SesProvider | null {
  const region = process.env.SES_REGION || process.env.AWS_REGION

  if (!region) {
    return null
  }

  return new SesProvider({
    region,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  })
}
