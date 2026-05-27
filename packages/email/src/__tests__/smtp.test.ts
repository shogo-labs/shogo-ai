// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test'

// ---- Mock nodemailer at module scope so dynamic import() picks it up ----
const sendMailMock = mock(async (_opts: any) => ({ messageId: 'mock-msg-id' }))
const createTransportMock = mock((_opts: any) => ({ sendMail: sendMailMock }))

mock.module('nodemailer', () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}))

import { SmtpProvider, createSmtpProviderFromEnv } from '../providers/smtp.js'
import { EmailError } from '../types.js'

const baseConfig = {
  host: 'smtp.example.com',
  port: 587,
  user: 'user@example.com',
  password: 'secret',
}

describe('SmtpProvider', () => {
  beforeEach(() => {
    sendMailMock.mockClear()
    createTransportMock.mockClear()
    sendMailMock.mockImplementation(async () => ({ messageId: 'mock-msg-id' }))
  })

  describe('validateConfig (constructor)', () => {
    it('throws when host is missing', () => {
      expect(() => new SmtpProvider({ ...baseConfig, host: '' } as any))
        .toThrow(EmailError)
    })
    it('throws when port is missing (0)', () => {
      expect(() => new SmtpProvider({ ...baseConfig, port: 0 } as any))
        .toThrow(EmailError)
    })
    it('throws when user is missing', () => {
      expect(() => new SmtpProvider({ ...baseConfig, user: '' } as any))
        .toThrow(EmailError)
    })
    it('throws when password is missing', () => {
      expect(() => new SmtpProvider({ ...baseConfig, password: '' } as any))
        .toThrow(EmailError)
    })
    it('constructs with all fields present', () => {
      expect(() => new SmtpProvider(baseConfig)).not.toThrow()
    })
  })

  describe('isConfigured', () => {
    it('returns true when fully configured', () => {
      const p = new SmtpProvider(baseConfig)
      expect(p.isConfigured()).toBe(true)
    })
  })

  describe('getTransporter (via send)', () => {
    it('caches transporter — only creates one per provider', async () => {
      const p = new SmtpProvider(baseConfig)
      await p.send({ to: 'a@b.com', from: 'c@d.com', subject: 's', html: '<p>x</p>' })
      await p.send({ to: 'a@b.com', from: 'c@d.com', subject: 's', html: '<p>x</p>' })
      expect(createTransportMock).toHaveBeenCalledTimes(1)
    })
    it('uses secure=true when port is 465 by default', async () => {
      const p = new SmtpProvider({ ...baseConfig, port: 465 })
      await p.send({ to: 'a@b.com', from: 'c@d.com', subject: 's', html: '<p>x</p>' })
      expect(createTransportMock.mock.calls[0][0].secure).toBe(true)
    })
    it('uses secure=false when port is not 465 and not specified', async () => {
      const p = new SmtpProvider({ ...baseConfig, port: 587 })
      await p.send({ to: 'a@b.com', from: 'c@d.com', subject: 's', html: '<p>x</p>' })
      expect(createTransportMock.mock.calls[0][0].secure).toBe(false)
    })
    it('respects explicit secure=true override', async () => {
      const p = new SmtpProvider({ ...baseConfig, port: 587, secure: true })
      await p.send({ to: 'a@b.com', from: 'c@d.com', subject: 's', html: '<p>x</p>' })
      expect(createTransportMock.mock.calls[0][0].secure).toBe(true)
    })
    it('passes auth credentials through', async () => {
      const p = new SmtpProvider(baseConfig)
      await p.send({ to: 'a@b.com', from: 'c@d.com', subject: 's', html: '<p>x</p>' })
      expect(createTransportMock.mock.calls[0][0].auth).toEqual({
        user: 'user@example.com',
        pass: 'secret',
      })
    })
  })

  describe('send', () => {
    it('throws when from is missing', async () => {
      const p = new SmtpProvider(baseConfig)
      expect(p.send({ to: 'a@b.com', subject: 's', html: '<p>x</p>' } as any))
        .rejects.toThrow(EmailError)
    })

    it('returns success with messageId on happy path', async () => {
      const p = new SmtpProvider(baseConfig)
      const result = await p.send({
        to: 'a@b.com', from: 'c@d.com', subject: 's', html: '<p>hi</p>',
      })
      expect(result).toEqual({ success: true, messageId: 'mock-msg-id' })
    })

    it('formats from address with name', async () => {
      const p = new SmtpProvider(baseConfig)
      await p.send({
        to: 'a@b.com',
        from: { email: 'sender@ex.com', name: 'Sender' },
        subject: 's', html: '<p>x</p>',
      })
      expect(sendMailMock.mock.calls[0][0].from).toBe('"Sender" <sender@ex.com>')
    })

    it('joins multiple recipients with comma', async () => {
      const p = new SmtpProvider(baseConfig)
      await p.send({
        to: ['a@b.com', { email: 'c@d.com', name: 'Cee' }],
        from: 'x@y.com', subject: 's', html: '<p>x</p>',
      })
      expect(sendMailMock.mock.calls[0][0].to).toBe('a@b.com, "Cee" <c@d.com>')
    })

    it('auto-derives text from html when text not provided', async () => {
      const p = new SmtpProvider(baseConfig)
      await p.send({
        to: 'a@b.com', from: 'c@d.com', subject: 's',
        html: '<style>p{color:red}</style><script>alert(1)</script><p>Hello   <b>World</b></p>',
      })
      expect(sendMailMock.mock.calls[0][0].text).toBe('Hello World')
    })

    it('uses provided text verbatim when supplied', async () => {
      const p = new SmtpProvider(baseConfig)
      await p.send({
        to: 'a@b.com', from: 'c@d.com', subject: 's',
        html: '<p>html</p>', text: 'plain text',
      })
      expect(sendMailMock.mock.calls[0][0].text).toBe('plain text')
    })

    it('includes replyTo when provided', async () => {
      const p = new SmtpProvider(baseConfig)
      await p.send({
        to: 'a@b.com', from: 'c@d.com', subject: 's', html: '<p>x</p>',
        replyTo: { email: 'r@y.com', name: 'Reply' },
      })
      expect(sendMailMock.mock.calls[0][0].replyTo).toBe('"Reply" <r@y.com>')
    })

    it('includes cc when provided', async () => {
      const p = new SmtpProvider(baseConfig)
      await p.send({
        to: 'a@b.com', from: 'c@d.com', subject: 's', html: '<p>x</p>',
        cc: ['cc1@y.com', 'cc2@y.com'],
      })
      expect(sendMailMock.mock.calls[0][0].cc).toBe('cc1@y.com, cc2@y.com')
    })

    it('includes bcc when provided', async () => {
      const p = new SmtpProvider(baseConfig)
      await p.send({
        to: 'a@b.com', from: 'c@d.com', subject: 's', html: '<p>x</p>',
        bcc: 'bcc@y.com',
      })
      expect(sendMailMock.mock.calls[0][0].bcc).toBe('bcc@y.com')
    })

    describe('error mapping', () => {
      const callSend = async () => {
        const p = new SmtpProvider(baseConfig)
        return p.send({ to: 'a@b.com', from: 'c@d.com', subject: 's', html: '<p>x</p>' })
      }

      it('maps ECONNREFUSED to connection_error', async () => {
        sendMailMock.mockImplementationOnce(async () => {
          const e: any = new Error('refused'); e.code = 'ECONNREFUSED'; throw e
        })
        const r = await callSend()
        expect(r.success).toBe(false)
        expect(r.error).toContain('[connection_error]')
      })

      it('maps ENOTFOUND to connection_error', async () => {
        sendMailMock.mockImplementationOnce(async () => {
          const e: any = new Error('dns fail'); e.code = 'ENOTFOUND'; throw e
        })
        expect((await callSend()).error).toContain('[connection_error]')
      })

      it('maps "connection" in message to connection_error', async () => {
        sendMailMock.mockImplementationOnce(async () => { throw new Error('connection reset by peer') })
        expect((await callSend()).error).toContain('[connection_error]')
      })

      it('maps EAUTH to authentication_error', async () => {
        sendMailMock.mockImplementationOnce(async () => {
          const e: any = new Error('bad auth'); e.code = 'EAUTH'; throw e
        })
        expect((await callSend()).error).toContain('[authentication_error]')
      })

      it('maps "credentials" in message to authentication_error', async () => {
        sendMailMock.mockImplementationOnce(async () => { throw new Error('invalid credentials provided') })
        expect((await callSend()).error).toContain('[authentication_error]')
      })

      it('maps "recipient" in message to invalid_recipient', async () => {
        sendMailMock.mockImplementationOnce(async () => { throw new Error('recipient rejected') })
        expect((await callSend()).error).toContain('[invalid_recipient]')
      })

      it('maps "mailbox" in message to invalid_recipient', async () => {
        sendMailMock.mockImplementationOnce(async () => { throw new Error('mailbox unavailable') })
        expect((await callSend()).error).toContain('[invalid_recipient]')
      })

      it('maps "not found" in message to invalid_recipient', async () => {
        sendMailMock.mockImplementationOnce(async () => { throw new Error('user not found') })
        expect((await callSend()).error).toContain('[invalid_recipient]')
      })

      it('falls back to send_failed for unknown errors', async () => {
        sendMailMock.mockImplementationOnce(async () => { throw new Error('something weird') })
        expect((await callSend()).error).toContain('[send_failed]')
      })

      it('falls back to "Failed to send email" when error has no message', async () => {
        sendMailMock.mockImplementationOnce(async () => { throw { code: 'X' } as any })
        expect((await callSend()).error).toContain('Failed to send email')
      })

      it('uses errno when code is absent', async () => {
        sendMailMock.mockImplementationOnce(async () => {
          const e: any = new Error('refused'); e.errno = 'ECONNREFUSED'; throw e
        })
        expect((await callSend()).error).toContain('[connection_error]')
      })
    })
  })
})

