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
 * Never throws: attribution must not be able to fail a signup.
 */
import { prisma } from './prisma'
import { deriveSourceTag } from '../services/analytics.service'
import { fbcFrom, sendMetaEvent } from './meta-capi'

/** Shared with the browser Pixel (`trackSignUp`) so Meta dedupes the pair. */
export function signupEventId(userId: string): string {
  return `signup_${userId}`
}

/** `_fbp` / `_fbc` as the Pixel wrote them on `.shogo.ai`; `_fbc` rebuilt from a kept `fbclid`. */
export function metaIdsFromCookieHeader(
  cookieHeader: string | null | undefined,
  fbclid?: string | null,
): { fbp: string | null; fbc: string | null } {
  const header = cookieHeader ?? ''
  return {
    fbp: parseCookieHeader(header, '_fbp'),
    fbc: fbcFrom(parseCookieHeader(header, '_fbc'), fbclid),
  }
}

function absoluteLandingUrl(landingPage: string): string {
  if (/^https?:\/\//.test(landingPage)) return landingPage
  return `https://shogo.ai${landingPage.startsWith('/') ? '' : '/'}${landingPage}`
}

/** The UTM payload the marketing site (or the app) stores in `__shogo_utm`. */
export interface UtmCookie {
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  utmContent?: string | null
  utmTerm?: string | null
  referrer?: string | null
  landingPage?: string | null
  /** Funnel id (`f1`…`f6`) set by the shogo.ai funnel pages. */
  funnel?: string | null
  /** Meta click id from the ad's landing URL, kept until signup. */
  fbclid?: string | null
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
      const pick = (key: string) =>
        typeof parsed[key] === 'string' && (parsed[key] as string).trim()
          ? (parsed[key] as string)
          : null
      return {
        utmSource: pick('utmSource') ?? pick('utm_source'),
        utmMedium: pick('utmMedium') ?? pick('utm_medium'),
        utmCampaign: pick('utmCampaign') ?? pick('utm_campaign'),
        utmContent: pick('utmContent') ?? pick('utm_content'),
        utmTerm: pick('utmTerm') ?? pick('utm_term'),
        referrer: pick('referrer') ?? pick('referrer_url'),
        landingPage: pick('landingPage') ?? pick('landing_page'),
        funnel: pick('funnel'),
        fbclid: pick('fbclid'),
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
    else if (key === 'funnel') out.funnel = val
    else if (key === 'fbclid') out.fbclid = val
  }
  return out
}

/** Everything a cookie header can tell us about where this signup came from. */
export function attributionFromCookieHeader(cookieHeader: string | null | undefined): UtmCookie {
  if (!cookieHeader) return {}
  const utm = parseUtmCookie(parseCookieHeader(cookieHeader, '__shogo_utm'))
  const referrer = utm.referrer || parseCookieHeader(cookieHeader, '__shogo_ref_url')
  return { ...utm, referrer: referrer || utm.referrer || null }
}

export interface RecordSignupAttributionInput {
  userId: string
  /** Raw `cookie` header of the signup request. */
  cookieHeader?: string | null
  /** Auth provider: `google`, `credential`, `email`, … */
  method?: string | null
  /** For the Conversions API: who signed up, and from which client. */
  email?: string | null
  clientIp?: string | null
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
    const meta = metaIdsFromCookieHeader(input.cookieHeader, utm.fbclid)
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
        funnel: utm.funnel ?? null,
        fbp: meta.fbp,
        fbc: meta.fbc,
        clientIp: input.clientIp ?? null,
        userAgent: input.userAgent ?? null,
      },
      update: {},
    })

    // Server twin of the browser's `CompleteRegistration` (same event id, so
    // Meta keeps one). Fire-and-forget: a slow Graph API must not slow signup.
    void sendMetaEvent({
      name: 'CompleteRegistration',
      eventId: signupEventId(input.userId),
      user: {
        email: input.email,
        externalId: input.userId,
        fbp: meta.fbp,
        fbc: meta.fbc,
        clientIp: input.clientIp,
        userAgent: input.userAgent,
      },
      sourceUrl: utm.landingPage ? absoluteLandingUrl(utm.landingPage) : null,
      customData: {
        content_name: input.method ?? 'unknown',
        status: true,
        ...(utm.funnel ? { funnel: utm.funnel } : {}),
        ...(utm.utmContent ? { utm_content: utm.utmContent } : {}),
      },
    }).catch(() => {})
    return sourceTag
  } catch (error: any) {
    console.warn('[Attribution] signup attribution write failed:', error?.message ?? error)
    return null
  }
}
