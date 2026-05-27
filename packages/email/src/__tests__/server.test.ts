// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it, beforeEach, mock } from 'bun:test'

// Mock nodemailer (so any SmtpProvider construction works without real SMTP)
const sendMailMock = mock(async () => ({ messageId: 'srv-msg-id' }))
const createTransportMock = mock(() => ({ sendMail: sendMailMock }))
mock.module('nodemailer', () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}))

// Mock @aws-sdk/client-ses (so SesProvider construction works)
class FakeSESClient { constructor(public config: any) {} send = async () => ({ MessageId: 'fake-ses' }) }
class FakeSendEmailCommand { constructor(public input: any) {} }
mock.module('@aws-sdk/client-ses', () => ({
  SESClient: FakeSESClient,
  SendEmailCommand: FakeSendEmailCommand,
}))

import { createEmail, createEmailOptional } from '../server.js'
import { EmailError } from '../types.js'

const ENV_KEYS = [
  'EMAIL_PROVIDER', 'EMAIL_FROM', 'SMTP_FROM_EMAIL', 'SES_FROM_EMAIL',
  'OCI_EMAIL_FROM_ADDRESS',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_SECURE',
  'AWS_REGION', 'SES_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'OCI_EMAIL_SMTP_HOST', 'OCI_EMAIL_SMTP_USER', 'OCI_EMAIL_SMTP_PASS',
  'OCI_EMAIL_SMTP_PORT',
]
let savedEnv: Record<string, string | undefined>
beforeEach(() => {
  savedEnv = {}
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  sendMailMock.mockClear()
  createTransportMock.mockClear()
})
const restoreEnv = () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]!
  }
}

describe('createEmail — explicit config', () => {
  it('builds an SMTP-backed service when config.provider=smtp + config.smtp set', () => {
    const svc = createEmail({
      config: {
        provider: 'smtp',
        smtp: { host: 'h', port: 587, user: 'u', password: 'p' },
      },
      defaultFrom: 'sender@example.com',
    })
    expect(svc.isConfigured()).toBe(true)
    restoreEnv()
  })

  it('builds an SES-backed service when config.provider=ses + config.ses set', () => {
    const svc = createEmail({
      config: {
        provider: 'ses',
        ses: { region: 'us-east-1' },
      },
      defaultFrom: 'sender@example.com',
    })
    expect(svc.isConfigured()).toBe(true)
    restoreEnv()
  })

  it('builds an OCI-backed service when config.provider=oci-email + config.ociEmail set', () => {
    const svc = createEmail({
      config: {
        provider: 'oci-email',
        ociEmail: { host: 'h', port: 587, user: 'u', password: 'p' },
      },
      defaultFrom: 'sender@example.com',
    })
    expect(svc.isConfigured()).toBe(true)
    restoreEnv()
  })

  it('throws providerNotConfigured when config.provider has no matching config block', () => {
    expect(() =>
      createEmail({
        config: { provider: 'smtp' } as any,
        defaultFrom: 'a@x.com',
      }),
    ).toThrow(EmailError)
    restoreEnv()
  })

  it('throws configMissing when no defaultFrom and no EMAIL_FROM env var', () => {
    expect(() =>
      createEmail({
        config: { provider: 'smtp', smtp: { host: 'h', port: 587, user: 'u', password: 'p' } },
      }),
    ).toThrow(EmailError)
    restoreEnv()
  })

  it('picks defaultFrom from config.defaultFrom when option not set', () => {
    const svc = createEmail({
      config: {
        provider: 'smtp',
        smtp: { host: 'h', port: 587, user: 'u', password: 'p' },
        defaultFrom: 'config-from@x.com',
      },
    })
    expect(svc.isConfigured()).toBe(true)
    restoreEnv()
  })

  it('falls through to EMAIL_FROM env var when neither option nor config has it', () => {
    process.env.EMAIL_FROM = 'env-from@x.com'
    const svc = createEmail({
      config: {
        provider: 'smtp',
        smtp: { host: 'h', port: 587, user: 'u', password: 'p' },
      },
    })
    expect(svc.isConfigured()).toBe(true)
    restoreEnv()
  })

  it('respects includeBuiltins=false', () => {
    const svc = createEmail({
      config: {
        provider: 'smtp',
        smtp: { host: 'h', port: 587, user: 'u', password: 'p' },
      },
      defaultFrom: 'a@x.com',
      includeBuiltins: false,
    })
    expect(svc.isConfigured()).toBe(true)
    restoreEnv()
  })
})

