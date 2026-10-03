// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * RS256 JWT verification against a JWKS, for webhook bearer tokens
 * (Bot Framework for Teams, Google for Chat), plus RS256 signing for
 * service-account token grants.
 */

import { createPrivateKey, createPublicKey, createSign, verify as verifySignature, type KeyObject } from 'node:crypto'

const JWKS_TTL_MS = 60 * 60 * 1000
const CLOCK_SKEW_S = 5 * 60

type Jwk = { kid?: string; kty: string; n?: string; e?: string; x5c?: string[] } & Record<string, unknown>
type JwksLoader = (uri: string) => Promise<{ keys: Jwk[] }>

let loadJwks: JwksLoader = async (uri) => {
  const res = await fetch(uri)
  if (!res.ok) throw new Error(`JWKS fetch failed with HTTP ${res.status}`)
  const body = await res.json() as any
  // Google's x509 endpoint returns { kid: pem }; JWKS endpoints return { keys }.
  if (Array.isArray(body?.keys)) return body
  return { keys: Object.entries(body ?? {}).map(([kid, pem]) => ({ kid, kty: 'RSA', pem: String(pem) })) }
}

const cache = new Map<string, { at: number; keys: Map<string, KeyObject> }>()

/** Test seam: serve JWKS from memory. */
export function _setJwksLoaderForTests(loader: JwksLoader | null): void {
  cache.clear()
  if (loader) loadJwks = loader
}

async function keysFor(uri: string, refresh = false): Promise<Map<string, KeyObject>> {
  const hit = cache.get(uri)
  if (hit && !refresh && Date.now() - hit.at < JWKS_TTL_MS) return hit.keys
  const { keys } = await loadJwks(uri)
  const map = new Map<string, KeyObject>()
  for (const jwk of keys) {
    if (!jwk.kid) continue
    try {
      const key = typeof jwk.pem === 'string'
        ? createPublicKey(jwk.pem)
        : createPublicKey({ key: jwk as any, format: 'jwk' })
      map.set(jwk.kid, key)
    } catch {}
  }
  cache.set(uri, { at: Date.now(), keys: map })
  return map
}

function b64urlJson(part: string): any {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}

export interface VerifyOptions {
  jwksUri: string
  issuers: string[]
  audience: string
  nowMs?: number
}

/** Returns the claims, or null for any invalid token. */
export async function verifyJwt(token: string | null | undefined, opts: VerifyOptions): Promise<Record<string, any> | null> {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  let header: any
  let claims: any
  try {
    header = b64urlJson(parts[0])
    claims = b64urlJson(parts[1])
  } catch {
    return null
  }
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string') return null

  let key = (await keysFor(opts.jwksUri).catch(() => new Map<string, KeyObject>())).get(header.kid)
  // Unknown kid: the provider may have rotated keys since we cached them.
  if (!key) key = (await keysFor(opts.jwksUri, true).catch(() => new Map<string, KeyObject>())).get(header.kid)
  if (!key) return null
  const ok = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))
  if (!ok) return null

  const now = (opts.nowMs ?? Date.now()) / 1000
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < now) return null
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > now) return null
  if (!opts.issuers.includes(claims.iss)) return null
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!aud.includes(opts.audience)) return null
  return claims
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') ?? ''
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null
}

/** Sign an RS256 JWT (service-account assertions). */
export function signJwt(claims: Record<string, unknown>, privateKeyPem: string, kid?: string): string {
  const header = { alg: 'RS256', typ: 'JWT', ...(kid ? { kid } : {}) }
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const body = `${encode(header)}.${encode(claims)}`
  const signature = createSign('RSA-SHA256').update(body).sign(createPrivateKey(privateKeyPem)).toString('base64url')
  return `${body}.${signature}`
}
