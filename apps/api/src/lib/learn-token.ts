// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The learn.shogo.ai sign-in cookie.
 *
 * learn.shogo.ai signs people in with their Shogo account through a cookie on
 * the parent domain (`.shogo.ai`). That cookie is deliberately NOT the Better
 * Auth session: `{projectId}.preview.shogo.ai` serves user code, and a session
 * cookie on `.shogo.ai` would be sent to every preview a person opens, handing
 * their whole account to whoever owns that preview.
 *
 * So the parent-domain cookie carries a learn-only token instead:
 *  - it is an HMAC-signed `{ userId, sessionId, exp }`, never a session token;
 *  - it is accepted only by `/api/learn/*`, which can read courses and progress
 *    and run the coach, nothing else;
 *  - it is bound to the Better Auth session it was minted from, so signing out
 *    (which deletes the session) ends it everywhere.
 *
 * Minting is off unless `LEARN_COOKIE_DOMAIN` is set, which keeps desktop and
 * local dev unchanged.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export const LEARN_COOKIE_NAME = 'shogo_learn'

/** Thirty days, renewed whenever Studio loads the session and the token is past half-life. */
export const LEARN_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

const TOKEN_VERSION = 'v1'

export interface LearnTokenPayload {
  userId: string
  sessionId: string
  /** Expiry, unix seconds. */
  exp: number
}

function learnSecret(purpose: string = 'shogo-learn-token-v1'): string {
  const base = process.env.LEARN_TOKEN_SECRET || process.env.BETTER_AUTH_SECRET
  if (!base) throw new Error('LEARN_TOKEN_SECRET or BETTER_AUTH_SECRET must be set to sign learn tokens')
  // Derived per purpose, so a learn token can never verify as any other token
  // signed with the same base secret (or as a certificate, and vice versa).
  return createHmac('sha256', base).update(purpose).digest('hex')
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function sign(body: string): string {
  return createHmac('sha256', learnSecret()).update(body).digest('base64url')
}

export function mintLearnToken(
  params: { userId: string; sessionId: string },
  now: number = Date.now(),
): { token: string; exp: number } {
  const exp = Math.floor(now / 1000) + LEARN_TOKEN_TTL_SECONDS
  const payload = b64url(JSON.stringify({ u: params.userId, s: params.sessionId, e: exp }))
  const body = `${TOKEN_VERSION}.${payload}`
  return { token: `${body}.${sign(body)}`, exp }
}

/** The payload of a well-signed, unexpired token, or null. Does not check the session. */
export function verifyLearnToken(token: string | null | undefined, now: number = Date.now()): LearnTokenPayload | null {
  if (!token || typeof token !== 'string' || token.length > 1024) return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null
  const body = `${parts[0]}.${parts[1]}`
  const expected = Buffer.from(sign(body))
  const given = Buffer.from(parts[2])
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  let raw: any
  try {
    raw = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof raw?.u !== 'string' || typeof raw?.s !== 'string' || typeof raw?.e !== 'number') return null
  if (raw.e * 1000 <= now) return null
  return { userId: raw.u, sessionId: raw.s, exp: raw.e }
}

/** `.shogo.ai` in production, `.staging.shogo.ai` on staging; unset everywhere else. */
export function learnCookieDomain(): string | null {
  const domain = process.env.LEARN_COOKIE_DOMAIN?.trim()
  return domain ? domain : null
}

/** Origins `/api/learn/sso` may send a browser back to. */
export function learnOrigins(): string[] {
  const fromEnv = (process.env.LEARN_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean)
  if (fromEnv.length) return fromEnv
  return process.env.NODE_ENV === 'production' ? [] : ['http://localhost:4321', 'http://localhost:8788']
}

/**
 * The return URL if it is an http(s) URL on an allowed learn origin, else null.
 * Exact origin match: no suffix tricks (`learn.shogo.ai.evil.com`), no userinfo.
 */
export function safeLearnReturn(raw: string | null | undefined, origins: string[] = learnOrigins()): string | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password) return null
  if (!origins.includes(url.origin)) return null
  return url.toString()
}

/**
 * `domain` null = host-only cookie (local dev, where `localhost` is shared by
 * every port). `secure` follows the request's scheme.
 */
export function learnCookieHeader(
  token: string,
  opts: { domain: string | null; secure: boolean; maxAgeSeconds?: number },
): string {
  return [
    `${LEARN_COOKIE_NAME}=${token}`,
    ...(opts.domain ? [`Domain=${opts.domain}`] : []),
    'Path=/',
    `Max-Age=${opts.maxAgeSeconds ?? LEARN_TOKEN_TTL_SECONDS}`,
    'HttpOnly',
    ...(opts.secure ? ['Secure'] : []),
    'SameSite=Lax',
  ].join('; ')
}

export function clearLearnCookieHeader(opts: { domain: string | null; secure: boolean }): string {
  return learnCookieHeader('', { ...opts, maxAgeSeconds: 0 })
}

/** Whether a cookie for `domain` may be set on a response to `host` (RFC 6265 domain-match). */
export function hostMatchesCookieDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, '')
  const d = domain.toLowerCase().replace(/^\./, '')
  return h === d || h.endsWith(`.${d}`)
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null
  }
  return null
}