describe('createEmail — auto-detect from env', () => {
  it('uses SMTP_HOST env to pick SmtpProvider', () => {
    process.env.SMTP_HOST = 'h'
    process.env.SMTP_PORT = '587'
    process.env.SMTP_USER = 'u'
    process.env.SMTP_PASSWORD = 'p'
    process.env.SMTP_FROM_EMAIL = 'smtp-from@x.com'
    const svc = createEmail()
    expect(svc.isConfigured()).toBe(true)
    restoreEnv()
  })

  it('uses AWS_REGION env to pick SesProvider', () => {
    process.env.AWS_REGION = 'us-east-1'
    process.env.SES_FROM_EMAIL = 'ses-from@x.com'
    const svc = createEmail()
    expect(svc.isConfigured()).toBe(true)
    restoreEnv()
  })

  it('throws providerNotConfigured when no env vars and no config', () => {
    expect(() => createEmail()).toThrow(EmailError)
    restoreEnv()
  })
})

describe('createEmail — registerTemplate / send / sendTemplate', () => {
  const baseOpts = {
    config: {
      provider: 'smtp' as const,
      smtp: { host: 'h', port: 587, user: 'u', password: 'p' },
    },
    defaultFrom: 'default@x.com',
  }

  it('registers and renders a custom template via sendTemplate', async () => {
    const svc = createEmail(baseOpts)
    svc.registerTemplate({
      name: 'greet',
      subject: 'Hi {{name}}',
      html: '<p>Hello {{name}}</p>',
    } as any)
    const r = await svc.sendTemplate({
      to: 'b@y.com',
      template: 'greet',
      data: { name: 'World' },
    })
    expect(r.success).toBe(true)
    expect(sendMailMock).toHaveBeenCalledTimes(1)
    const args = sendMailMock.mock.calls[0][0] as any
    expect(args.subject).toBe('Hi World')
    expect(args.html).toContain('Hello World')
    restoreEnv()
  })

  it('send() applies defaultFrom when params.from is omitted', async () => {
    const svc = createEmail(baseOpts)
    await svc.send({ to: 'b@y.com', subject: 's', html: '<p>x</p>' } as any)
    const args = sendMailMock.mock.calls[0][0] as any
    expect(args.from).toBe('default@x.com')
    restoreEnv()
  })

  it('send() respects explicit from override', async () => {
    const svc = createEmail(baseOpts)
    await svc.send({ from: 'other@x.com', to: 'b@y.com', subject: 's', html: '<p>x</p>' })
    const args = sendMailMock.mock.calls[0][0] as any
    expect(args.from).toBe('other@x.com')
    restoreEnv()
  })
})

describe('createEmailOptional', () => {
  it('returns a service when env is configured', () => {
    process.env.SMTP_HOST = 'h'
    process.env.SMTP_PORT = '587'
    process.env.SMTP_USER = 'u'
    process.env.SMTP_PASSWORD = 'p'
    process.env.EMAIL_FROM = 'x@x.com'
    const svc = createEmailOptional()
    expect(svc).not.toBeNull()
    expect(svc!.isConfigured()).toBe(true)
    restoreEnv()
  })

  it('returns null when env is not configured', () => {
    expect(createEmailOptional()).toBeNull()
    restoreEnv()
  })
})
