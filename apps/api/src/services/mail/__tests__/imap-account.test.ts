// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A connected IMAP/SMTP account must never become a way to reach this
 * server's own network: names that resolve to private addresses are refused,
 * and errors shown to the person never echo the raw socket message.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { _setResolverForTests } from '../../../lib/safe-fetch'
import { describeMailError, publicAddressFor } from '../imap-account'

afterEach(() => _setResolverForTests(null))

describe('IMAP/SMTP host guard', () => {
  test('a public name resolves to the address we will connect to', async () => {
    _setResolverForTests(async () => ['142.250.0.108'])
    expect(await publicAddressFor('imap.gmail.com')).toBe('142.250.0.108')
  })

  test.each([
    ['metadata via a wildcard DNS name', '169.254.169.254.nip.io', ['169.254.169.254']],
    ['a private network', 'mail.corp-test.io', ['10.0.0.5']],
    ['loopback over IPv6', 'v6.example.io', ['::1']],
    ['one bad address among good ones', 'mixed.example.io', ['142.250.0.108', '192.168.1.1']],
  ])('refuses %s', async (_label, host, addresses) => {
    _setResolverForTests(async () => addresses)
    await expect(publicAddressFor(host)).rejects.toMatchObject({ code: 'invalid_host', status: 400 })
  })

  test('names and literals the format check already refuses', async () => {
    for (const host of ['localhost', 'db.internal', 'printer.local', '10.0.0.1']) {
      await expect(publicAddressFor(host)).rejects.toMatchObject({ code: 'invalid_host' })
    }
  })

  test('a name that does not resolve is refused, not retried as-is', async () => {
    _setResolverForTests(async () => [])
    await expect(publicAddressFor('nope.example.io')).rejects.toMatchObject({ code: 'invalid_host' })
  })
})

describe('describeMailError', () => {
  test('says a sign-in was rejected without the server text', () => {
    const err = Object.assign(new Error('AUTHENTICATIONFAILED Invalid credentials (Failure)'), { authenticationFailed: true })
    expect(describeMailError(err, 'imap.gmail.com')).toBe('imap.gmail.com rejected the username or password. For Gmail and Outlook, use an app password.')
  })

  test('a socket error never leaks the address or port it reached', () => {
    const msg = describeMailError(Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:6379'), { code: 'ECONNREFUSED' }), 'imap.example.io')
    expect(msg).not.toContain('10.1.2.3')
    expect(msg).not.toContain('6379')
    expect(msg).toContain('imap.example.io')
  })
})
