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

/** The UTM payload the marketing site (or the app) stores in `__shogo_utm`. */
export interface UtmCookie {
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  utmContent?: string | null
  utmTerm?: string | null
  referrer?: string | null
  landingPage?: string | null
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
      },
      update: {},
    })
    return sourceTag
  } catch (error: any) {
    console.warn('[Attribution] signup attribution write failed:', error?.message ?? error)
    return null
  }
}
