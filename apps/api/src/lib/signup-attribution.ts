// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Signup attribution, written by the server (SHO-258 §7).
 *
 * `signup_attributions` has 14 rows, all from March: the client-side flush
 * (`apps/mobile/lib/attribution.ts`) never lands in prod, because UTMs are read
 * from localStorage on the marketing origin and the app runs on another one.
 *
 * So the row is written here instead, in `user.create.after`, from first-party
 * cookies that ride along with the signup POST — the same shape the affiliate
 * attribution already uses with `__shogo_ref`. The client POST
 * (`/api/users/me/attribution`) stays, but only enriches a row the server
 * already wrote.
 *
 * Since SHO-611 the same hook also reports the sign-up as a Meta conversion
 * (CompleteRegistration, deduped against the pixel with `signup_<userId>`) and
 * reports every method to Cometly, not just social.
 *
 * Never throws: attribution must not be able to fail a signup.
 */
import { prisma } from './prisma'
import { deriveSourceTag } from '../services/analytics.service'
import { sendCometlyEvent, splitName, COMET_TOKEN_COOKIE } from './cometly'
import { buildMetaEvent, isMetaCapiConfigured, sendMetaEvents } from './meta-capi'
import {
  META_FBC_COOKIE,
  META_FBP_COOKIE,
  SHOGO_UTM_COOKIE,
  signupEventId,
} from '../../../../packages/shared-app/src/lib/conversion-events'

/**
 * The attribution payload the marketing site (or the app) stores in
 * `__shogo_utm`.
 *
 * The website contract (card 5): set `__shogo_utm` on `Domain=.shogo.ai` as
 * URL-encoded JSON with `utmSource…utmTerm`, `referrer`, `landingPage`,
 * `fbclid`, `gclid` and `phDid`, and append the visitor's PostHog
 * `distinct_id` to studio links as `ph_did`. A plain `utm_source=…` query
 * string is also accepted, which is what older links carry.
 */
export interface UtmCookie {
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  utmContent?: string | null
  utmTerm?: string | null
  referrer?: string | null
  landingPage?: string | null
  /** Meta click id — the Conversions API's `fbc` (SHO-611). */
  fbclid?: string | null
  /** Google click id, kept for Google Ads offline conversions later. */
  gclid?: string | null
  /** `_fbc` cookie, when Meta's own pixel already wrote one. */
  fbc?: string | null
  /** `_fbp` cookie: Meta's browser id. */
  fbp?: string | null
  /** The website's PostHog anonymous id, so the two funnels join (SHO-611). */
  phDid?: string | null
}

export function parseCookieHeader(header: string, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return part.slice(eq + 1).trim()
    }
  }
  return null
}

/** A string field, or null. Empty and whitespace-only values are "not there". */
function asValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * Read `__shogo_utm` — a URL-encoded JSON blob, or a plain `utm_source=…&…`
 * query string, since the marketing site writes whichever is easiest for it.
 * Anything unparseable is treated as "no UTMs", never as an error.
 */
export function parseUtmCookie(value: string | null): UtmCookie {
  if (!value) return {}
  const out: UtmCookie = {}
  const trimmed = value.trim()

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const pick = (...keys: string[]): string | null => {
        for (const key of keys) {
          const found = asValue(parsed[key])
          if (found) return found
        }
        return null
      }
      return {
        utmSource: pick('utmSource', 'utm_source'),
        utmMedium: pick('utmMedium', 'utm_medium'),
        utmCampaign: pick('utmCampaign', 'utm_campaign'),
        utmContent: pick('utmContent', 'utm_content'),
        utmTerm: pick('utmTerm', 'utm_term'),
        referrer: pick('referrer', 'referrer_url'),
        landingPage: pick('landingPage', 'landing_page'),
        fbclid: pick('fbclid', 'fbc_id'),
        gclid: pick('gclid'),
        fbc: pick('fbc'),
        fbp: pick('fbp'),
        phDid: pick('phDid', 'ph_did', 'posthogDistinctId', 'posthog_distinct_id'),
      }
    } catch {
      return {}
    }
  }

  for (const pair of trimmed.split('&')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const key = pair.slice(0, eq).trim()
    const val = decodeURIComponent(pair.slice(eq + 1).trim().replace(/\+/g, ' '))
    if (!val) continue
    if (key === 'utm_source') out.utmSource = val
    else if (key === 'utm_medium') out.utmMedium = val
    else if (key === 'utm_campaign') out.utmCampaign = val
    else if (key === 'utm_content') out.utmContent = val
    else if (key === 'utm_term') out.utmTerm = val
    else if (key === 'referrer') out.referrer = val
    else if (key === 'landing_page') out.landingPage = val
    else if (key === 'fbclid') out.fbclid = val
    else if (key === 'gclid') out.gclid = val
    else if (key === 'ph_did') out.phDid = val
  }
  return out
}

