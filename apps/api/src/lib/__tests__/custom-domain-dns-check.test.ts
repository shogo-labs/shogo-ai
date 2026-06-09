// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the server-side custom-domain DNS check. The resolver is
 * fully injected so these never touch the network: we assert the CNAME
 * (incl. apex flattening + wrong target), the `_acme-challenge` TXT coverage
 * (ok / partial / missing), and that resolver failures degrade gracefully
 * rather than throwing.
 */
import { describe, test, expect } from 'bun:test'
import {
  checkCustomDomainDns,
  type DnsResolver,
} from '../custom-domain-dns-check'

const FALLBACK = 'cname.shogo.one'

function resolver(over: Partial<DnsResolver>): DnsResolver {
  const reject = () => Promise.reject(new Error('ENODATA'))
  return {
    resolveCname: over.resolveCname ?? reject,
    resolve4: over.resolve4 ?? reject,
    resolveTxt: over.resolveTxt ?? reject,
  }
}

describe('checkCustomDomainDns — CNAME routing', () => {
  test('ok when the CNAME points at the fallback origin (case/dot-insensitive)', async () => {
    const r = await checkCustomDomainDns(
      'www.acme.com',
      FALLBACK,
      [],
      resolver({ resolveCname: async () => ['Cname.Shogo.One.'] }),
    )
    expect(r.cname).toBe('ok')
  })

  test('wrong when the CNAME points somewhere else', async () => {
    const r = await checkCustomDomainDns(
      'www.acme.com',
      FALLBACK,
      [],
      resolver({ resolveCname: async () => ['ghs.googlehosted.com'] }),
    )
    expect(r.cname).toBe('wrong')
  })

  test('apex flattening: no CNAME but A records resolve → ok', async () => {
    const r = await checkCustomDomainDns(
      'acme.com',
      FALLBACK,
      [],
      resolver({
        resolveCname: () => Promise.reject(new Error('ENODATA')),
        resolve4: async () => ['104.18.0.1'],
      }),
    )
    expect(r.cname).toBe('ok')
  })

  test('missing when nothing resolves', async () => {
    const r = await checkCustomDomainDns('acme.com', FALLBACK, [], resolver({}))
    expect(r.cname).toBe('missing')
  })
})

describe('checkCustomDomainDns — DCV TXT', () => {
  const txt = (vals: string[]): DnsResolver['resolveTxt'] => async () => vals.map((v) => [v])

  test('ok when every expected token is present', async () => {
    const r = await checkCustomDomainDns('www.acme.com', FALLBACK, ['a', 'b'], resolver({
      resolveCname: async () => [FALLBACK],
      resolveTxt: txt(['a', 'b', 'unrelated']),
    }))
    expect(r.txt).toBe('ok')
    expect(r.txtFound).toBe(2)
    expect(r.txtExpected).toBe(2)
    expect(r.ok).toBe(true)
  })

  test('partial when only some tokens are present', async () => {
    const r = await checkCustomDomainDns('www.acme.com', FALLBACK, ['a', 'b'], resolver({
      resolveCname: async () => [FALLBACK],
      resolveTxt: txt(['a']),
    }))
    expect(r.txt).toBe('partial')
    expect(r.txtFound).toBe(1)
    expect(r.ok).toBe(false)
  })

  test('missing when the TXT record is absent', async () => {
    const r = await checkCustomDomainDns('www.acme.com', FALLBACK, ['a'], resolver({
      resolveCname: async () => [FALLBACK],
    }))
    expect(r.txt).toBe('missing')
    expect(r.ok).toBe(false)
  })

  test('joins multi-chunk TXT values before matching', async () => {
    const r = await checkCustomDomainDns('www.acme.com', FALLBACK, ['part1part2'], resolver({
      resolveCname: async () => [FALLBACK],
      resolveTxt: async () => [['part1', 'part2']],
    }))
    expect(r.txt).toBe('ok')
  })

  test('no expected tokens ⇒ txt ok (http method / already issued)', async () => {
    const r = await checkCustomDomainDns('www.acme.com', FALLBACK, [], resolver({
      resolveCname: async () => [FALLBACK],
    }))
    expect(r.txt).toBe('ok')
    expect(r.txtExpected).toBe(0)
    expect(r.ok).toBe(true)
  })
})

describe('checkCustomDomainDns — overall ok', () => {
  test('ok only when BOTH routing and every DCV token check out', async () => {
    const r = await checkCustomDomainDns('www.acme.com', FALLBACK, ['tok'], resolver({
      resolveCname: async () => [FALLBACK],
      resolveTxt: async () => [['tok']],
    }))
    expect(r).toMatchObject({ cname: 'ok', txt: 'ok', ok: true })
  })
})
