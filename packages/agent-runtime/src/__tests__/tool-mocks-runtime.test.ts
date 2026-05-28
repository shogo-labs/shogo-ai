// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import { compileInstallBody, normalizeInstallBody, resolveToolClassDelay } from '../evals/tool-mocks-runtime'

/**
 * Unit tests for the tool-mock install pipeline used by the demo
 * recordings (Playwright `installToolMocks`) and the eval suite.
 *
 * Coverage:
 *   - Backwards-compat: bare map vs `{ mocks, defaults }` envelope
 *   - Static + pattern specs both compile to async fns
 *   - Per-pattern delayMs > spec delayMs > install defaults > tool-class
 *   - Install defaults.delayMs: 0 disables pacing entirely (eval mode)
 *   - Tool-class fallbacks (browser/web/install) when no override
 *   - `__multipart` responses pass through unchanged (gateway unwraps)
 *   - hidden + paramKeys flow into syntheticDefs / hiddenTools
 */

describe('compileInstallBody', () => {
  test('accepts bare map and wraps each spec into an async fn', async () => {
    const compiled = compileInstallBody({
      MY_TOOL: { type: 'static', response: { ok: true } },
    })
    expect(Object.keys(compiled.fns)).toEqual(['MY_TOOL'])
    const out = await compiled.fns.MY_TOOL!({})
    expect(out).toEqual({ ok: true })
  })

  test('accepts envelope and exposes resolved defaults', () => {
    const compiled = compileInstallBody({
      mocks: { X: { type: 'static', response: 1 } },
      defaults: { delayMs: 50, jitterMs: 5 },
    })
    expect(compiled.defaults).toEqual({ delayMs: 50, jitterMs: 5 })
  })

  test('static spec sleeps for spec.delayMs (overrides install default)', async () => {
    const sleeps: number[] = []
    const compiled = compileInstallBody(
      {
        mocks: { T: { type: 'static', response: 'a', delayMs: 200 } },
        defaults: { delayMs: 9999, jitterMs: 0 },
      },
      { randomFn: () => 0.5, sleepFn: async (ms) => { sleeps.push(ms) } },
    )
    await compiled.fns.T!({})
    expect(sleeps).toEqual([200])
  })

  test('pattern spec: per-pattern delayMs beats spec + install defaults', async () => {
    const sleeps: number[] = []
    const compiled = compileInstallBody(
      {
        mocks: {
          search: {
            type: 'pattern',
            patterns: [
              { match: { query: 'fast' }, response: 'F', delayMs: 10 },
              { match: { query: 'slow' }, response: 'S' /* uses spec */ },
            ],
            default: 'D',
            delayMs: 500,
            defaultDelayMs: 50,
          } as const,
        },
        defaults: { delayMs: 9000, jitterMs: 0 },
      },
      { randomFn: () => 0.5, sleepFn: async (ms) => { sleeps.push(ms) } },
    )
    expect(await compiled.fns.search!({ query: 'fast' })).toBe('F')
    expect(await compiled.fns.search!({ query: 'slow' })).toBe('S')
    expect(await compiled.fns.search!({ query: 'unknown' })).toBe('D')
    expect(sleeps).toEqual([10, 500, 50])
  })

  test('install defaults.delayMs: 0 disables all pacing (eval mode)', async () => {
    let slept = false
    const compiled = compileInstallBody(
      {
        mocks: {
          A: { type: 'static', response: 1 },
          B: { type: 'pattern', patterns: [{ match: {}, response: 2 }], default: 3 },
        },
        defaults: { delayMs: 0, jitterMs: 0 },
      },
      { sleepFn: async (ms) => { if (ms > 0) slept = true } },
    )
    await compiled.fns.A!({})
    await compiled.fns.B!({ q: 'anything' })
    expect(slept).toBe(false)
  })

  test('falls back to tool-class default when no spec/install delay set', async () => {
    const sleeps: number[] = []
    const compiled = compileInstallBody(
      {
        // bare map: no install defaults at all
        browser: { type: 'static', response: { ok: true } },
        web: { type: 'static', response: { html: '<p>x</p>' } },
        connect: { type: 'static', response: { installed: [] } },
      },
      { randomFn: () => 0.5, sleepFn: async (ms) => { sleeps.push(ms) } },
    )
    await compiled.fns.browser!({ action: 'navigate' })
    await compiled.fns.web!({})
    await compiled.fns.connect!({})
    // jitter at 0.5 evaluates to (1 - 1) * 400 = 0, so we get the raw class default
    expect(sleeps).toEqual([2200, 1500, 1800])
  })

  test('jitter is applied symmetrically and never goes negative', async () => {
    const sleeps: number[] = []
    let i = 0
    const seq = [0, 1, 0.5] // -jitter, +jitter, 0
    const compiled = compileInstallBody(
      {
        mocks: { T: { type: 'static', response: 1 } },
        defaults: { delayMs: 100, jitterMs: 80 },
      },
      { randomFn: () => seq[i++ % seq.length]!, sleepFn: async (ms) => { sleeps.push(ms) } },
    )
    await compiled.fns.T!({})
    await compiled.fns.T!({})
    await compiled.fns.T!({})
    // delay = 100 + (random*2-1)*80 → 20, 180, 100
    expect(sleeps).toEqual([20, 180, 100])
    expect(sleeps.every((n) => n >= 0)).toBe(true)
  })

  test('static __multipart response passes through unchanged', async () => {
    const compiled = compileInstallBody(
      {
        mocks: {
          screenshot: {
            type: 'static',
            response: {
              __multipart: true,
              content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
              details: { url: 'https://example.com' },
            },
            delayMs: 0,
          },
        },
        defaults: { delayMs: 0, jitterMs: 0 },
      },
    )
    const out = await compiled.fns.screenshot!({})
    expect((out as any).__multipart).toBe(true)
    expect((out as any).content[0].data).toBe('AAAA')
    expect((out as any).details.url).toBe('https://example.com')
  })

  test('hidden + paramKeys + description populate syntheticDefs/hiddenTools', () => {
    const compiled = compileInstallBody({
      mocks: {
        FUTURE_TOOL: {
          type: 'static',
          response: 1,
          hidden: true,
          description: 'Promoted later by connect',
          paramKeys: ['target_id'],
        },
        VISIBLE_TOOL: {
          type: 'static',
          response: 1,
          description: 'Already visible',
          paramKeys: ['x'],
        },
      },
      defaults: { delayMs: 0, jitterMs: 0 },
    })
    expect(compiled.hiddenTools.has('FUTURE_TOOL')).toBe(true)
    expect(compiled.hiddenTools.has('VISIBLE_TOOL')).toBe(false)
    expect(compiled.syntheticDefs.FUTURE_TOOL?.paramKeys).toEqual(['target_id'])
    expect(compiled.syntheticDefs.VISIBLE_TOOL?.paramKeys).toEqual(['x'])
  })

  test('mocks resolve to async functions even for static specs', () => {
    const compiled = compileInstallBody({
      mocks: { T: { type: 'static', response: 1 } },
      defaults: { delayMs: 0, jitterMs: 0 },
    })
    const result = compiled.fns.T!({})
    expect(typeof (result as any).then).toBe('function')
  })
})

