// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it, beforeEach, mock } from 'bun:test'

// ---- Mock @aws-sdk/client-ses at module scope ----
let lastSendInput: any = null
let nextSendBehavior: 'ok' | 'throw' = 'ok'
let nextMessageId = 'ses-msg-123'
const sendMock = mock(async (cmd: any) => {
  lastSendInput = cmd
  if (nextSendBehavior === 'throw') {
    const err: any = new Error('SES network failure')
    throw err
  }
  return { MessageId: nextMessageId }
})
class FakeSESClient {
  constructor(public config: any) {}
  send = sendMock
}
class FakeSendEmailCommand {
  constructor(public input: any) {}
}
mock.module('@aws-sdk/client-ses', () => ({
  SESClient: FakeSESClient,
  SendEmailCommand: FakeSendEmailCommand,
}))

import { SesProvider, createSesProviderFromEnv } from '../providers/ses.js'
import { EmailError } from '../types.js'

describe('SesProvider', () => {
  beforeEach(() => {
    sendMock.mockClear()
    lastSendInput = null
    nextSendBehavior = 'ok'
    nextMessageId = 'ses-msg-123'
  })

  describe('constructor / validateConfig', () => {
    it('throws when region is missing', () => {
      expect(() => new SesProvider({ region: '' } as any)).toThrow(EmailError)
    })
    it('constructs with region only', () => {
      const p = new SesProvider({ region: 'us-east-1' })
      expect(p.isConfigured()).toBe(true)
    })
    it('isConfigured returns false when region somehow empty post-construct', () => {
      const p = new SesProvider({ region: 'us-east-1' })
      ;(p as any).config.region = ''
      expect(p.isConfigured()).toBe(false)
    })
  })

  describe('getClient lazy loading', () => {
    it('lazy-instantiates SESClient with credentials when provided', async () => {
      const p = new SesProvider({
        region: 'us-west-2',
        accessKeyId: 'AKIA',
        secretAccessKey: 'SECRET',
      })
      await p.send({ from: 'a@x.com', to: 'b@y.com', subject: 's', html: '<p>x</p>' })
      const c = (p as any).client as FakeSESClient
      expect(c.config.region).toBe('us-west-2')
      expect(c.config.credentials).toEqual({
        accessKeyId: 'AKIA',
        secretAccessKey: 'SECRET',
      })
    })
    it('omits credentials when not provided (uses default chain)', async () => {
      const p = new SesProvider({ region: 'us-west-2' })
      await p.send({ from: 'a@x.com', to: 'b@y.com', subject: 's', html: '<p>x</p>' })
      const c = (p as any).client as FakeSESClient
      expect(c.config.credentials).toBeUndefined()
    })
    it('reuses cached client across multiple send() calls', async () => {
      const p = new SesProvider({ region: 'us-west-2' })
      await p.send({ from: 'a@x.com', to: 'b@y.com', subject: 's', html: '<p>x</p>' })
      const c1 = (p as any).client
      await p.send({ from: 'a@x.com', to: 'b@y.com', subject: 's2', html: '<p>x</p>' })
      const c2 = (p as any).client
      expect(c1).toBe(c2)
    })
  })

  describe('send() happy paths', () => {
    it('returns success + MessageId on a basic send', async () => {
      const p = new SesProvider({ region: 'us-east-1' })
      const r = await p.send({
        from: 'sender@x.com',
        to: 'rcpt@y.com',
        subject: 'hi',
        html: '<h1>Hello</h1><p>World</p>',
      })
      expect(r).toEqual({ success: true, messageId: 'ses-msg-123' })
      expect(lastSendInput.input.Source).toBe('sender@x.com')
      expect(lastSendInput.input.Destination).toEqual({ ToAddresses: ['rcpt@y.com'] })
      expect(lastSendInput.input.Message.Subject.Data).toBe('hi')
      expect(lastSendInput.input.Message.Body.Html.Data).toBe('<h1>Hello</h1><p>World</p>')
      expect(lastSendInput.input.Message.Body.Text.Data).toBe('HelloWorld')
      expect(lastSendInput.input.ReplyToAddresses).toBeUndefined()
    })

    it('formats {email,name} sender as quoted', async () => {
      const p = new SesProvider({ region: 'us-east-1' })
      await p.send({
        from: { email: 's@x.com', name: 'Sender Name' },
        to: 'rcpt@y.com',
        subject: 'hi',
        html: '<p>x</p>',
      })
      expect(lastSendInput.input.Source).toBe('"Sender Name" <s@x.com>')
    })

    it('handles array of recipients', async () => {
      const p = new SesProvider({ region: 'us-east-1' })
      await p.send({
        from: 'a@x.com',
        to: ['r1@y.com', { email: 'r2@y.com', name: 'R2' }],
        subject: 'hi',
        html: '<p>x</p>',
      })
      expect(lastSendInput.input.Destination.ToAddresses).toEqual(['r1@y.com', 'r2@y.com'])
    })

    it('includes cc and bcc addresses', async () => {
      const p = new SesProvider({ region: 'us-east-1' })
      await p.send({
        from: 'a@x.com',
        to: 'b@y.com',
        cc: 'c@y.com',
        bcc: ['b1@y.com', 'b2@y.com'],
        subject: 'hi',
        html: '<p>x</p>',
      })
      expect(lastSendInput.input.Destination.CcAddresses).toEqual(['c@y.com'])
      expect(lastSendInput.input.Destination.BccAddresses).toEqual(['b1@y.com', 'b2@y.com'])
    })

    it('uses provided text when set, skipping stripHtml', async () => {
      const p = new SesProvider({ region: 'us-east-1' })
      await p.send({
        from: 'a@x.com',
        to: 'b@y.com',
        subject: 'hi',
        html: '<h1>Hi</h1>',
        text: 'PLAIN OVERRIDE',
      })
      expect(lastSendInput.input.Message.Body.Text.Data).toBe('PLAIN OVERRIDE')
    })

    it('includes replyTo when provided', async () => {
      const p = new SesProvider({ region: 'us-east-1' })
      await p.send({
        from: 'a@x.com',
        to: 'b@y.com',
        subject: 'hi',
        html: '<p>x</p>',
        replyTo: { email: 'r@x.com', name: 'Reply' },
      })
      expect(lastSendInput.input.ReplyToAddresses).toEqual(['"Reply" <r@x.com>'])
    })

    it('strips <style> and <script> tags inside stripHtml', async () => {
      const p = new SesProvider({ region: 'us-east-1' })
      await p.send({
        from: 'a@x.com',
        to: 'b@y.com',
        subject: 'hi',
        html: '<style>body{color:red}</style><script>alert(1)</script><p>Visible</p>',
      })
      expect(lastSendInput.input.Message.Body.Text.Data).toBe('Visible')
    })
  })

  describe('send() error paths', () => {
    it('throws EmailError when from is missing', async () => {
      const p = new SesProvider({ region: 'us-east-1' })
      await expect(p.send({ to: 'b@y.com', subject: 's', html: '<p>x</p>' } as any))
        .rejects.toThrow(EmailError)
    })
    it('returns {success:false, error:[ses_error] ...} when SDK rejects', async () => {
      nextSendBehavior = 'throw'
      const p = new SesProvider({ region: 'us-east-1' })
      const r = await p.send({
        from: 'a@x.com', to: 'b@y.com', subject: 's', html: '<p>x</p>',
      })
      expect(r.success).toBe(false)
      expect(r.error).toContain('[ses_error]')
      expect(r.error).toContain('SES network failure')
    })
    it('falls back to default error message when thrown value has no .message', async () => {
      sendMock.mockImplementationOnce(async () => { throw {} as any })
      const p = new SesProvider({ region: 'us-east-1' })
      const r = await p.send({ from: 'a@x.com', to: 'b@y.com', subject: 's', html: '<p>x</p>' })
      expect(r.success).toBe(false)
      expect(r.error).toBe('[ses_error] Failed to send email')
    })
  })
})

