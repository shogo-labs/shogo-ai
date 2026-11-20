// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Bot Framework inbound JWT validator (WebCrypto RS256, no new dependency).
 *
 * Validates Authorization: Bearer <jwt> on every Teams activity:
 *   - RS256 signature against Bot Framework / Azure AD JWKS
 *   - iss = "https://api.botframework.com" (multi-tenant)
 *       or the tenant-specific Azure AD issuers (single-tenant)
 *   - aud = appId
 *   - exp / nbf with ±5 min clock skew
 *   - endorsements must include the activity's channelId
 *   - serviceUrl claim must match activity.serviceUrl
 *
 * For single-tenant bots, also accepts tokens from the tenant's
 * Azure AD v2.0 endpoint using that tenant's JWKS.
 *
 * SHOGO_TEAMS_TEST_AUTHORITY — overrides the OpenID metadata / JWKS / OAuth
 * base URL in NODE_ENV=test only. Silently ignored in production.
 */

const CLOCK_SKEW_MS = 5 * 60 * 1000

// Production endpoint constants
const BF_OPENID_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration'
const BF_ISSUER = 'https://api.botframework.com'
const AAD_OPENID_TEMPLATE = 'https://login.microsoftonline.com/{tenantId}/v2.0/.well-known/openid-configuration'
const AAD_ISSUER_V2_TEMPLATE = 'https://login.microsoftonline.com/{tenantId}/v2.0'
const AAD_ISSUER_V1_TEMPLATE = 'https://sts.windows.net/{tenantId}/'

/** How long to cache JWKS entries (ms). */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

interface JwkEntry {
  kid: string
  alg: string
  key: CryptoKey
  endorsements?: string[]
  expiresAt: number
}

interface JwksCache {
  keys: Map<string, JwkEntry>
  fetchedAt: number
}

/** One cache slot per authority URL. */
const caches = new Map<string, JwksCache>()

/** Rate-limit for per-kid refetches: one per authority per minute. */
const lastRefetch = new Map<string, number>()

function testAuthority(): string | undefined {
  if (process.env.NODE_ENV !== 'test') return undefined
  return process.env.SHOGO_TEAMS_TEST_AUTHORITY
}

function bfOpenIdUrl(): string {
  const ta = testAuthority()
  return ta ? `${ta}/.well-known/openid-configuration` : BF_OPENID_URL
}

function aadOpenIdUrl(tenantId: string): string {
  const ta = testAuthority()
  if (ta) return `${ta}/tenant/${tenantId}/.well-known/openid-configuration`
  return AAD_OPENID_TEMPLATE.replace('{tenantId}', tenantId)
}

async function fetchJwks(openIdUrl: string): Promise<Map<string, JwkEntry>> {
  const metaRes = await fetch(openIdUrl, { signal: AbortSignal.timeout(10_000) })
  if (!metaRes.ok) throw new Error(`OpenID metadata fetch failed (${metaRes.status}): ${openIdUrl}`)
  const meta = (await metaRes.json()) as { jwks_uri: string }
  if (!meta.jwks_uri) throw new Error(`No jwks_uri in OpenID metadata from ${openIdUrl}`)

  const jwksRes = await fetch(meta.jwks_uri, { signal: AbortSignal.timeout(10_000) })
  if (!jwksRes.ok) throw new Error(`JWKS fetch failed (${jwksRes.status}): ${meta.jwks_uri}`)
  const jwks = (await jwksRes.json()) as { keys: any[] }

  const result = new Map<string, JwkEntry>()
  for (const jwk of jwks.keys ?? []) {
    if (jwk.kty !== 'RSA') continue
    try {
      const cryptoKey = await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      )
      result.set(jwk.kid, {
        kid: jwk.kid,
        alg: jwk.alg ?? 'RS256',
        key: cryptoKey,
        endorsements: jwk.endorsements,
        expiresAt: Date.now() + CACHE_TTL_MS,
      })
    } catch {
      // Skip unparseable keys
    }
  }
  return result
}

async function getKeys(openIdUrl: string, forceRefresh = false): Promise<Map<string, JwkEntry>> {
  const cached = caches.get(openIdUrl)
  if (!forceRefresh && cached && Date.now() < cached.fetchedAt + CACHE_TTL_MS) {
    return cached.keys
  }
  const keys = await fetchJwks(openIdUrl)
  caches.set(openIdUrl, { keys, fetchedAt: Date.now() })
  return keys
}

async function findKey(
  openIdUrl: string,
  kid: string,
): Promise<JwkEntry | undefined> {
  let keys = await getKeys(openIdUrl)
  if (keys.has(kid)) return keys.get(kid)

  // Unknown kid: refetch once (rate-limited to once per minute per authority)
  const rl = lastRefetch.get(openIdUrl) ?? 0
  if (Date.now() - rl < 60_000) return undefined
  lastRefetch.set(openIdUrl, Date.now())

  keys = await getKeys(openIdUrl, true)
  return keys.get(kid)
}

