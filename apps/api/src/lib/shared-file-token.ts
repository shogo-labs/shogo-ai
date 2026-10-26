// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Short-lived capability tokens for downloading a single workspace file.
 *
 * These tokens deliberately do not contain a runtime bearer token. The API
 * verifies the capability and then obtains the runtime token server-side.
 */

import { createHmac } from 'node:crypto'
import { safeTokenEqual } from './crypto-util'

const TOKEN_TYPE = 'shared-file'
const MAX_PATH_LENGTH = 4096

export interface SharedFileTokenPayload {
  typ: typeof TOKEN_TYPE
  /** Absent for a file in a project-less workspace runtime. */
  projectId?: string
  workspaceId: string
  path: string
  exp: number
  iat: number
}

function signingSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.PREVIEW_TOKEN_SECRET
  if (secret) return secret
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[SharedFileToken] No signing secret configured')
  }
  return 'shogo-dev-only-shared-file-secret'
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function decode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8')
}

function signatureFor(encodedPayload: string): string {
  return createHmac('sha256', signingSecret())
    .update(`${TOKEN_TYPE}:${encodedPayload}`)
    .digest('base64url')
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function validPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  )
}

export function signSharedFileToken(input: {
  projectId?: string
  workspaceId: string
  path: string
  exp: number
  now?: number
}): string {
  if (
    (input.projectId !== undefined && !validId(input.projectId)) ||
    !validId(input.workspaceId) ||
    !validPath(input.path)
  ) {
    throw new Error('Invalid shared file token claims')
  }
  if (!Number.isSafeInteger(input.exp) || input.exp <= 0) {
    throw new Error('Invalid shared file token expiry')
  }

  const now = input.now ?? Math.floor(Date.now() / 1000)
  const payload: SharedFileTokenPayload = {
    typ: TOKEN_TYPE,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    workspaceId: input.workspaceId,
    path: input.path,
    exp: input.exp,
    iat: now,
  }
  const encodedPayload = encode(JSON.stringify(payload))
  return `${encodedPayload}.${signatureFor(encodedPayload)}`
}

/**
 * Why a token was refused. The download routes answer a different `code` for
 * `expired` and `invalid_link`, which is the difference between "ask for a new
 * link" and "the link was mangled" — the two reports that used to look alike.
 */
export type SharedFileTokenFailure =
  | 'not_a_string'
  | 'malformed'
  | 'signature_mismatch'
  | 'payload_unreadable'
  | 'wrong_type'
  | 'bad_claims'
  | 'expired'
  | 'not_yet_valid'
  | 'invalid_expiry_window'

export type SharedFileTokenDiagnosis =
  | { ok: true; claims: SharedFileTokenPayload }
  | {
      ok: false
      reason: SharedFileTokenFailure
      /** Decoded claims, present whenever the payload could be read at all. */
      claims?: Partial<SharedFileTokenPayload>
    }

/**
 * Check a token, and say what failed when it does. `verifySharedFileToken` is
 * the same check without the reason; a 404 should use this one so the log
 * names the failing check instead of leaving the next report to guess.
 *
 * Callers may log the claim fields — they are what the token grants. The
 * signature is never returned and never logged.
 */
export function diagnoseSharedFileToken(token: string): SharedFileTokenDiagnosis {
  try {
    if (typeof token !== 'string') return { ok: false, reason: 'not_a_string' }
    const [encodedPayload, signature, extra] = token.split('.')
    if (!encodedPayload || !signature || extra) return { ok: false, reason: 'malformed' }

    const expected = signatureFor(encodedPayload)
    if (!safeTokenEqual(signature, expected)) {
      return { ok: false, reason: 'signature_mismatch', claims: readClaims(encodedPayload) }
    }

    const payload = readClaims(encodedPayload)
    if (!payload) return { ok: false, reason: 'payload_unreadable' }

    if (
      payload.typ !== TOKEN_TYPE ||
      (payload.projectId !== undefined && !validId(payload.projectId)) ||
      !validId(payload.workspaceId) ||
      !validPath(payload.path) ||
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp)
    ) {
      return { ok: false, reason: payload.typ === TOKEN_TYPE ? 'bad_claims' : 'wrong_type', claims: payload }
    }

    const now = Math.floor(Date.now() / 1000)
    const exp = payload.exp as number
    const iat = payload.iat as number
    if (exp <= now) return { ok: false, reason: 'expired', claims: payload }
    if (iat > now + 60) return { ok: false, reason: 'not_yet_valid', claims: payload }
    if (exp <= iat) return { ok: false, reason: 'invalid_expiry_window', claims: payload }

    return { ok: true, claims: payload as SharedFileTokenPayload }
  } catch {
    return { ok: false, reason: 'payload_unreadable' }
  }
}

function readClaims(encodedPayload: string): Partial<SharedFileTokenPayload> | undefined {
  try {
    const parsed = JSON.parse(decode(encodedPayload))
    return parsed && typeof parsed === 'object' ? (parsed as Partial<SharedFileTokenPayload>) : undefined
  } catch {
    return undefined
  }
}

/** The log line a refused download link leaves: reason plus claim fields. */
export function describeSharedFileToken(diagnosis: SharedFileTokenDiagnosis): string {
  if (diagnosis.ok) return 'ok'
  const claims = diagnosis.claims
  const fields = claims
    ? `typ=${claims.typ ?? '?'} projectId=${claims.projectId ?? '-'} workspaceId=${claims.workspaceId ?? '-'} path=${claims.path ?? '-'} exp=${claims.exp ?? '-'} iat=${claims.iat ?? '-'}`
    : 'claims=unreadable'
  return `reason=${diagnosis.reason} ${fields}`
}

/**
 * The refusal to send back. An expired link and a mangled one read differently
 * to the user, and neither is the same thing as a token whose file has gone.
 */
export function sharedFileLinkError(reason: SharedFileTokenFailure | undefined): {
  status: 404
  code: 'expired' | 'invalid_link'
  message: string
} {
  if (reason === 'expired') {
    return { status: 404, code: 'expired', message: 'This download link has expired' }
  }
  return { status: 404, code: 'invalid_link', message: 'This download link is invalid' }
}

export function verifySharedFileToken(token: string): SharedFileTokenPayload | null {
  const diagnosis = diagnoseSharedFileToken(token)
  return diagnosis.ok ? diagnosis.claims : null
}
