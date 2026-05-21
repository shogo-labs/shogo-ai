// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

// Closes the strict-mode JWS verification gap (L334-367 + L276-277 in
// apps/api/src/services/apple-iap.service.ts) by mocking node:crypto's
// X509Certificate + verify and node:fs's readFileSync so the full
// chain-broken / trust-anchor / validity / signature branches can be
// driven from JS-only test inputs.
//
// Run in the isolated runner (one process per file) so these module
// mocks do NOT leak into the other apple-iap test files which exercise
// the SKIP_JWS_VERIFY=1 path with the real node:crypto.

import { afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'

// ─── FakeCert: drives every X509Certificate-shaped check the verifier does
class FakeCert {
  publicKey: any
  fingerprint256: string
  validFrom: string
  validTo: string
  subject: string
  signedByPub: string | null
  constructor(input: Buffer | string) {
    const str = typeof input === 'string' ? input : input.toString('utf8')
    let cfg: any
    try { cfg = JSON.parse(str) } catch { throw new Error('FakeCert: not parseable') }
    this.publicKey = { __id: cfg.id }
    this.fingerprint256 = cfg.fp
    this.validFrom = cfg.from ?? '2020-01-01T00:00:00Z'
    this.validTo = cfg.to ?? '2099-01-01T00:00:00Z'
    this.subject = cfg.subj ?? `subj_${cfg.id}`
    this.signedByPub = cfg.signedByPub ?? null
  }
  verify(parentKey: { __id: string }): boolean {
    return this.signedByPub != null && parentKey.__id === this.signedByPub
  }
}

// Controllable signature verifier — defaults to true; tests override per-case.
let fakeVerifyResult = true
const fakeVerify = (_alg: string, _data: Buffer, _key: any, _sig: Buffer) => fakeVerifyResult

// readFileSync override: the source loads AppleRootCA-G3.pem via readFileSync.
// We supply a FakeCert JSON config so appleRootCa() produces a known fingerprint.
const APPLE_ROOT_CFG = JSON.stringify({ id: 'AppleRoot', fp: 'FP_APPLE_ROOT', subj: 'CN=Apple Root CA - G3' })

const realCrypto = await import('node:crypto')
const realFs = await import('node:fs')

mock.module('node:crypto', () => ({
  ...realCrypto,
  default: realCrypto,
  X509Certificate: FakeCert as any,
  verify: fakeVerify,
}))

mock.module('node:fs', () => ({
  ...realFs,
  default: realFs,
  readFileSync: (path: any, enc?: any) => {
    const p = typeof path === 'string' ? path : (path?.pathname ?? String(path))
    if (p.includes('AppleRootCA-G3')) return APPLE_ROOT_CFG
    return (realFs as any).readFileSync(path, enc)
  },
}))

// IMPORTANT: do NOT set APPLE_IAP_SKIP_JWS_VERIFY here — we want the strict path.
delete process.env.APPLE_IAP_SKIP_JWS_VERIFY

const svc = await import('../apple-iap.service')

// ─── helpers ────────────────────────────────────────────────────────────

function certB64(cfg: Record<string, any>): string {
  return Buffer.from(JSON.stringify(cfg)).toString('base64')
}

function buildJws(opts: {
  x5c: string[]
  payload?: Record<string, any>
  payloadRaw?: string
}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', x5c: opts.x5c })).toString('base64url')
  const body = opts.payloadRaw
    ? Buffer.from(opts.payloadRaw).toString('base64url')
    : Buffer.from(JSON.stringify(opts.payload ?? {})).toString('base64url')
  const sig = Buffer.from('sig').toString('base64url')
  return `${header}.${body}.${sig}`
}

afterEach(() => {
  fakeVerifyResult = true
})

beforeAll(() => {
  delete process.env.APPLE_IAP_SKIP_JWS_VERIFY
})

// ─── strict-mode verification branches ──────────────────────────────────

describe('verifyAndDecodeJws — strict mode chain verification', () => {
  it('throws when chain link is broken (L334-338)', () => {
    // Leaf is NOT signed by the next cert in chain.
    const chain = [
      certB64({ id: 'leaf', fp: 'FP_LEAF', signedByPub: 'intermediate' }),
      certB64({ id: 'WRONG_PARENT', fp: 'FP_INTERMEDIATE' }), // leaf says signedBy='intermediate' but parent.id='WRONG_PARENT' → verify returns false
    ]
    expect(() => svc.verifyAndDecodeJws(buildJws({ x5c: chain }))).toThrow(/x5c chain broken at index 0/)
  })

  it('throws when trust anchor is not Apple Root CA G3 (L342-345)', () => {
    // Two-cert chain that links correctly but the topmost cert is NOT
    // Apple Root (fingerprint mismatch).
    const chain = [
      certB64({ id: 'leaf', fp: 'FP_LEAF', signedByPub: 'intermediate' }),
      certB64({ id: 'intermediate', fp: 'FP_NOT_APPLE', subj: 'CN=Some Other CA' }),
    ]
    expect(() => svc.verifyAndDecodeJws(buildJws({ x5c: chain }))).toThrow(
      /not anchored to Apple Root CA G3.*CN=Some Other CA/,
    )
  })

  it('throws when a cert is not yet valid (L355-360)', () => {
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    const chain = [
      certB64({ id: 'leaf', fp: 'FP_LEAF', signedByPub: 'AppleRoot', from: future }),
      certB64({ id: 'AppleRoot', fp: 'FP_APPLE_ROOT', subj: 'CN=Apple Root CA - G3' }),
    ]
    expect(() => svc.verifyAndDecodeJws(buildJws({ x5c: chain }))).toThrow(/cert not yet valid/)
  })

  it('throws when a cert has expired (L355-360, validTo branch)', () => {
    const past = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
    const chain = [
      certB64({ id: 'leaf', fp: 'FP_LEAF', signedByPub: 'AppleRoot', to: past }),
      certB64({ id: 'AppleRoot', fp: 'FP_APPLE_ROOT', subj: 'CN=Apple Root CA - G3' }),
    ]
    expect(() => svc.verifyAndDecodeJws(buildJws({ x5c: chain }))).toThrow(/cert expired/)
  })

  it('throws when JWS signature does not verify (L362-365)', () => {
    fakeVerifyResult = false
    const chain = [
      certB64({ id: 'leaf', fp: 'FP_LEAF', signedByPub: 'AppleRoot' }),
      certB64({ id: 'AppleRoot', fp: 'FP_APPLE_ROOT', subj: 'CN=Apple Root CA - G3' }),
    ]
    expect(() => svc.verifyAndDecodeJws(buildJws({ x5c: chain }))).toThrow(/signature verification failed/)
  })

  it('decodes payload when chain + signature both verify (happy path → L365-367)', () => {
    const chain = [
      certB64({ id: 'leaf', fp: 'FP_LEAF', signedByPub: 'AppleRoot' }),
      certB64({ id: 'AppleRoot', fp: 'FP_APPLE_ROOT', subj: 'CN=Apple Root CA - G3' }),
    ]
    const out = svc.verifyAndDecodeJws(buildJws({ x5c: chain, payload: { hello: 'world', n: 42 } }))
    expect(out).toEqual({ hello: 'world', n: 42 })
  })

  it('throws when payload is not valid JSON despite a valid signature (L367 catch arm)', () => {
    const chain = [
      certB64({ id: 'leaf', fp: 'FP_LEAF', signedByPub: 'AppleRoot' }),
      certB64({ id: 'AppleRoot', fp: 'FP_APPLE_ROOT', subj: 'CN=Apple Root CA - G3' }),
    ]
    expect(() => svc.verifyAndDecodeJws(buildJws({ x5c: chain, payloadRaw: 'definitely not json' }))).toThrow(
      /JWS payload is not valid JSON/,
    )
  })

  it('lazy-initializes appleRootCa on first call and caches it (L276-277)', () => {
    // The first success-path test above invokes appleRootCa() once. A
    // second strict-mode call hits the `if (!_appleRoot)` false branch
    // — together they cover both branches of the lazy-init function.
    const chain = [
      certB64({ id: 'leaf', fp: 'FP_LEAF', signedByPub: 'AppleRoot' }),
      certB64({ id: 'AppleRoot', fp: 'FP_APPLE_ROOT', subj: 'CN=Apple Root CA - G3' }),
    ]
    expect(svc.verifyAndDecodeJws(buildJws({ x5c: chain, payload: { ok: true } }))).toEqual({ ok: true })
  })
})
