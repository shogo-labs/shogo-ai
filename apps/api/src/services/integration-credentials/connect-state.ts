// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Signed OAuth `state` for connecting a personal integration account. The
 * provider's callback is public (no Shogo session), so the Shogo user and the
 * project they consented for travel in the state. Prefixed so a provider
 * callback shared with another flow can tell the two apart.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

const KIND = 'personal-integration-connect'
const PREFIX = 'pc.'
const STATE_TTL_MS = 30 * 60 * 1000

export interface PersonalConnectState {
  userId: string
  provider: string
  /** Project the person consented for; absent when connecting from their own settings. */
  projectId?: string
  exp: number
  nonce: string
}

function secret(): string {
  const value = process.env.BETTER_AUTH_SECRET || ''
  if (!value) throw new Error('BETTER_AUTH_SECRET is required to sign integration connect state')
  return value
}

function mac(encoded: string): string {
  return createHmac('sha256', secret()).update(`${KIND}.${encoded}`).digest('base64url')
}

export function isPersonalConnectState(state: string | null | undefined): boolean {
  return !!state && state.startsWith(PREFIX)
}

export function signPersonalConnectState(
  value: Omit<PersonalConnectState, 'exp' | 'nonce'>,
  nowMs = Date.now(),
): string {
  const payload: PersonalConnectState = { ...value, exp: nowMs + STATE_TTL_MS, nonce: randomUUID() }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${PREFIX}${encoded}.${mac(encoded)}`
}

export function verifyPersonalConnectState(state: string | null | undefined, nowMs = Date.now()): PersonalConnectState | null {
  if (!isPersonalConnectState(state)) return null
  const [encoded, given] = state!.slice(PREFIX.length).split('.')
  if (!encoded || !given) return null
  let expected: Buffer
  try {
    expected = Buffer.from(mac(encoded))
  } catch {
    return null
  }
  const actual = Buffer.from(given)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as PersonalConnectState
    if (typeof payload?.userId !== 'string' || !payload.userId) return null
    if (typeof payload.provider !== 'string' || !payload.provider) return null
    if (typeof payload.exp !== 'number' || payload.exp < nowMs) return null
    return payload
  } catch {
    return null
  }
}
