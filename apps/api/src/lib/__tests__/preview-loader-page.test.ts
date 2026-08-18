// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the preview loader page.
 *
 * The whole point of this page is that a user never lands on a browser error
 * page for a preview link, so the load-bearing behavior is negative: it must NOT
 * hand off to the preview origin until that origin has answered this browser.
 * Asserting that on the rendered string alone would prove nothing, so these
 * tests extract the real inline script and drive it against a stub DOM, fetch,
 * and location — the same approach preview-worker-routing.integration.test.ts
 * takes with the Worker script.
 *
 *   bun test apps/api/src/lib/__tests__/preview-loader-page.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { renderPreviewLoaderPage, renderPreviewMissingPage } from '../preview-loader-page'

const TARGET = 'https://proj-1.preview.shogo.ai/'
const WAKE = '/api/preview/proj-1/wake'
const PROBE = 'https://proj-1.preview.shogo.ai/__shogo/wake'

function render(overrides: Partial<Parameters<typeof renderPreviewLoaderPage>[0]> = {}): string {
  return renderPreviewLoaderPage({
    targetUrl: TARGET,
    wakeUrl: WAKE,
    probeUrl: PROBE,
    label: 'proj-1.preview.shogo.ai',
    ...overrides,
  })
}

function extractScript(html: string): string {
  const open = html.indexOf('<script>')
  const close = html.indexOf('</script>')
  if (open === -1 || close === -1) throw new Error('no inline script in loader page')
  return html.slice(open + '<script>'.length, close)
}

type WakeReply = { status?: number; body?: unknown }

interface RunResult {
  /** Urls passed to location.replace — non-empty means the page handed off. */
  handoffs: string[]
  wakeCalls: number
  probeCalls: number
  /** Pending retry callbacks; non-empty means the page is still trying. */
  pending: number
  title: string
  message: string
  retryVisible: boolean
  /** Run the next scheduled retry. */
  tick: () => Promise<void>
}

/** Let the script's promise chains settle (real macrotask, so microtasks flush). */
function settle(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 5))
}

async function run(opts: {
  html?: string
  wake: () => WakeReply
  reachable: () => boolean
}): Promise<RunResult> {
  const script = extractScript(opts.html ?? render())

  const handoffs: string[] = []
  let wakeCalls = 0
  let probeCalls = 0
  const elements: Record<string, any> = {
    title: { textContent: 'Waking things up' },
    message: { textContent: '' },
    retry: { hidden: true, addEventListener: () => {} },
  }
  const timers: Array<() => void> = []

  const stubWindow = { location: { replace: (url: string) => handoffs.push(url) } }
  const stubDocument = {
    getElementById: (id: string) => elements[id] ?? null,
    // The spinner is only removed in terminal states; null is a valid "not
    // found" for the stub and the script guards on it.
    querySelector: () => null,
  }
  const stubFetch = async (url: string, init?: { mode?: string }) => {
    if (init?.mode === 'no-cors') {
      probeCalls++
      if (!opts.reachable()) throw new TypeError('Failed to fetch')
      return {}
    }
    wakeCalls++
    const reply = opts.wake()
    const status = reply.status ?? 200
    return { status, ok: status >= 200 && status < 300, json: async () => reply.body }
  }
  const stubSetTimeout = (fn: () => void) => timers.push(fn)
  const stubClearTimeout = () => {}

  new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', script)(
    stubWindow,
    stubDocument,
    stubFetch,
    stubSetTimeout,
    stubClearTimeout,
  )
  await settle()

  const result: RunResult = {
    handoffs,
    get wakeCalls() {
      return wakeCalls
    },
    get probeCalls() {
      return probeCalls
    },
    get pending() {
      return timers.length
    },
    get title() {
      return elements.title.textContent
    },
    get message() {
      return elements.message.textContent
    },
    get retryVisible() {
      return elements.retry.hidden === false
    },
    tick: async () => {
      const next = timers.shift()
      if (!next) throw new Error('no scheduled retry to run')
      next()
      await settle()
    },
  }
  return result
}

describe('preview loader page — hand-off gating', () => {
  test('hands off once the backend is ready AND the origin answers', async () => {
    const r = await run({ wake: () => ({ body: { ready: true } }), reachable: () => true })
    expect(r.probeCalls).toBe(1)
    expect(r.handoffs).toEqual([TARGET])
  })

  test('does NOT hand off when the preview origin is unreachable', async () => {
    // The failure that put a browser error page on screen: the backend says
    // ready, but the hostname does not resolve for this client.
    const r = await run({ wake: () => ({ body: { ready: true } }), reachable: () => false })
    expect(r.probeCalls).toBe(1)
    expect(r.handoffs).toEqual([])
    expect(r.pending).toBe(1)
    expect(r.message).toContain('waiting for the preview address')
  })

  test('recovers on its own once the origin starts answering', async () => {
    let up = false
    const r = await run({ wake: () => ({ body: { ready: true } }), reachable: () => up })
    expect(r.handoffs).toEqual([])
    up = true
    await r.tick()
    expect(r.handoffs).toEqual([TARGET])
  })

  test('keeps polling while the backend reports not ready, without probing', async () => {
    const r = await run({ wake: () => ({ body: { ready: false } }), reachable: () => true })
    expect(r.handoffs).toEqual([])
    expect(r.probeCalls).toBe(0)
    expect(r.pending).toBe(1)
    await r.tick()
    expect(r.wakeCalls).toBe(2)
  })

  test('keeps polling through a failed wake call', async () => {
    const r = await run({ wake: () => ({ status: 502 }), reachable: () => true })
    expect(r.handoffs).toEqual([])
    expect(r.pending).toBe(1)
  })

  test('stops with a terminal message when the project is gone', async () => {
    const r = await run({ wake: () => ({ status: 404 }), reachable: () => true })
    expect(r.title).toBe('Preview not found')
    expect(r.handoffs).toEqual([])
    expect(r.pending).toBe(0)
  })
})

describe('preview loader page — markup', () => {
  test('embeds the target, wake and probe urls', () => {
    const html = render()
    expect(html).toContain(JSON.stringify(TARGET))
    expect(html).toContain(JSON.stringify(WAKE))
    expect(html).toContain(JSON.stringify(PROBE))
  })

  test('a url cannot break out of the script tag', () => {
    const html = render({ targetUrl: 'https://x.preview.shogo.ai/</script><script>evil()' })
    expect(html.match(/<script>/g)?.length).toBe(1)
    expect(html).not.toContain('<script>evil()')
  })

  test('escapes the label into the document', () => {
    const html = render({ label: '<img src=x onerror=evil()>' })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })

  test('offers a direct link when scripting is unavailable', () => {
    expect(render()).toContain(`<noscript><p>Enable JavaScript, or <a href="${TARGET}">`)
  })

  test('asks not to be indexed', () => {
    expect(render()).toContain('name="robots" content="noindex"')
    expect(renderPreviewMissingPage()).toContain('name="robots" content="noindex"')
  })
})
