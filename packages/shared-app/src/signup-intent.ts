// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The marketing site's sign-up intent (SHO-614).
 *
 * The website sends a visitor to `/sign-up` with what they typed and which
 * plan they tapped:
 *
 *   /sign-up?mode=signup&prompt=A+booking+page+for+my+salon&intent=hero_prompt
 *   /sign-up?plan=basic&trial=1
 *
 * The same validation runs on the client (the URL, then localStorage) and on
 * the server (the `__shogo_intent` cookie), so one module owns it and both
 * sides are tested against the same fixtures. Everything here is pure: no
 * `window`, no `document`, no DB — the callers own the transport.
 */

export type SignupPlan = 'basic' | 'business'

export interface SignupIntent {
  /** What the visitor typed in the hero input. */
  prompt?: string
  /** A marketplace listing slug (`?template=`), kept for existing links. */
  template?: string
  /** Plan tapped on the pricing page. `free` and anything else is ignored. */
  plan?: SignupPlan
  /** `?trial=1` next to a plan: start that plan's trial checkout. */
  trial?: boolean
  /** Free-form analytics tag (`?intent=hero_prompt`), sanitized and capped. */
  intent?: string
  /** Client-only: when the browser captured it. Never sent to the server. */
  capturedAt?: number
}

export const SIGNUP_INTENT_PROMPT_MAX = 1000
export const SIGNUP_INTENT_TEMPLATE_MAX = 80
export const SIGNUP_INTENT_TAG_MAX = 40
/**
 * Cookies are capped at ~4 KB per header line. The encoded JSON must stay
 * under this so the intent never truncates another cookie and the sign-up
 * request is never rejected for header size.
 */
export const SIGNUP_INTENT_COOKIE_MAX = 3500

/** A listing slug, exactly what `pending_template_id` has always accepted. */
const TEMPLATE_PATTERN = /^[a-z0-9\-_]{1,80}$/

/** `get` reads a URL/cookie parameter; `null` and `''` mean "absent". */
export type SignupIntentParamGetter = (name: string) => string | null | undefined

function readParam(get: SignupIntentParamGetter, name: string): string | null {
  const raw = get(name)
  return typeof raw === 'string' && raw.trim() ? raw : null
}

/** Trim, fold control characters and repeated whitespace, cap the length. */
function cleanPrompt(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SIGNUP_INTENT_PROMPT_MAX)
    .trim()
  return cleaned || undefined
}

function cleanTemplate(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  const slug = raw.trim().toLowerCase()
  return TEMPLATE_PATTERN.test(slug) ? slug : undefined
}

function cleanPlan(raw: string | null | undefined): SignupPlan | undefined {
  if (typeof raw !== 'string') return undefined
  const plan = raw.trim().toLowerCase()
  return plan === 'basic' || plan === 'business' ? plan : undefined
}

function isTruthyFlag(value: unknown): boolean {
  if (value === true) return true
  if (typeof value !== 'string') return false
  const flag = value.trim().toLowerCase()
  return flag === '1' || flag === 'true' || flag === 'yes'
}

function cleanTag(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  const safe = raw.trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, SIGNUP_INTENT_TAG_MAX)
  return safe || undefined
}

/**
 * Validate an already-decoded object (localStorage, cookie JSON, a request
 * body). Anything unparseable or out of range is dropped, not thrown, so a
 * crafted link or a stale cookie can never break a sign-up.
 */
export function normalizeSignupIntent(value: unknown): SignupIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const out: SignupIntent = {}

  const prompt = cleanPrompt(typeof raw.prompt === 'string' ? raw.prompt : undefined)
  if (prompt) out.prompt = prompt
  const template = cleanTemplate(typeof raw.template === 'string' ? raw.template : undefined)
  if (template) out.template = template
  const plan = cleanPlan(typeof raw.plan === 'string' ? raw.plan : undefined)
  if (plan) out.plan = plan
  if (isTruthyFlag(raw.trial)) out.trial = true
  const tag = cleanTag(typeof raw.intent === 'string' ? raw.intent : undefined)
  if (tag) out.intent = tag
  if (typeof raw.capturedAt === 'number' && Number.isFinite(raw.capturedAt)) {
    out.capturedAt = raw.capturedAt
  }

  return Object.keys(out).length ? out : null
}

/** Parse the query string of a sign-up URL (or any param getter). */
export function parseSignupIntent(get: SignupIntentParamGetter): SignupIntent | null {
  return normalizeSignupIntent({
    prompt: readParam(get, 'prompt') ?? undefined,
    template: readParam(get, 'template') ?? undefined,
    plan: readParam(get, 'plan') ?? undefined,
    trial: readParam(get, 'trial') ?? undefined,
    intent: readParam(get, 'intent') ?? undefined,
  })
}

/**
 * Encode for the `__shogo_intent` cookie. Trims the prompt until the encoded
 * value fits, so a 1 000-character idea (worst case ~3× after URL encoding)
 * still shares the cookie jar with everything else.
 */
export function serializeSignupIntent(intent: SignupIntent): string {
  const value: SignupIntent = { ...intent }
  delete value.capturedAt
  let encoded = encodeURIComponent(JSON.stringify(value))
  // Trim proportionally — one character can cost 6 encoded bytes, so removing
  // "as many characters as we are over" would empty the prompt in one step.
  for (let attempt = 0; attempt < 20 && encoded.length > SIGNUP_INTENT_COOKIE_MAX && value.prompt; attempt++) {
    const next = Math.floor((value.prompt.length * SIGNUP_INTENT_COOKIE_MAX) / encoded.length) - 8
    if (next <= 0) delete value.prompt
    else value.prompt = value.prompt.slice(0, next).trim()
    encoded = encodeURIComponent(JSON.stringify(value))
  }
  return encoded
}

/**
 * Decode a cookie value (the cookie parser has already undone percent
 * encoding) or a localStorage payload. Never throws; garbage is `null`.
 */
export function deserializeSignupIntent(value: string | null | undefined): SignupIntent | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const raw = value.trim()
  const attempts = [raw]
  if (raw.startsWith('%')) {
    try {
      attempts.push(decodeURIComponent(raw))
    } catch {
      // not percent-encoded after all
    }
  }
  for (const attempt of attempts) {
    try {
      const parsed = normalizeSignupIntent(JSON.parse(attempt))
      if (parsed) return parsed
    } catch {
      // try the next shape
    }
  }
  return null
}
