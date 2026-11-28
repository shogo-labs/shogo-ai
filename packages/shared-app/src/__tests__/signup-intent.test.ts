// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The marketing site's sign-up intent (SHO-614). One parser, used by the app
 * (URL, then localStorage) and by the API (`__shogo_intent` cookie), so every
 * rule below is a rule both sides enforce.
 */
import { describe, expect, test } from 'bun:test'
import {
  SIGNUP_INTENT_COOKIE_MAX,
  SIGNUP_INTENT_PROMPT_MAX,
  deserializeSignupIntent,
  normalizeSignupIntent,
  parseSignupIntent,
  serializeSignupIntent,
} from '../signup-intent'

const fromQuery = (query: string) => {
  const params = new URLSearchParams(query)
  return parseSignupIntent((name) => params.get(name))
}

describe('parseSignupIntent', () => {
  test('reads the hero link whole', () => {
    expect(fromQuery('mode=signup&prompt=A+booking+page+for+my+salon&intent=hero_prompt')).toEqual({
      prompt: 'A booking page for my salon',
      intent: 'hero_prompt',
    })
  })

  test('reads a pricing link', () => {
    expect(fromQuery('plan=business&trial=1')).toEqual({ plan: 'business', trial: true })
    expect(fromQuery('plan=basic&trial=true')).toEqual({ plan: 'basic', trial: true })
  })

  test('knows nothing when the link carried nothing valid', () => {
    expect(fromQuery('')).toBeNull()
    expect(fromQuery('mode=signup&utm_source=x')).toBeNull()
    // `free` is not a plan, `trial` alone is not a plan, an unknown plan is ignored.
    expect(fromQuery('plan=free')).toBeNull()
    expect(fromQuery('trial=1')).toEqual({ trial: true })
    expect(fromQuery('plan=enterprise')).toBeNull()
  })

  test('trims, strips control characters and caps the prompt', () => {
    const messy = fromQuery(`prompt=${encodeURIComponent('  A\n\tpage\u0000 for my salon  ')}`)
    expect(messy?.prompt).toBe('A page for my salon')

    const long = 'x'.repeat(SIGNUP_INTENT_PROMPT_MAX + 500)
    expect(fromQuery(`prompt=${long}`)?.prompt).toHaveLength(SIGNUP_INTENT_PROMPT_MAX)
  })

  test('accepts a slug template and rejects anything else', () => {
    expect(fromQuery('template=invoice-generator')?.template).toBe('invoice-generator')
    expect(fromQuery('template=Invoice_Generator_2')?.template).toBe('invoice_generator_2')
    expect(fromQuery('template=not a slug')?.template).toBeUndefined()
    expect(fromQuery(`template=${'a'.repeat(90)}`)).toBeNull()
  })

  test('sanitizes the analytics tag and caps it at 40 characters', () => {
    expect(fromQuery('intent=hero prompt<script>')?.intent).toBe('heropromptscript')
    expect(fromQuery(`intent=${'a'.repeat(80)}`)?.intent).toHaveLength(40)
  })

  test('prompt wins over template when both are present', () => {
    const intent = fromQuery('prompt=An+invoice+generator&template=invoice-generator')
    expect(intent).toEqual({ prompt: 'An invoice generator', template: 'invoice-generator' })
  })
})

describe('serializeSignupIntent / deserializeSignupIntent', () => {
  test('round-trips', () => {
    const intent = { prompt: 'A quote request page', plan: 'basic' as const, trial: true }
    expect(deserializeSignupIntent(serializeSignupIntent(intent))).toEqual(intent)
  })

  test('drops the browser-only capturedAt stamp', () => {
    const encoded = serializeSignupIntent({ prompt: 'x', capturedAt: 1_700_000_000_000 })
    expect(deserializeSignupIntent(encoded)).toEqual({ prompt: 'x' })
  })

  test('trims an oversized prompt until the encoded value fits the cookie cap', () => {
    // Non-ASCII so URL encoding inflates well past the byte budget.
    const prompt = 'é'.repeat(SIGNUP_INTENT_PROMPT_MAX)
    const encoded = serializeSignupIntent({ prompt, plan: 'business' })
    expect(encoded.length).toBeLessThanOrEqual(SIGNUP_INTENT_COOKIE_MAX)
    const decoded = deserializeSignupIntent(encoded)
    expect(decoded?.prompt?.length).toBeGreaterThan(0)
    expect(decoded?.prompt!.length).toBeLessThan(prompt.length)
    expect(decoded?.plan).toBe('business')
  })

  test('never throws on garbage', () => {
    for (const value of ['', '   ', 'not json', '{', '[]', '{"prompt":42}', 'null', undefined, null]) {
      expect(() => deserializeSignupIntent(value as never)).not.toThrow()
      expect(deserializeSignupIntent(value as never)).toBeNull()
    }
  })

  test('accepts a still-percent-encoded value', () => {
    const encoded = serializeSignupIntent({ prompt: 'A page for my salon' })
    const json = JSON.parse(decodeURIComponent(encoded))
    expect(deserializeSignupIntent(encodeURIComponent(JSON.stringify(json)))).toEqual({
      prompt: 'A page for my salon',
    })
  })
})

describe('normalizeSignupIntent', () => {
  test('rejects everything that is not a plain object', () => {
    for (const value of [null, undefined, 'x', 42, [], true]) {
      expect(normalizeSignupIntent(value)).toBeNull()
    }
  })

  test('keeps only the valid fields of a mixed object', () => {
    expect(
      normalizeSignupIntent({
        prompt: ' A page ',
        template: 'BAD SLUG',
        plan: 'free',
        trial: '0',
        intent: 'hero_prompt',
        capturedAt: 'yesterday',
        extra: 'ignored',
      }),
    ).toEqual({ prompt: 'A page', intent: 'hero_prompt' })
  })
})