/** Everything a cookie header can tell us about where this signup came from. */
export function attributionFromCookieHeader(cookieHeader: string | null | undefined): UtmCookie {
  if (!cookieHeader) return {}
  const utm = parseUtmCookie(parseCookieHeader(cookieHeader, SHOGO_UTM_COOKIE))
  const referrer = utm.referrer || parseCookieHeader(cookieHeader, '__shogo_ref_url')
  return {
    ...utm,
    referrer: referrer || utm.referrer || null,
    // Meta's own cookies win: they carry the pixel's real click/browser time.
    fbc: parseCookieHeader(cookieHeader, META_FBC_COOKIE) || utm.fbc || null,
    fbp: parseCookieHeader(cookieHeader, META_FBP_COOKIE) || utm.fbp || null,
  }
}

export interface RecordSignupAttributionInput {
  userId: string
  /** Raw `cookie` header of the signup request. */
  cookieHeader?: string | null
  /** Auth provider: `google`, `credential`, `email`, … */
  method?: string | null
  /** The new account's email — Cometly's primary identifier for the event. */
  email?: string | null
  /** The new account's display name, split into first/last for Cometly. */
  name?: string | null
  /** The signup request's IP, forwarded to Meta unhashed (it hashes itself). */
  clientIp?: string | null
  /** The signup request's user agent, forwarded to Meta unhashed. */
  userAgent?: string | null
}

/**
 * Write the user's attribution row. `sourceTag` is always derived — a signup
 * with no UTMs gets `direct`, which is the number we were missing entirely, not
 * a row we want to skip.
 *
 * The row is created once, at signup, and never overwritten wholesale: the
 * client POST enriches it later, and an admin edit must survive a retry of this
 * function in a multi-region replay.
 */
export async function recordSignupAttribution(
  input: RecordSignupAttributionInput,
): Promise<string | null> {
  try {
    const utm = attributionFromCookieHeader(input.cookieHeader)
    const sourceTag = deriveSourceTag({
      utmSource: utm.utmSource ?? null,
      utmMedium: utm.utmMedium ?? null,
      referrer: utm.referrer ?? null,
      method: input.method ?? null,
    })

    await prisma.signupAttribution.upsert({
      where: { userId: input.userId },
      create: {
        userId: input.userId,
        utmSource: utm.utmSource ?? null,
        utmMedium: utm.utmMedium ?? null,
        utmCampaign: utm.utmCampaign ?? null,
        utmContent: utm.utmContent ?? null,
        utmTerm: utm.utmTerm ?? null,
        referrer: utm.referrer ?? null,
        landingPage: utm.landingPage ?? null,
        signupMethod: input.method ?? null,
        sourceTag,
        fbclid: utm.fbclid ?? null,
        gclid: utm.gclid ?? null,
        fbc: utm.fbc ?? null,
        fbp: utm.fbp ?? null,
        posthogDistinctId: utm.phDid ?? null,
      },
      update: {},
    })

    // Meta Conversions API (SHO-611). `signup_<userId>` is the id the browser's
    // `trackSignUp` sends, so the pixel event and this one are one conversion.
    // Fired at account creation, not after email verification, to match the
    // browser event — a verified-later signup would otherwise be counted twice
    // for one account or not at all. Fire-and-forget: never slows a signup.
    const metaEvent = buildMetaEvent({
      eventName: 'CompleteRegistration',
      eventId: signupEventId(input.userId),
      email: input.email ?? null,
      externalId: input.userId,
      fbc: utm.fbc ?? null,
      fbclid: utm.fbclid ?? null,
      fbp: utm.fbp ?? null,
      clientIp: input.clientIp ?? null,
      userAgent: input.userAgent ?? null,
      sourceUrl: landingPageUrl(utm.landingPage),
      customData: { content_name: input.method ?? undefined },
    })
    if (isMetaCapiConfigured()) void sendMetaEvents([metaEvent]).catch(() => {})

    // Cometly (SHO-441). One `sign_up` per new account, identified by the
    // email; the token the pixel minted on the sign-in page rides along on the
    // OAuth callback when the pixel managed to write it. Every method reports
    // now (SHO-611) — an email sign-up is a sign-up whichever form created it.
    // Fire-and-forget: Cometly must never slow down or fail a signup.
    if (input.email) {
      const cometToken = parseCookieHeader(input.cookieHeader ?? '', COMET_TOKEN_COOKIE)
      const { firstName, lastName } = splitName(input.name)
      void sendCometlyEvent({
        eventName: 'sign_up',
        email: input.email,
        firstName,
        lastName,
        cometToken,
        idempotencyKey: `signup_${input.userId}`,
      }).catch(() => {})
    }

    return sourceTag
  } catch (error: any) {
    console.warn('[Attribution] signup attribution write failed:', error?.message ?? error)
    return null
  }
}

/**
 * `landingPage` is a path (`/pricing?utm_source=x`), which Meta rejects as
 * `event_source_url`. Turn it into an absolute URL when the frontend origin is
 * known, and leave it out otherwise.
 */
function landingPageUrl(landingPage: string | null | undefined): string | null {
  if (!landingPage) return null
  if (/^https?:\/\//i.test(landingPage)) return landingPage
  const origin = (process.env.FRONTEND_URL || process.env.SHOGO_PUBLIC_API_URL || '').replace(/\/+$/, '')
  if (!origin) return null
  return landingPage.startsWith('/') ? `${origin}${landingPage}` : `${origin}/${landingPage}`
}
