// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, it, beforeEach, mock } from 'bun:test'

// ---- Mock nodemailer to intercept SmtpProvider's dynamic import ----
const sendMailMock = mock(async (_opts: any) => ({ messageId: 'oci-msg-id' }))
const createTransportMock = mock((_opts: any) => ({ sendMail: sendMailMock }))
mock.module('nodemailer', () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}))

import {
  OciEmailProvider,
  createOciEmailProviderFromEnv,
} from '../providers/oci-email.js'

const baseConfig = {
  host: 'smtp.email.us-ashburn-1.oci.oraclecloud.com',
  port: 587,
  user: 'ocid1.user.oc1..xxxx',
  password: 'oci-pass',
}

describe('OciEmailProvider', () => {
  beforeEach(() => {
    sendMailMock.mockClear()
    createTransportMock.mockClear()
  })

  it('isConfigured returns true with all required fields', () => {
    const p = new OciEmailProvider(baseConfig)
    expect(p.isConfigured()).toBe(true)
  })

  it('constructs an inner SmtpProvider with secure=false for port 587', () => {
    const p = new OciEmailProvider(baseConfig)
    expect(p.isConfigured()).toBe(true)
    // verify the wrapped SmtpProvider's config
    expect((p as any).smtp.config.secure).toBe(false)
    expect((p as any).smtp.config.host).toBe(baseConfig.host)
  })

  it('uses secure=true when port is 465', () => {
    const p = new OciEmailProvider({ ...baseConfig, port: 465 })
    expect((p as any).smtp.config.secure).toBe(true)
  })

  it('delegates send() to inner SmtpProvider', async () => {
    const p = new OciEmailProvider(baseConfig)
    const r = await p.send({
      from: 'a@x.com',
      to: 'b@y.com',
      subject: 'oci',
      html: '<p>x</p>',
    })
    expect(r.success).toBe(true)
    expect(sendMailMock).toHaveBeenCalledTimes(1)
  })

  it('applies fromAddress default when params.from is omitted', async () => {
    const p = new OciEmailProvider({ ...baseConfig, fromAddress: 'default@oci.com' })
    await p.send({
      to: 'b@y.com',
      subject: 'oci',
      html: '<p>x</p>',
    } as any)
    const call = sendMailMock.mock.calls[0][0] as any
    expect(call.from).toBe('default@oci.com')
  })

  it('uses params.from when explicitly provided (overrides default)', async () => {
    const p = new OciEmailProvider({ ...baseConfig, fromAddress: 'default@oci.com' })
    await p.send({
      from: 'override@x.com',
      to: 'b@y.com',
      subject: 'oci',
      html: '<p>x</p>',
    })
    const call = sendMailMock.mock.calls[0][0] as any
    expect(call.from).toBe('override@x.com')
  })
})

describe('createOciEmailProviderFromEnv', () => {
  let savedEnv: Record<string, string | undefined>
  const keys = [
    'OCI_EMAIL_SMTP_HOST',
    'OCI_EMAIL_SMTP_USER',
    'OCI_EMAIL_SMTP_PASS',
    'OCI_EMAIL_SMTP_PORT',
    'OCI_EMAIL_FROM_ADDRESS',
  ]
  beforeEach(() => {
    savedEnv = {}
    for (const k of keys) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
  })
  const restore = () => {
    for (const k of keys) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]!
    }
  }

  it('returns null when host is missing', () => {
    process.env.OCI_EMAIL_SMTP_USER = 'u'
    process.env.OCI_EMAIL_SMTP_PASS = 'p'
    expect(createOciEmailProviderFromEnv()).toBeNull()
    restore()
  })

  it('returns null when user is missing', () => {
    process.env.OCI_EMAIL_SMTP_HOST = 'h'
    process.env.OCI_EMAIL_SMTP_PASS = 'p'
    expect(createOciEmailProviderFromEnv()).toBeNull()
    restore()
  })

  it('returns null when password is missing', () => {
    process.env.OCI_EMAIL_SMTP_HOST = 'h'
    process.env.OCI_EMAIL_SMTP_USER = 'u'
    expect(createOciEmailProviderFromEnv()).toBeNull()
    restore()
  })

  it('returns an OciEmailProvider with port 587 by default', () => {
    process.env.OCI_EMAIL_SMTP_HOST = 'h'
    process.env.OCI_EMAIL_SMTP_USER = 'u'
    process.env.OCI_EMAIL_SMTP_PASS = 'p'
    const provider = createOciEmailProviderFromEnv()
    expect(provider).toBeInstanceOf(OciEmailProvider)
    expect((provider as any).smtp.config.port).toBe(587)
    restore()
  })

  it('respects custom OCI_EMAIL_SMTP_PORT', () => {
    process.env.OCI_EMAIL_SMTP_HOST = 'h'
    process.env.OCI_EMAIL_SMTP_USER = 'u'
    process.env.OCI_EMAIL_SMTP_PASS = 'p'
    process.env.OCI_EMAIL_SMTP_PORT = '465'
    const provider = createOciEmailProviderFromEnv()
    expect((provider as any).smtp.config.port).toBe(465)
    expect((provider as any).smtp.config.secure).toBe(true)
    restore()
  })

  it('passes OCI_EMAIL_FROM_ADDRESS through', () => {
    process.env.OCI_EMAIL_SMTP_HOST = 'h'
    process.env.OCI_EMAIL_SMTP_USER = 'u'
    process.env.OCI_EMAIL_SMTP_PASS = 'p'
    process.env.OCI_EMAIL_FROM_ADDRESS = 'noreply@oci.com'
    const provider = createOciEmailProviderFromEnv()
    expect((provider as any).fromAddress).toBe('noreply@oci.com')
    restore()
  })
})