describe('normalizeInstallBody', () => {
  test('passes envelope through', () => {
    const out = normalizeInstallBody({ mocks: { A: { type: 'static', response: 1 } }, defaults: { delayMs: 5 } })
    expect(out.defaults?.delayMs).toBe(5)
    expect(out.mocks.A).toBeDefined()
  })

  test('treats bare map as legacy install', () => {
    const out = normalizeInstallBody({ A: { type: 'static', response: 1 } } as any)
    expect(out.defaults).toBeUndefined()
    expect(out.mocks.A).toBeDefined()
  })
})

describe('resolveToolClassDelay', () => {
  test('returns slow defaults for browser navigates and fast ones for clicks', () => {
    expect(resolveToolClassDelay('browser', { action: 'navigate' })).toBe(2200)
    expect(resolveToolClassDelay('browser', { action: 'click' })).toBe(600)
    expect(resolveToolClassDelay('browser', { action: 'screenshot' })).toBe(1100)
  })

  test('matches Composio-style CRUD verbs from tool name', () => {
    expect(resolveToolClassDelay('GMAIL_SEND_EMAIL', {})).toBe(700)
    expect(resolveToolClassDelay('GMAIL_LIST_LABELS', {})).toBe(1800)
  })

  test('returns null for unknown tools so caller falls back', () => {
    expect(resolveToolClassDelay('SOME_RANDOM_TOOL', {})).toBeNull()
  })
})
