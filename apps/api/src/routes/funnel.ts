// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Paid-acquisition funnel endpoints, called by the shogo.ai Cloudflare Pages
 * Functions (never by a browser directly). The marketing site forwards its
 * visitor's IP / user agent / Meta cookies, so these routes can write the
 * pre-signup funnel steps and send their Conversions API twins.
 *
 *   POST /api/funnel/events          a funnel step (view / start / result)
 *   POST /api/funnel/try/ad-hooks    F1: a site URL → six ad hooks, before signup
 *
 * Authenticated by a shared secret (`x-shogo-funnel-key` = SHOGO_FUNNEL_KEY).
 * With no key configured the routes answer 503, so a stack that never set the
 * funnel up exposes nothing.
 */
import { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { generateText } from 'ai'
import { prisma } from '../lib/prisma'
import { sendMetaEvent, type MetaEventName } from '../lib/meta-capi'
import { safeFetchText, UnsafeUrlError } from '../lib/safe-fetch'
import { resolveLanguageModel, DEFAULT_ASSISTANT_MODEL } from '../lib/resolve-language-model'
import { getSharedRedis } from '../lib/tunnel-redis'

export const FUNNEL_IDS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'] as const
export const FUNNEL_STEPS = ['view', 'start', 'result'] as const
export type FunnelStep = (typeof FUNNEL_STEPS)[number]

const STEP_TO_META: Record<FunnelStep, MetaEventName> = {
  view: 'ViewContent',
  start: 'FunnelStart',
  result: 'Lead',
}

/** Per-visitor-IP tries per UTC day, and the platform-wide daily ceiling. */
export const TRY_PER_IP_PER_DAY = 3
const tryDailyCap = () => Number(process.env.SHOGO_FUNNEL_TRY_DAILY_CAP || 500)

function keyMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const str = (v: unknown, max = 512): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null

const memoryCounters = new Map<string, { count: number; expires: number }>()

/** Increment a day-scoped counter (Redis when available, else this process). */
export async function bumpDailyCounter(key: string): Promise<number> {
  const day = new Date().toISOString().slice(0, 10)
  const full = `funnel:${key}:${day}`
  const redis = getSharedRedis()
  if (redis) {
    try {
      const n = await redis.incr(full)
      if (n === 1) await redis.expire(full, 2 * 86_400)
      return n
    } catch {
      // fall through to the in-process counter
    }
  }
  const now = Date.now()
  const hit = memoryCounters.get(full)
  if (!hit || hit.expires < now) {
    memoryCounters.set(full, { count: 1, expires: now + 2 * 86_400_000 })
    return 1
  }
  hit.count += 1
  return hit.count
}

export function _resetFunnelCountersForTests(): void {
  memoryCounters.clear()
}

/** Title, description, headings and a slice of body text — what the model needs. */
export function summarizeHtml(html: string, maxChars = 4_000): { title: string; description: string; text: string } {
  const pick = (re: RegExp) => (html.match(re)?.[1] ?? '').replace(/\s+/g, ' ').trim()
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const description =
    pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
    pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)
  const text = html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
  return { title, description, text }
}

export interface AdHook {
  hook: string
  angle: string
  format: string
}

/** Pull the six hooks out of the model's answer; tolerant of code fences and prose. */
export function parseHooks(text: string): { business: string; hooks: AdHook[] } | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { business?: unknown; hooks?: unknown }
    if (!Array.isArray(parsed.hooks)) return null
    const hooks = parsed.hooks
      .map((h: any) => ({ hook: str(h?.hook, 240), angle: str(h?.angle, 80) ?? '', format: str(h?.format, 80) ?? '' }))
      .filter((h): h is AdHook => !!h.hook)
      .slice(0, 6)
    if (hooks.length < 3) return null
    return { business: str(parsed.business, 160) ?? '', hooks }
  } catch {
    return null
  }
}

const HOOKS_SYSTEM = `You write paid-social ad hooks for small businesses.
Given a business's website, return ONLY JSON:
{"business":"<one line: what they sell and to whom>","hooks":[{"hook":"<first line of the ad, under 15 words>","angle":"<pain|proof|offer|curiosity|contrast|story>","format":"<ugc talking head|static|carousel|demo|meme>"}]}
Exactly 6 hooks, each a different angle. Specific to THIS business: use its product, audience and numbers from the page. No hashtags, no emojis, no claims the page does not support.`

export type GenerateHooks = (input: { url: string; title: string; description: string; text: string }) => Promise<string>

const defaultGenerateHooks: GenerateHooks = async (page) => {
  const modelId = process.env.SHOGO_FUNNEL_TRY_MODEL || DEFAULT_ASSISTANT_MODEL
  const resolved = resolveLanguageModel(modelId, { headers: { 'x-shogo-usage-tag': 'funnel_try' } })
  if (!resolved) throw new Error(`funnel model "${modelId}" could not be resolved`)
  const result = await generateText({
    model: resolved.model,
    maxOutputTokens: 900,
    system: HOOKS_SYSTEM,
    prompt: `URL: ${page.url}\nTitle: ${page.title}\nDescription: ${page.description}\n\nPage text:\n${page.text}`,
    ...(resolved.provider === 'custom'
      ? { providerOptions: { shogo: { thinking: { type: 'disabled' } } } }
      : {}),
  })
  return result.text
}