describe('createSmtpProviderFromEnv', () => {
  let saved: Record<string, string | undefined>
  beforeEach(() => {
    saved = {
      SMTP_HOST: process.env.SMTP_HOST,
      SMTP_PORT: process.env.SMTP_PORT,
      SMTP_USER: process.env.SMTP_USER,
      SMTP_PASSWORD: process.env.SMTP_PASSWORD,
      SMTP_SECURE: process.env.SMTP_SECURE,
    }
    delete process.env.SMTP_HOST
    delete process.env.SMTP_PORT
    delete process.env.SMTP_USER
    delete process.env.SMTP_PASSWORD
    delete process.env.SMTP_SECURE
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('returns null when SMTP_HOST is missing', () => {
    process.env.SMTP_PORT = '587'
    process.env.SMTP_USER = 'u'
    process.env.SMTP_PASSWORD = 'p'
    expect(createSmtpProviderFromEnv()).toBeNull()
  })
  it('returns null when SMTP_PORT is missing', () => {
    process.env.SMTP_HOST = 'h'
    process.env.SMTP_USER = 'u'
    process.env.SMTP_PASSWORD = 'p'
    expect(createSmtpProviderFromEnv()).toBeNull()
  })
  it('returns null when SMTP_USER is missing', () => {
    process.env.SMTP_HOST = 'h'
    process.env.SMTP_PORT = '587'
    process.env.SMTP_PASSWORD = 'p'
    expect(createSmtpProviderFromEnv()).toBeNull()
  })
  it('returns null when SMTP_PASSWORD is missing', () => {
    process.env.SMTP_HOST = 'h'
    process.env.SMTP_PORT = '587'
    process.env.SMTP_USER = 'u'
    expect(createSmtpProviderFromEnv()).toBeNull()
  })
  it('returns a SmtpProvider when all env vars are set', () => {
    process.env.SMTP_HOST = 'h'
    process.env.SMTP_PORT = '587'
    process.env.SMTP_USER = 'u'
    process.env.SMTP_PASSWORD = 'p'
    const p = createSmtpProviderFromEnv()
    expect(p).toBeInstanceOf(SmtpProvider)
  })
  it('sets secure=true when SMTP_SECURE === "true"', async () => {
    process.env.SMTP_HOST = 'h'
    process.env.SMTP_PORT = '587'
    process.env.SMTP_USER = 'u'
    process.env.SMTP_PASSWORD = 'p'
    process.env.SMTP_SECURE = 'true'
    const p = createSmtpProviderFromEnv()!
    createTransportMock.mockClear()
    await p.send({ to: 'a@b.com', from: 'c@d.com', subject: 's', html: '<p>x</p>' })
    expect(createTransportMock.mock.calls[0][0].secure).toBe(true)
  })
  it('parses SMTP_PORT as integer', () => {
    process.env.SMTP_HOST = 'h'
    process.env.SMTP_PORT = '465'
    process.env.SMTP_USER = 'u'
    process.env.SMTP_PASSWORD = 'p'
    const p = createSmtpProviderFromEnv()
    expect(p).toBeInstanceOf(SmtpProvider)
  })
})