describe('createSesProviderFromEnv', () => {
  let savedEnv: Record<string, string | undefined>
  beforeEach(() => {
    savedEnv = {
      AWS_REGION: process.env.AWS_REGION,
      SES_REGION: process.env.SES_REGION,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    }
    delete process.env.AWS_REGION
    delete process.env.SES_REGION
    delete process.env.AWS_ACCESS_KEY_ID
    delete process.env.AWS_SECRET_ACCESS_KEY
  })
  const restore = () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete (process.env as any)[k]
      else (process.env as any)[k] = v
    }
  }

  it('returns null when no region env var is set', () => {
    expect(createSesProviderFromEnv()).toBeNull()
    restore()
  })

  it('uses SES_REGION when set (preferred over AWS_REGION)', () => {
    process.env.SES_REGION = 'eu-west-1'
    process.env.AWS_REGION = 'us-east-1'
    const p = createSesProviderFromEnv()
    expect(p).toBeInstanceOf(SesProvider)
    expect((p as any).config.region).toBe('eu-west-1')
    restore()
  })

  it('falls back to AWS_REGION when SES_REGION not set', () => {
    process.env.AWS_REGION = 'us-east-2'
    const p = createSesProviderFromEnv()
    expect((p as any).config.region).toBe('us-east-2')
    restore()
  })

  it('passes credentials when both env vars present', () => {
    process.env.AWS_REGION = 'us-east-1'
    process.env.AWS_ACCESS_KEY_ID = 'AKIAFOO'
    process.env.AWS_SECRET_ACCESS_KEY = 'BAR'
    const p = createSesProviderFromEnv()
    expect((p as any).config.accessKeyId).toBe('AKIAFOO')
    expect((p as any).config.secretAccessKey).toBe('BAR')
    restore()
  })
})
