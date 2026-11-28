// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The marketing intent a sign-up link arrived with.
 *
 * An Instagram ad points at something like
 * `/sign-up?utm_source=ig&utm_campaign=launch&plan=pro&prompt=build%20me%20a%20site`.
 * Every hop through auth used to drop it: the signed-in redirect to `/` keeps
 * only `chatSessionId`/`embed`, so by the time someone had signed up, the plan,
 * trial, prompt and campaign were gone. That made an ad unfollowable end to end
 * and left `signup_attribution` with no campaign to credit.
 *
 * This module is the carrier. The auth layout captures the allow-listed keys
 * once (first touch wins per key, so a later `?utm_source=` does not overwrite
 * the ad that actually brought them), the post-auth redirect replays them, and
 * `apps/mobile/app/index.tsx` forwards them into onboarding and the app shell.
 *
 * This module does nothing with the values. Whether `plan` pre-selects a plan
 * or `prompt` auto-runs is a later card's decision — here the only promise is
 * that they arrive.
 */
import { readSyncValue, removeSyncValue, writeSyncValue } from './sync-kv'

/**
 * The only parameters that survive auth. An allow-list, not "everything":
 * these are the ones a later card reads, and copying an arbitrary query string
 * onto a signed-in URL is how open-redirect and cache-poisoning bugs get in.
 */
export const SIGNUP_INTENT_KEYS = [
  'plan',
  'trial',
  'prompt',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const

export type SignupIntentKey = (typeof SIGNUP_INTENT_KEYS)[number]

export type SignupIntent = Partial<Record<SignupIntentKey, string>>

export type IntentParams = Record<string, string | string[] | undefined | null>

const STORAGE_KEY = 'signup-intent-v1'

/** The allow-listed values present in `params`, with empty ones dropped. */
export function pickSignupIntent(params: IntentParams | null | undefined): SignupIntent {
  const picked: SignupIntent = {}
  for (const key of SIGNUP_INTENT_KEYS) {
    const raw = params?.[key]
    const value = Array.isArray(raw) ? raw.find((entry) => typeof entry === 'string' && entry.length > 0) : raw
    if (typeof value === 'string' && value.length > 0) picked[key] = value
  }
  return picked
}

/**
 * Merge `params` into the stored intent, keeping whatever was stored first for
 * a key that already has a value. First touch wins per key so the ad that
 * brought the visitor is the one that gets credited, even if an intermediate
 * redirect (or a subsequent visit) carries a different campaign.
 */
export function captureSignupIntent(params: IntentParams | null | undefined): void {
  const incoming = pickSignupIntent(params)
  if (Object.keys(incoming).length === 0) return
  const merged: SignupIntent = { ...incoming, ...readSignupIntent() }
  writeSyncValue('session', STORAGE_KEY, JSON.stringify(merged))
}

export function readSignupIntent(): SignupIntent {
  const raw = readSyncValue('session', STORAGE_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return pickSignupIntent(parsed as IntentParams)
  } catch {
    return {}
  }
}

export function clearSignupIntent(): void {
  removeSyncValue('session', STORAGE_KEY)
}

/**
 * `path` with the intent appended as a query string. Existing query and hash
 * are preserved, and an empty intent returns the path untouched so a direct
 * visit produces exactly the URL it always did.
 */
export function withSignupIntent(path: string, intent: SignupIntent = readSignupIntent()): string {
  const entries = SIGNUP_INTENT_KEYS.flatMap((key) => {
    const value = intent[key]
    return value ? [[key, value] as const] : []
  })
  if (entries.length === 0) return path

  const hashAt = path.indexOf('#')
  const hash = hashAt >= 0 ? path.slice(hashAt) : ''
  const base = hashAt >= 0 ? path.slice(0, hashAt) : path
  const separator = base.includes('?') ? '&' : '?'
  const query = entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
  return `${base}${separator}${query}${hash}`
}