export interface FunnelRouteDeps {
  generateHooks?: GenerateHooks
  fetchPage?: typeof safeFetchText
  sendEvent?: typeof sendMetaEvent
}

export function funnelRoutes(deps: FunnelRouteDeps = {}): Hono {
  const router = new Hono()
  const generateHooks = deps.generateHooks ?? defaultGenerateHooks
  const fetchPage = deps.fetchPage ?? safeFetchText
  const sendEvent = deps.sendEvent ?? sendMetaEvent

  router.use('/funnel/*', async (c, next) => {
    const expected = process.env.SHOGO_FUNNEL_KEY
    if (!expected) return c.json({ error: 'funnel_disabled' }, 503)
    if (!keyMatches(c.req.header('x-shogo-funnel-key'), expected)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    return next()
  })

  router.post('/funnel/events', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return c.json({ error: 'invalid_json' }, 400)
    const eventId = str(body.eventId, 128)
    const funnel = str(body.funnel, 8)
    const step = str(body.step, 16) as FunnelStep | null
    if (!eventId || !funnel || !step) return c.json({ error: 'eventId, funnel and step are required' }, 400)
    if (!(FUNNEL_IDS as readonly string[]).includes(funnel)) return c.json({ error: `unknown funnel "${funnel}"` }, 400)
    if (!(FUNNEL_STEPS as readonly string[]).includes(step)) return c.json({ error: `unknown step "${step}"` }, 400)

    const metadata =
      body.metadata && typeof body.metadata === 'object' ? JSON.stringify(body.metadata).slice(0, 4_000) : null
    try {
      await prisma.funnelEvent.create({
        data: {
          eventId,
          funnel,
          step,
          visitorId: str(body.visitorId, 128),
          utmSource: str(body.utmSource),
          utmMedium: str(body.utmMedium),
          utmCampaign: str(body.utmCampaign),
          utmContent: str(body.utmContent),
          landingPage: str(body.landingPage, 1024),
          metadata,
        },
      })
    } catch (error: any) {
      // Same event id twice (a retried beacon): already recorded and sent.
      if (error?.code === 'P2002') return c.json({ ok: true, duplicate: true })
      console.error('[funnel] event write failed:', error?.message ?? error)
      return c.json({ error: 'write_failed' }, 500)
    }

    void sendEvent({
      name: STEP_TO_META[step],
      eventId,
      user: {
        email: str(body.email, 320),
        externalId: str(body.visitorId, 128),
        fbp: str(body.fbp, 256),
        fbc: str(body.fbc, 512),
        clientIp: str(body.clientIp, 64),
        userAgent: str(body.userAgent, 512),
      },
      sourceUrl: str(body.sourceUrl, 1024),
      customData: {
        funnel,
        ...(str(body.utmContent) ? { utm_content: str(body.utmContent) } : {}),
        ...(step === 'result' ? { content_name: `${funnel}_result` } : {}),
      },
    }).catch(() => {})

    return c.json({ ok: true, duplicate: false })
  })

  router.post('/funnel/try/ad-hooks', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const rawUrl = str(body?.url, 2048)
    if (!rawUrl) return c.json({ error: 'Enter your website address.' }, 400)
    const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`

    const ip = str(body?.clientIp, 64) ?? 'unknown'
    const perIp = await bumpDailyCounter(`try-ip:${ip}`)
    if (perIp > TRY_PER_IP_PER_DAY) {
      return c.json({ error: 'You have used your free tries for today. Sign up free to keep going.', code: 'rate_limited' }, 429)
    }
    const total = await bumpDailyCounter('try-total')
    if (total > tryDailyCap()) {
      return c.json({ error: 'The free try is busy right now. Sign up free and your agent will do it.', code: 'daily_cap' }, 429)
    }

    let page: { title: string; description: string; text: string }
    let finalUrl = url
    try {
      const res = await fetchPage(url, { maxBytes: 400 * 1024, timeoutMs: 8_000 })
      if (res.status >= 400) {
        return c.json({ error: `We couldn't open ${url} (HTTP ${res.status}). Check the address.` }, 422)
      }
      finalUrl = res.url
      page = summarizeHtml(res.body)
    } catch (error: any) {
      const reason = error instanceof UnsafeUrlError ? 'That address is not a public website.' : `We couldn't open ${url}.`
      return c.json({ error: reason }, 422)
    }
    if (!page.title && !page.text) {
      return c.json({ error: `There is no readable text on ${url}. Try your homepage.` }, 422)
    }

    try {
      const answer = await generateHooks({ url: finalUrl, ...page })
      const parsed = parseHooks(answer)
      if (!parsed) return c.json({ error: 'The agent returned no usable hooks. Try again.' }, 502)
      return c.json({ url: finalUrl, siteTitle: page.title, ...parsed })
    } catch (error: any) {
      console.error('[funnel] ad-hooks generation failed:', error?.message ?? error)
      return c.json({ error: 'The agent is unavailable right now. Try again in a minute.' }, 502)
    }
  })

  return router
}
