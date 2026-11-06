// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Every action type that lands in `usage_events`, in one place.
 *
 * The Usage dashboard used to keep its own allow-list of "metered" types, which
 * silently drifted: image/video/3D/music/transcription/hosting/social charges
 * were billed through `consumeUsage` but dropped by every reader (SHO-355).
 *
 * There is now exactly one registry:
 *  - `BILLED_USAGE_ACTION_TYPES` — charged to a wallet, shown on the dashboard.
 *  - `NON_BILLED_USAGE_ACTION_TYPES` — recorded for cost tracking only (internal
 *    completions, wallet adjustments). Never shown.
 *
 * `ConsumeUsageParams.actionType` is typed as `BilledUsageActionType`, so a new
 * billed type that is not registered here fails typecheck, and
 * `usage-action-types.test.ts` scans every literal call site so an untyped
 * caller cannot slip through either.
 */

export type UsageCategory =
  | 'chat'
  | 'image'
  | 'video'
  | '3d'
  | 'music'
  | 'transcription'
  | 'voice'
  | 'hosting'
  | 'social'
  | 'native'

/** Billed action type → the dashboard category it rolls up into. */
export const BILLED_USAGE_ACTION_TYPES = {
  ai_proxy_completion: 'chat',
  chat_message: 'chat',
  ai_image_generation: 'image',
  ai_video_generation: 'video',
  ai_3d_generation: '3d',
  ai_music_generation: 'music',
  ai_audio_transcription: 'transcription',
  voice_minutes_inbound: 'voice',
  voice_minutes_outbound: 'voice',
  voice_number_setup: 'voice',
  voice_number_monthly: 'voice',
  ai_live_session_minutes: 'voice',
  voice_media_usage: 'voice',
  published_hosting: 'hosting',
  social_account_monthly: 'social',
  social_dm: 'social',
  social_x_api: 'social',
  social_media_lookup: 'social',
  // Native release meters (SHO-323). Billed: each one debits the wallet, so
  // folding them into `hosting` would draw an EAS build as "Published hosting".
  native_build: 'native',
  native_test_run: 'native',
  native_update_mau: 'native',
} as const satisfies Record<string, UsageCategory>

export type BilledUsageActionType = keyof typeof BILLED_USAGE_ACTION_TYPES

/**
 * Recorded but never billed to a user, so never shown on the Usage dashboard:
 *  - `ai_proxy_internal` — legacy internal completion tag.
 *  - `title_generation` / `analytics_digest` — server-side internal completions
 *    (`INTERNAL_USAGE_TAGS` in `routes/ai-proxy.ts`).
 *  - `signup_credit_expired` / `signup_credit_revoked` — wallet adjustments.
 */
export const NON_BILLED_USAGE_ACTION_TYPES = [
  'ai_proxy_internal',
  'title_generation',
  'analytics_digest',
  'signup_credit_expired',
  'signup_credit_revoked',
] as const

export type NonBilledUsageActionType = (typeof NON_BILLED_USAGE_ACTION_TYPES)[number]

export type UsageActionType = BilledUsageActionType | NonBilledUsageActionType

/** The billed types, as the array every reader filters on. */
export const BILLED_USAGE_ACTION_TYPE_LIST = Object.keys(BILLED_USAGE_ACTION_TYPES) as BilledUsageActionType[]

const BILLED_LOOKUP: Record<string, UsageCategory> = BILLED_USAGE_ACTION_TYPES
const NON_BILLED_LOOKUP = new Set<string>(NON_BILLED_USAGE_ACTION_TYPES)

/** The billed category for an action type, or null for a non-billed/unknown one. */
export function usageCategoryFor(actionType: string): UsageCategory | null {
  return BILLED_LOOKUP[actionType] ?? null
}

export function isBilledUsageActionType(actionType: string): actionType is BilledUsageActionType {
  return Object.prototype.hasOwnProperty.call(BILLED_LOOKUP, actionType)
}

export function isNonBilledUsageActionType(actionType: string): actionType is NonBilledUsageActionType {
  return NON_BILLED_LOOKUP.has(actionType)
}

export const USAGE_CATEGORY_LABELS: Record<UsageCategory, string> = {
  chat: 'Chat',
  image: 'Image',
  video: 'Video',
  '3d': '3D',
  music: 'Music',
  transcription: 'Transcription',
  voice: 'Voice',
  hosting: 'Hosting',
  social: 'Social',
  // The series label, not the charges: this category holds builds, test runs and
  // update MAU, so "Native build" would misname two of the three. The per-type
  // names below are what the rows show.
  native: 'Native',
}

/** Chart legend / dropdown order — chat first, then media, then the rest. */
export const USAGE_CATEGORY_ORDER: UsageCategory[] = [
  'chat',
  'image',
  'video',
  '3d',
  'music',
  'transcription',
  'voice',
  'hosting',
  'social',
  'native',
]

export function usageCategoryLabel(category: UsageCategory): string {
  return USAGE_CATEGORY_LABELS[category]
}

/**
 * A human name for a type that records **no model** — hosting and every social
 * charge. Without this those rows were labelled `unknown` even though we know
 * exactly what they are (SHO-355 AC3).
 *
 * Only the model-less types are listed: where a row carries a model, that id (or
 * its catalog display name) is the honest label, and a per-type name would hide
 * it. `usageActionLabel` therefore falls back to the category label.
 */
export const USAGE_ACTION_LABELS: Partial<Record<BilledUsageActionType, string>> = {
  published_hosting: 'Published hosting',
  social_account_monthly: 'Social: account',
  social_dm: 'Social: DM',
  social_x_api: 'Social: X API',
  social_media_lookup: 'Social: media lookup',
  ai_audio_transcription: 'Audio transcription',
  voice_media_usage: 'Voice: media',
  voice_number_setup: 'Voice: number setup',
  voice_number_monthly: 'Voice: number rental',
  native_build: 'EAS build',
  native_test_run: 'EAS test run',
  native_update_mau: 'Native update MAU',
}

/**
 * The value the scans store when a row recorded no model. It is **not** a model
 * name: handing it to a label resolver must mean "absent", or every reader has
 * to remember to strip it and the ones that forget ship `unknown` to the UI
 * (SHO-355 QA round 2).
 */
export const USAGE_UNKNOWN_MODEL = 'unknown'

/** True when a recorded model is really "no model at all". */
export function isUnknownModel(value: unknown): boolean {
  if (typeof value !== 'string') return true
  const trimmed = value.trim()
  return trimmed === '' || trimmed.toLowerCase() === USAGE_UNKNOWN_MODEL
}

/** The best human name for an action type: its own, else its category's. */
export function usageActionLabel(actionType: string): string {
  const own = USAGE_ACTION_LABELS[actionType as BilledUsageActionType]
  if (own) return own
  const category = usageCategoryFor(actionType)
  return category ? USAGE_CATEGORY_LABELS[category] : actionType
}

/** Categories whose spend is "model" spend (tokens), not media credits. */
export function isTokenCategory(category: UsageCategory): boolean {
  return category === 'chat'
}
