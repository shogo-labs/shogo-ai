// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Email Channel Adapter (IMAP/SMTP)
 *
 * Receives emails via IMAP IDLE and sends responses via SMTP.
 * Uses imapflow for IMAP and nodemailer for SMTP.
 *
 * Config:
 *   imapHost, imapPort, smtpHost, smtpPort,
 *   username, password, folder (default: INBOX),
 *   fromAddress, tls (default: true)
 */

import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import type { ChannelAdapter, IncomingMessage, ChannelStatus } from '../types'

export class EmailAdapter implements ChannelAdapter {
  private imapClient: ImapFlow | null = null
  private smtpTransport: nodemailer.Transporter | null = null
  private messageHandler: ((msg: IncomingMessage) => void) | null = null
  private connected = false
  private error: string | undefined
  private config: Record<string, string> = {}
  private idleController: AbortController | null = null
  private polling = false
  /** Tracks the last email subject and messageId per sender for reply threading */
  private lastEmailContext = new Map<string, { subject: string; messageId?: string }>()

  async connect(config: Record<string, string>): Promise<void> {
    this.config = config

    const {
      imapHost, imapPort = '993',
      smtpHost, smtpPort = '587',
      username, password,
      folder = 'INBOX',
      fromAddress,
      tls = 'true',
    } = config

    if (!imapHost || !smtpHost || !username || !password) {
      throw new Error('Email channel requires imapHost, smtpHost, username, and password')
    }

    const useTls = tls !== 'false'

    // Set up IMAP
    this.imapClient = new ImapFlow({
      host: imapHost,
      port: parseInt(imapPort, 10),
      secure: useTls,
      auth: { user: username, pass: password },
      logger: false,
    })

    try {
      await this.imapClient.connect()
      console.log(`[Email] IMAP connected to ${imapHost}:${imapPort} as ${username}`)
    } catch (err: any) {
      this.error = `IMAP connection failed: ${err.message}`
      throw err
    }

    // Set up SMTP
    this.smtpTransport = nodemailer.createTransport({
      host: smtpHost,
      port: parseInt(smtpPort, 10),
      secure: parseInt(smtpPort, 10) === 465,
      auth: { user: username, pass: password },
    })

    try {
      await this.smtpTransport.verify()
      console.log(`[Email] SMTP connected to ${smtpHost}:${smtpPort}`)
    } catch (err: any) {
      this.error = `SMTP connection failed: ${err.message}`
      throw err
    }

    this.connected = true
    this.error = undefined
    this.startPolling(folder)
  }

  async disconnect(): Promise<void> {
    this.polling = false
    this.idleController?.abort()
    this.idleController = null

    if (this.imapClient) {
      try { await this.imapClient.logout() } catch {}
      this.imapClient = null
    }
    if (this.smtpTransport) {
      this.smtpTransport.close()
      this.smtpTransport = null
    }
    this.connected = false
    console.log('[Email] Disconnected')
  }

  async sendMessage(channelId: string, content: string): Promise<void> {
    if (!this.smtpTransport) throw new Error('SMTP not connected')

    const fromAddress = this.config.fromAddress || this.config.username

    // Extract subject from content if the agent included one (e.g. "Subject: ...\n\n...")
    let subject: string | undefined
    let body = content
    const subjectMatch = content.match(/^Subject:\s*(.+)\n\n?([\s\S]*)$/i)
    if (subjectMatch) {
      subject = subjectMatch[1].trim()
      body = subjectMatch[2].trim()
    }

    // Fall back to the last known subject from this email thread
    const ctx = this.lastEmailContext.get(channelId)
    if (!subject && ctx?.subject) {
      subject = ctx.subject.startsWith('Re:') ? ctx.subject : `Re: ${ctx.subject}`
    }

    const mailOptions: Record<string, any> = {
      from: fromAddress,
      to: channelId,
      subject: subject || 'Agent Response',
      text: body,
    }

    // Thread replies using In-Reply-To header
    if (ctx?.messageId) {
      mailOptions.inReplyTo = ctx.messageId
      mailOptions.references = ctx.messageId
    }

    await this.smtpTransport.sendMail(mailOptions)
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler
  }

  getStatus(): ChannelStatus {
    return {
      type: 'email',
      connected: this.connected,
      error: this.error,
      metadata: {
        imapHost: this.config.imapHost,
        username: this.config.username,
        folder: this.config.folder || 'INBOX',
      },
    }
  }

  private async startPolling(folder: string): Promise<void> {
    this.polling = true
    this.pollLoop(folder)
  }

  private async pollLoop(folder: string): Promise<void> {
    if (!this.imapClient || !this.polling) return

    try {
      const lock = await this.imapClient.getMailboxLock(folder)
      try {
        // Process any new unseen messages
        const unseen = this.imapClient.fetch({ seen: false }, {
          envelope: true,
          source: true,
          uid: true,
        })

        for await (const msg of unseen) {
          if (!this.polling) break

          const envelope = msg.envelope
          if (!envelope) continue

          const from = envelope.from?.[0]
          const senderEmail = from?.address || 'unknown'
          const senderName = from?.name || senderEmail
          const subject = envelope.subject || '(no subject)'

          let body = ''
          if (msg.source) {
            const raw = msg.source.toString()
            // Simple body extraction: take text after the headers
            const headerEnd = raw.indexOf('\r\n\r\n')
            if (headerEnd !== -1) {
              body = raw.substring(headerEnd + 4).trim()
            }
            // Truncate very long emails
            if (body.length > 10000) {
              body = body.substring(0, 10000) + '\n\n[Truncated]'
            }
          }

          // Store context for reply threading
          this.lastEmailContext.set(senderEmail, {
            subject,
            messageId: envelope.messageId || undefined,
          })

          const text = `[Email] Subject: ${subject}\nFrom: ${senderName} <${senderEmail}>\n\n${body}`

          if (this.messageHandler) {
            this.messageHandler({
              text,
              channelId: senderEmail,
              channelType: 'email',
              senderId: senderEmail,
              senderName,
              timestamp: envelope.date ? new Date(envelope.date).getTime() : Date.now(),
              metadata: { subject, messageId: envelope.messageId },
            })
          }

          // Mark as seen so we don't process it again
          if (msg.uid) {
            await this.imapClient!.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true })
          }
        }
      } finally {
        lock.release()
      }

      // IDLE: wait for new messages (up to 5 minutes, then re-poll)
      if (this.polling && this.imapClient) {
        try {
          await this.imapClient.idle()
        } catch (err: any) {
          if (err.name !== 'AbortError' && !err.message?.includes('abort')) {
            console.error('[Email] IDLE error:', err.message)
            this.error = err.message
          }
        }
      }
    } catch (err: any) {
      if (this.polling) {
        console.error('[Email] Polling error:', err.message)
        this.error = err.message
      }
    }

    // Continue polling loop
    if (this.polling) {
      setTimeout(() => this.pollLoop(folder), 1000)
    }
  }
}