/**
 * Header the learn site's server functions forward the cookie value in. Its own
 * header (not `Authorization`) so it never reaches the API-key or runtime-token
 * paths in `authMiddleware`.
 */
export const LEARN_TOKEN_HEADER = 'x-shogo-learn-token'

/** A token from the learn site's server (header) or a browser (cookie). */
export function learnTokenFromHeaders(headers: Headers): string | null {
  const fromHeader = headers.get(LEARN_TOKEN_HEADER)?.trim()
  if (fromHeader) return fromHeader
  return readCookie(headers.get('cookie'), LEARN_COOKIE_NAME)
}

/** Re-mint once a token has used half its life, so active learners never expire. */
export function learnTokenNeedsRenewal(token: string | null, now: number = Date.now()): boolean {
  const payload = verifyLearnToken(token, now)
  if (!payload) return true
  return payload.exp * 1000 - now < (LEARN_TOKEN_TTL_SECONDS * 1000) / 2
}


const CERT_VERSION = 'c1'
const CERT_PURPOSE = 'shogo-learn-certificate-v1'
export const LEARN_CERT_NAME_MAX = 80

export interface LearnCertificate {
  /** Keyed hash of the user id (see `certificateSubject`), never the id itself: certificate links are public. */
  subject: string
  courseId: string
  name: string
  issuedAt: number
  score: number
  total: number
}

function signCert(body: string): string {
  return createHmac('sha256', learnSecret(CERT_PURPOSE)).update(body).digest('base64url')
}

/** Stable, non-reversible handle for the learner a certificate belongs to. */
export function certificateSubject(userId: string): string {
  return createHmac('sha256', learnSecret(CERT_PURPOSE)).update(`subject:${userId}`).digest('base64url').slice(0, 22)
}

/** Display name for a certificate: printable, single-line, capped. */
export function cleanCertificateName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '')
    .trim()
    .slice(0, LEARN_CERT_NAME_MAX)
}

/**
 * A certificate is its own proof: the id is a signed payload, so verifying it
 * needs no database row. It never expires and carries no email.
 */
export function mintLearnCertificate(cert: Omit<LearnCertificate, 'subject'> & { userId: string }): string {
  const payload = b64url(
    JSON.stringify({ h: certificateSubject(cert.userId), c: cert.courseId, n: cert.name, t: cert.issuedAt, s: cert.score, o: cert.total }),
  )
  const body = `${CERT_VERSION}.${payload}`
  return `${body}.${signCert(body)}`
}

export function verifyLearnCertificate(id: string | null | undefined): LearnCertificate | null {
  if (!id || typeof id !== 'string' || id.length > 1024) return null
  const parts = id.split('.')
  if (parts.length !== 3 || parts[0] !== CERT_VERSION) return null
  const body = `${parts[0]}.${parts[1]}`
  const expected = Buffer.from(signCert(body))
  const given = Buffer.from(parts[2])
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  let raw: any
  try {
    raw = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (
    typeof raw?.h !== 'string' ||
    typeof raw?.c !== 'string' ||
    typeof raw?.n !== 'string' ||
    typeof raw?.t !== 'number' ||
    typeof raw?.s !== 'number' ||
    typeof raw?.o !== 'number'
  ) {
    return null
  }
  return { subject: raw.h, courseId: raw.c, name: raw.n, issuedAt: raw.t, score: raw.s, total: raw.o }
}

const BADGE_VERSION = 'b1'
const BADGE_PURPOSE = 'shogo-learn-badge-v1'

export interface LearnBadgeShare {
  /** Same keyed handle as certificates, never the user id. */
  subject: string
  badgeId: string
  name: string
  earnedAt: number
}

function signBadge(body: string): string {
  return createHmac('sha256', learnSecret(BADGE_PURPOSE)).update(body).digest('base64url')
}

/** A public, self-verifying link to one earned badge (for LinkedIn and the like). */
export function mintLearnBadgeShare(share: Omit<LearnBadgeShare, 'subject'> & { userId: string }): string {
  const payload = b64url(JSON.stringify({ h: certificateSubject(share.userId), b: share.badgeId, n: share.name, t: share.earnedAt }))
  const body = `${BADGE_VERSION}.${payload}`
  return `${body}.${signBadge(body)}`
}

export function verifyLearnBadgeShare(id: string | null | undefined): LearnBadgeShare | null {
  if (!id || typeof id !== 'string' || id.length > 1024) return null
  const parts = id.split('.')
  if (parts.length !== 3 || parts[0] !== BADGE_VERSION) return null
  const body = `${parts[0]}.${parts[1]}`
  const expected = Buffer.from(signBadge(body))
  const given = Buffer.from(parts[2])
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  let raw: any
  try {
    raw = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof raw?.h !== 'string' || typeof raw?.b !== 'string' || typeof raw?.n !== 'string' || typeof raw?.t !== 'number') return null
  return { subject: raw.h, badgeId: raw.b, name: raw.n, earnedAt: raw.t }
}
