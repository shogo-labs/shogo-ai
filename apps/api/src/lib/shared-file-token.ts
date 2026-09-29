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
  projectId: string
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
  projectId: string
  workspaceId: string
  path: string
  exp: number
  now?: number
}): string {
  if (!validId(input.projectId) || !validId(input.workspaceId) || !validPath(input.path)) {
    throw new Error('Invalid shared file token claims')
  }
  if (!Number.isSafeInteger(input.exp) || input.exp <= 0) {
    throw new Error('Invalid shared file token expiry')
  }

  const now = input.now ?? Math.floor(Date.now() / 1000)
  const payload: SharedFileTokenPayload = {
    typ: TOKEN_TYPE,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    path: input.path,
    exp: input.exp,
    iat: now,
  }
  const encodedPayload = encode(JSON.stringify(payload))
  return `${encodedPayload}.${signatureFor(encodedPayload)}`
}

export function verifySharedFileToken(token: string): SharedFileTokenPayload | null {
  try {
    if (typeof token !== 'string') return null
    const [encodedPayload, signature, extra] = token.split('.')
    if (!encodedPayload || !signature || extra) return null

    const expected = signatureFor(encodedPayload)
    if (!safeTokenEqual(signature, expected)) return null

    const payload = JSON.parse(decode(encodedPayload)) as Partial<SharedFileTokenPayload>
    if (
      payload.typ !== TOKEN_TYPE ||
      !validId(payload.projectId) ||
      !validId(payload.workspaceId) ||
      !validPath(payload.path) ||
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp)
    ) {
      return null
    }

    const now = Math.floor(Date.now() / 1000)
    if (payload.exp <= now || payload.iat > now + 60 || payload.exp <= payload.iat) {
      return null
    }

    return payload as SharedFileTokenPayload
  } catch {
    return null
  }
}
