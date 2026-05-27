// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it, beforeEach, mock } from 'bun:test'

const sendMailMock = mock(async () => ({ messageId: 'idx-id' }))
const createTransportMock = mock(() => ({ sendMail: sendMailMock }))
mock.module('nodemailer', () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}))
class FakeSESClient { constructor(public config: any) {} send = async () => ({ MessageId: 'x' }) }
class FakeSendEmailCommand { constructor(public input: any) {} }
mock.module('@aws-sdk/client-ses', () => ({
  SESClient: FakeSESClient,
  SendEmailCommand: FakeSendEmailCommand,
}))

import { createProviderFromEnv } from '../providers/index.js'
import { SmtpProvider } from '../providers/smtp.js'
import { SesProvider } from '../providers/ses.js'
import { OciEmailProvider } from '../providers/oci-email.js'

const KEYS = [
  'EMAIL_PROVIDER',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD',
  'AWS_REGION', 'SES_REGION',
  'OCI_EMAIL_SMTP_HOST', 'OCI_EMAIL_SMTP_USER', 'OCI_EMAIL_SMTP_PASS',
]
let saved: Record<string, string | undefined>
beforeEach(() => {
  saved = {}
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] }
})
const restore = () => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]!
  }
}

describe('createProviderFromEnv', () => {
  it('returns null when no env vars are set', () => {
    expect(createProviderFromEnv()).toBeNull()
    restore()
  })

  it('EMAIL_PROVIDER=smtp picks SmtpProvider when SMTP_* env present', () => {
    process.env.EMAIL_PROVIDER = 'smtp'
    process.env.SMTP_HOST = 'h'
    process.env.SMTP_PORT = '587'
    process.env.SMTP_USER = 'u'
    process.env.SMTP_PASSWORD = 'p'
    const p = createProviderFromEnv()
    expect(p).toBeInstanceOf(SmtpProvider)
    restore()
  })

  it('EMAIL_PROVIDER=ses picks SesProvider when SES_REGION env present', () => {
    process.env.EMAIL_PROVIDER = 'ses'
    process.env.SES_REGION = 'us-east-1'
    const p = createProviderFromEnv()
    expect(p).toBeInstanceOf(SesProvider)
    restore()
  })

  it('EMAIL_PROVIDER=oci-email picks OciEmailProvider when OCI_* env present', () => {
    process.env.EMAIL_PROVIDER = 'oci-email'
    process.env.OCI_EMAIL_SMTP_HOST = 'h'
    process.env.OCI_EMAIL_SMTP_USER = 'u'
    process.env.OCI_EMAIL_SMTP_PASS = 'p'
    const p = createProviderFromEnv()
    expect(p).toBeInstanceOf(OciEmailProvider)
    restore()
  })

  it('auto-detects OCI when only OCI_EMAIL_SMTP_HOST env is set (no explicit EMAIL_PROVIDER)', () => {
    process.env.OCI_EMAIL_SMTP_HOST = 'h'
    process.env.OCI_EMAIL_SMTP_USER = 'u'
    process.env.OCI_EMAIL_SMTP_PASS = 'p'
    const p = createProviderFromEnv()
    expect(p).toBeInstanceOf(OciEmailProvider)
    restore()
  })

  it('auto-detects SMTP when only SMTP_HOST env is set', () => {
    process.env.SMTP_HOST = 'h'
    process.env.SMTP_PORT = '587'
    process.env.SMTP_USER = 'u'
    process.env.SMTP_PASSWORD = 'p'
    const p = createProviderFromEnv()
    expect(p).toBeInstanceOf(SmtpProvider)
    restore()
  })

  it('auto-detects SES when only AWS_REGION env is set', () => {
    process.env.AWS_REGION = 'us-east-1'
    const p = createProviderFromEnv()
    expect(p).toBeInstanceOf(SesProvider)
    restore()
  })
})