function base64UrlDecode(s: string): ArrayBuffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded)
  const buf = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i)
  return buf.buffer
}

/** Parse a compact JWT without verifying. Returns header, payload, and raw parts. */
function parseJwt(token: string): {
  header: { alg: string; kid: string }
  payload: Record<string, any>
  headerB64: string
  payloadB64: string
  sigBytes: ArrayBuffer
} | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')))
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    const sigBytes = base64UrlDecode(parts[2])
    return { header, payload, headerB64: parts[0], payloadB64: parts[1], sigBytes }
  } catch {
    return null
  }
}

export interface BotFrameworkAuthOptions {
  appId: string
  /** Directory tenant ID — if set, single-tenant mode. */
  tenantId?: string
  /** The activity's channelId (must appear in key endorsements). */
  channelId: string
  /** The activity's serviceUrl (must match jwt.serviceUrl claim). */
  serviceUrl: string
}

export interface AuthResult {
  ok: boolean
  reason?: string
}

/**
 * Validate a Bot Framework inbound JWT.
 * Returns `{ ok: true }` on success, `{ ok: false, reason }` on any failure.
 */
export async function validateBotFrameworkJwt(
  authHeader: string | undefined,
  opts: BotFrameworkAuthOptions,
): Promise<AuthResult> {
  if (!authHeader?.startsWith('Bearer ')) {
    return { ok: false, reason: 'missing Authorization: Bearer token' }
  }
  const token = authHeader.slice(7).trim()
  const parsed = parseJwt(token)
  if (!parsed) return { ok: false, reason: 'malformed JWT' }

  const { header, payload, headerB64, payloadB64, sigBytes } = parsed

  if (header.alg !== 'RS256') {
    return { ok: false, reason: `unsupported alg: ${header.alg}` }
  }
  if (!header.kid) return { ok: false, reason: 'missing kid' }

  // Verify expiry / nbf
  const now = Date.now()
  if (typeof payload.exp === 'number' && now > (payload.exp * 1000) + CLOCK_SKEW_MS) {
    return { ok: false, reason: 'token expired' }
  }
  if (typeof payload.nbf === 'number' && now < (payload.nbf * 1000) - CLOCK_SKEW_MS) {
    return { ok: false, reason: 'token not yet valid' }
  }

  // Verify aud
  if (payload.aud !== opts.appId) {
    return { ok: false, reason: `wrong aud: ${payload.aud}` }
  }

  // Verify serviceUrl claim matches activity
  if (payload.serviceurl && payload.serviceurl !== opts.serviceUrl) {
    return { ok: false, reason: 'serviceUrl claim mismatch' }
  }

  // Collect candidate authorities (issuer → openIdUrl pairs)
  const candidates: Array<{ iss: string; openIdUrl: string }> = [
    { iss: BF_ISSUER, openIdUrl: bfOpenIdUrl() },
  ]
  if (opts.tenantId) {
    candidates.push({
      iss: AAD_ISSUER_V2_TEMPLATE.replace('{tenantId}', opts.tenantId),
      openIdUrl: aadOpenIdUrl(opts.tenantId),
    })
    candidates.push({
      iss: AAD_ISSUER_V1_TEMPLATE.replace('{tenantId}', opts.tenantId),
      openIdUrl: aadOpenIdUrl(opts.tenantId),
    })
  }

  // Check issuer is one we accept
  const matchedCandidate = candidates.find((c) => c.iss === payload.iss)
  if (!matchedCandidate) {
    return { ok: false, reason: `untrusted iss: ${payload.iss}` }
  }

  // Find the signing key
  const keyEntry = await findKey(matchedCandidate.openIdUrl, header.kid).catch(() => undefined)
  if (!keyEntry) {
    return { ok: false, reason: `unknown kid: ${header.kid}` }
  }

  // Verify endorsements include the channelId
  if (keyEntry.endorsements && keyEntry.endorsements.length > 0) {
    if (!keyEntry.endorsements.includes(opts.channelId)) {
      return { ok: false, reason: `key does not endorse channelId: ${opts.channelId}` }
    }
  }

  // Verify RS256 signature
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  const valid = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    keyEntry.key,
    sigBytes,
    signingInput,
  ).catch(() => false)

  if (!valid) return { ok: false, reason: 'invalid signature' }

  return { ok: true }
}

/** Clear all JWKS caches (for testing). */
export function clearBotFrameworkAuthCaches(): void {
  caches.clear()
  lastRefetch.clear()
}
