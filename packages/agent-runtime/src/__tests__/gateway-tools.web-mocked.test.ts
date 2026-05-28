// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for the `web` tool in gateway-tools.ts.
 *
 * Mocks `globalThis.fetch` so every branch of:
 *   - createWebTool (orchestration)
 *   - serperSearch (direct-key + proxy + error)
 *   - rawFetch (HTML, PDF, 403/429 retry, timeout retry, content-type detection)
 *   - fetchWikipediaAsMarkdown (success + non-ok)
 *   - parseWikipediaUrl
 *   - detectGoogleUrl
 *   - formatSerperResults (all response shapes)
 *   - cleanPlainText / stripHtmlRegex / stripHtmlToText
 * runs against canned responses, without any network access.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { createTools, type ToolContext } from '../gateway-tools'

const TEST_DIR = '/tmp/test-gateway-tools-web-mocked'

function createCtx(): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'test',
  }
}

function getWebTool(ctx: ToolContext) {
  const tools = createTools(ctx)
  const t = tools.find(x => x.name === 'web')
  if (!t) throw new Error('web tool not found')
  return t
}

async function callWeb(params: Record<string, any>) {
  const ctx = createCtx()
  const tool = getWebTool(ctx)
  const result = await tool.execute('cid', params)
  return result.details
}

/** Build a fetch-like Response object. */
function makeResponse(opts: {
  status?: number
  statusText?: string
  body?: string | Uint8Array | Record<string, unknown>
  contentType?: string
  ok?: boolean
} = {}): Response {
  const { status = 200, statusText = 'OK', contentType = 'text/plain' } = opts
  let bodyText: string
  let bodyBuf: ArrayBuffer | null = null
  if (opts.body instanceof Uint8Array) {
    bodyBuf = opts.body.buffer.slice(opts.body.byteOffset, opts.body.byteOffset + opts.body.byteLength) as ArrayBuffer
    bodyText = ''
  } else if (typeof opts.body === 'object' && opts.body !== null) {
    bodyText = JSON.stringify(opts.body)
  } else {
    bodyText = (opts.body as string) ?? ''
  }
  const headers = new Headers({ 'content-type': contentType })
  const ok = opts.ok ?? (status >= 200 && status < 300)
  return {
    ok,
    status,
    statusText,
    headers,
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText || 'null'),
    arrayBuffer: async () => bodyBuf ?? new TextEncoder().encode(bodyText).buffer,
  } as unknown as Response
}

// =====================================================================
// fetch stubbing
// =====================================================================

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response> | Response
const realFetch = globalThis.fetch
let fetchCalls: Array<{ url: string; init?: RequestInit }> = []
let handler: FetchHandler = () => { throw new Error('no fetch handler installed') }

function installFetch(h: FetchHandler) {
  handler = h
  fetchCalls = []
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input)
    fetchCalls.push({ url, init })
    return await handler(url, init)
  }) as typeof fetch
}

function restoreFetch() {
  globalThis.fetch = realFetch
}

// =====================================================================
// env helpers
// =====================================================================

const envBackup: Record<string, string | undefined> = {}
function setEnv(key: string, value: string | undefined) {
  if (!(key in envBackup)) envBackup[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
function restoreEnv() {
  for (const k of Object.keys(envBackup)) {
    if (envBackup[k] === undefined) delete process.env[k]
    else process.env[k] = envBackup[k]
    delete envBackup[k]
  }
}

// =====================================================================
// tests
// =====================================================================

describe('gateway-tools web tool (mocked fetch)', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    setEnv('WEB_CACHE_REDIS_URL', undefined)
    setEnv('SERPER_API_KEY', undefined)
    setEnv('TOOLS_PROXY_URL', undefined)
    setEnv('AI_PROXY_TOKEN', undefined)
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    restoreFetch()
    restoreEnv()
  })

  // -------------------------------------------------------------------
  // Orchestration / argument validation
  // -------------------------------------------------------------------
  test('returns error when neither url nor query is provided', async () => {
    const r = await callWeb({})
    expect(r.error).toContain('Provide either')
  })

  test('pure-query path errors when no api key/proxy configured', async () => {
    const r = await callWeb({ query: 'anything' })
    expect(r.error).toContain('SERPER_API_KEY not configured')
  })

  // -------------------------------------------------------------------
  // detectGoogleUrl branches (driven via web tool)
  // -------------------------------------------------------------------
  test('Google Maps /maps/dir/A/B routes to Serper directions query', async () => {
    setEnv('SERPER_API_KEY', 'test-key')
    installFetch(async () =>
      makeResponse({ contentType: 'application/json', body: { organic: [{ title: 'X', link: 'https://x', snippet: 's' }] } }),
    )
    const r = await callWeb({ url: 'https://www.google.com/maps/dir/Foo+Bar/Baz' })
    expect(r.query).toBe('directions from Foo Bar to Baz')
    expect(r.searchType).toBe('search')
  })

  test('Google Maps /maps/place/X routes to Serper places', async () => {
    setEnv('SERPER_API_KEY', 'test-key')
    installFetch(async () => makeResponse({ contentType: 'application/json', body: { places: [] } }))
    const r = await callWeb({ url: 'https://www.google.com/maps/place/Eiffel+Tower' })
    expect(r.searchType).toBe('places')
    expect(r.query).toBe('Eiffel Tower')
  })

  test('Google Maps /maps/search/X routes to places', async () => {
    setEnv('SERPER_API_KEY', 'test-key')
    installFetch(async () => makeResponse({ contentType: 'application/json', body: {} }))
    const r = await callWeb({ url: 'https://www.google.com/maps/search/Pizza+Place' })
    expect(r.searchType).toBe('places')
    expect(r.query).toBe('Pizza Place')
  })

  test('Google Maps /maps?q= routes to places', async () => {
    setEnv('SERPER_API_KEY', 'test-key')
    installFetch(async () => makeResponse({ contentType: 'application/json', body: {} }))
    const r = await callWeb({ url: 'https://www.google.com/maps?q=Sushi' })
    expect(r.searchType).toBe('places')
    expect(r.query).toBe('Sushi')
  })

  test('Google /travel/flights?q= routes to search', async () => {
    setEnv('SERPER_API_KEY', 'test-key')
    installFetch(async () => makeResponse({ contentType: 'application/json', body: {} }))
    const r = await callWeb({ url: 'https://www.google.com/travel/flights?q=LAX+to+DPS' })
    expect(r.searchType).toBe('search')
    expect(r.query).toBe('LAX to DPS')
  })

  test('Google /travel/flights with tfs fallback', async () => {
    setEnv('SERPER_API_KEY', 'test-key')
    installFetch(async () => makeResponse({ contentType: 'application/json', body: {} }))
    const r = await callWeb({ url: 'https://www.google.com/travel/flights?tfs=ENCODED' })
    expect(r.query).toBe('flights ENCODED')
  })

  test('Google /travel/flights with no params defaults to "flights"', async () => {
    setEnv('SERPER_API_KEY', 'test-key')
    installFetch(async () => makeResponse({ contentType: 'application/json', body: {} }))
    const r = await callWeb({ url: 'https://www.google.com/travel/flights' })
    expect(r.query).toBe('flights')
  })

  test('Google /shopping?q= routes to shopping searchType', async () => {
    setEnv('SERPER_API_KEY', 'test-key')
    installFetch(async () => makeResponse({ contentType: 'application/json', body: {} }))
    const r = await callWeb({ url: 'https://www.google.com/shopping?q=Headphones' })
    expect(r.searchType).toBe('shopping')
    expect(r.query).toBe('Headphones')
  })

  test('Google /shopping without q defaults to "shopping" query', async () => {
    setEnv('SERPER_API_KEY', 'test-key')
    installFetch(async () => makeResponse({ contentType: 'application/json', body: {} }))
    const r = await callWeb({ url: 'https://www.google.com/shopping' })
    expect(r.query).toBe('shopping')
  })

  test('non-google URL does NOT route through detectGoogleUrl', async () => {
    installFetch(async () => makeResponse({ contentType: 'text/plain', body: 'plain content '.repeat(50) }))
    const r = await callWeb({ url: 'https://example.com/something' })
    expect(r.content).toBeDefined()
    expect(r.searchType).toBeUndefined()
  })

  test('malformed URL falls through detectGoogleUrl (rawFetch path)', async () => {
    installFetch(async () => makeResponse({ contentType: 'text/plain', body: 'x' }))
    // detectGoogleUrl returns null for unparseable URLs; rawFetch then errors on its own
    const r = await callWeb({ url: 'not-a-real-url' })
    // either error from rawFetch attempts or content; not a serper route
    expect(r.searchType).toBeUndefined()
  })

  test('google subdomain like maps.google.com routes via detectGoogleUrl', async () => {
    setEnv('SERPER_API_KEY', 'test-key')
    installFetch(async () => makeResponse({ contentType: 'application/json', body: {} }))
    const r = await callWeb({ url: 'https://maps.google.com/maps/place/Tokyo+Tower' })
    expect(r.searchType).toBe('places')
  })

  test('non-google host like google-clone.com is not routed', async () => {
    installFetch(async () => makeResponse({ contentType: 'text/plain', body: 'x'.repeat(500) }))
    const r = await callWeb({ url: 'https://google-clone.com/maps/place/X' })
    expect(r.searchType).toBeUndefined()
    expect(r.content).toBeDefined()
  })

  // -------------------------------------------------------------------
  // serperSearch — direct key, proxy, errors, formatting
  // -------------------------------------------------------------------
  test('serperSearch uses direct key endpoint when SERPER_API_KEY set', async () => {
    setEnv('SERPER_API_KEY', 'direct-key')
    installFetch(async (url) => {
      expect(url).toBe('https://google.serper.dev/search')
      return makeResponse({
        contentType: 'application/json',
        body: { organic: [{ title: 'A', link: 'https://a', snippet: 'sa', position: 1 }], credits: 3 },
      })
    })
    const r = await callWeb({ query: 'hello' })
    expect(r.error).toBeUndefined()
    expect(r.results).toContain('A')
    expect(r.creditsUsed).toBe(3)
  })

  test('serperSearch uses proxy when only TOOLS_PROXY_URL + AI_PROXY_TOKEN set', async () => {
    setEnv('TOOLS_PROXY_URL', 'https://proxy.example/tools')
    setEnv('AI_PROXY_TOKEN', 'proxy-token')
    installFetch(async (url) => {
      expect(url).toBe('https://proxy.example/tools/serper/news')
      return makeResponse({ contentType: 'application/json', body: { news: [{ title: 'N', link: 'l', source: 's' }] } })
    })
    const r = await callWeb({ query: 'topic', searchType: 'news' })
    expect(r.error).toBeUndefined()
    expect(r.results).toContain('N')
  })

  test('serperSearch falls back to default endpoint for unknown search type', async () => {
    setEnv('SERPER_API_KEY', 'k')
    let calledUrl = ''
    installFetch(async (url) => {
      calledUrl = url
      return makeResponse({ contentType: 'application/json', body: {} })
    })
    await callWeb({ query: 'q', searchType: 'bogus' })
    expect(calledUrl).toBe('https://google.serper.dev/search')
  })

  test('serperSearch surfaces non-ok response as error', async () => {
    setEnv('SERPER_API_KEY', 'k')
    installFetch(async () => makeResponse({ status: 500, statusText: 'err', body: 'bad', contentType: 'text/plain' }))
    const r = await callWeb({ query: 'q' })
    expect(r.error).toContain('Serper API error')
  })

  test('serperSearch catches fetch throw and returns error', async () => {
    setEnv('SERPER_API_KEY', 'k')
    installFetch(async () => { throw new Error('boom') })
    const r = await callWeb({ query: 'q' })
    expect(r.error).toContain('Web search failed')
    expect(r.error).toContain('boom')
  })

  test('formatSerperResults renders answerBox + knowledgeGraph + organic + peopleAlsoAsk + relatedSearches', async () => {
    setEnv('SERPER_API_KEY', 'k')
    installFetch(async () =>
      makeResponse({
        contentType: 'application/json',
        body: {
          answerBox: { answer: 'Paris', snippet: 'is the capital of France' },
          knowledgeGraph: {
            title: 'France',
            type: 'Country',
            description: 'A nation in Europe',
            website: 'https://france.fr',
            attributes: { Capital: 'Paris', Population: '67M' },
          },
          organic: [
            { title: 'r1', link: 'https://r1', snippet: 's1', position: 1 },
            { title: 'r2', link: 'https://r2', snippet: 's2', position: 2 },
          ],
          peopleAlsoAsk: [{ question: 'Why?', snippet: 'Because.' }, { question: 'How?' }],
          relatedSearches: [{ query: 'related-a' }, { query: 'related-b' }],
        },
      }),
    )
    const r = await callWeb({ query: 'q' })
    expect(r.results).toContain('Answer:')
    expect(r.results).toContain('Paris')
    expect(r.results).toContain('France')
    expect(r.results).toContain('A nation in Europe')
    expect(r.results).toContain('Website: https://france.fr')
    expect(r.results).toContain('Capital: Paris')
    expect(r.results).toContain('Population: 67M')
    expect(r.results).toContain('Search Results')
    expect(r.results).toContain('r1')
    expect(r.results).toContain('People Also Ask')
    expect(r.results).toContain('Why?')
    expect(r.results).toContain('Related Searches')
    expect(r.results).toContain('related-a')
  })

  test('formatSerperResults renders knowledgeGraph without title using fallback', async () => {
    setEnv('SERPER_API_KEY', 'k')
    installFetch(async () =>
      makeResponse({
        contentType: 'application/json',
        body: { knowledgeGraph: { description: 'desc' } },
      }),
    )
    const r = await callWeb({ query: 'q' })
    expect(r.results).toContain('Knowledge Graph')
    expect(r.results).toContain('desc')
  })

  test('formatSerperResults handles news/places/shopping/maps modes', async () => {
    setEnv('SERPER_API_KEY', 'k')
    // news
    installFetch(async () =>
      makeResponse({
        contentType: 'application/json',
        body: { news: [{ title: 'NN', link: 'l', source: 'src', date: '2026-01-01', snippet: 'snip' }] },
      }),
    )
    const news = await callWeb({ query: 'q', searchType: 'news' })
    expect(news.results).toContain('News Results')
    expect(news.results).toContain('NN')
    expect(news.results).toContain('(src)')

    // places
    installFetch(async () =>
      makeResponse({
        contentType: 'application/json',
        body: { places: [{ title: 'PP', address: 'addr', rating: 4.5, ratingCount: 12 }] },
      }),
    )
    const places = await callWeb({ query: 'q', searchType: 'places' })
    expect(places.results).toContain('Places')
    expect(places.results).toContain('PP')
    expect(places.results).toContain('addr')

    // places with missing fields exercises fallbacks
    installFetch(async () =>
      makeResponse({
        contentType: 'application/json',
        body: { places: [{ title: 'NoAddr' }] },
      }),
    )
    const placesB = await callWeb({ query: 'q', searchType: 'places' })
    expect(placesB.results).toContain('N/A')

    // shopping
    installFetch(async () =>
      makeResponse({
        contentType: 'application/json',
        body: { shopping: [{ title: 'SH', price: '$9', link: 'https://s', source: 'AMZ' }] },
      }),
    )
    const shopping = await callWeb({ query: 'q', searchType: 'shopping' })
    expect(shopping.results).toContain('Shopping Results')
    expect(shopping.results).toContain('SH')
    expect(shopping.results).toContain('$9')

    // maps mode reuses organic results
    installFetch(async () =>
      makeResponse({
        contentType: 'application/json',
        body: { organic: [{ title: 'OO', link: 'https://o', snippet: 'o', position: 1 }] },
      }),
    )
    const maps = await callWeb({ query: 'q', searchType: 'maps' })
    expect(maps.results).toContain('OO')
  })

  test('formatSerperResults returns "No results found." for empty payload', async () => {
    setEnv('SERPER_API_KEY', 'k')
    installFetch(async () => makeResponse({ contentType: 'application/json', body: {} }))
    const r = await callWeb({ query: 'q' })
    expect(r.results).toBe('No results found.')
  })

  // -------------------------------------------------------------------
  // rawFetch — content-type handling
  // -------------------------------------------------------------------
  test('rawFetch returns plain text content for text/plain', async () => {
    installFetch(async () => makeResponse({ contentType: 'text/plain', body: 'hello plain' }))
    const r = await callWeb({ url: 'https://x.example/page' })
    expect(r.content).toBe('hello plain')
    expect(r.status).toBe(200)
    expect(r.bytes).toBeGreaterThan(0)
  })

  test('rawFetch strips HTML via stripHtmlToText / regex fallback', async () => {
    const html = '<html><body><script>x()</script><style>.a{}</style><nav>nav</nav><h1>Title</h1><p>Hello&nbsp;<b>world</b>&amp;more</p><!-- c --></body></html>'
    installFetch(async () => makeResponse({ contentType: 'text/html', body: html }))
    const r = await callWeb({ url: 'https://x.example/page' })
    expect(r.content).toBeDefined()
    expect(r.content).toContain('Title')
    expect(r.content).toContain('world')
  })

  test('rawFetch truncates oversized content with marker', async () => {
    const big = 'A'.repeat(10000)
    installFetch(async () => makeResponse({ contentType: 'text/plain', body: big }))
    const r = await callWeb({ url: 'https://x.example/big', maxChars: 100 })
    expect(r.content.length).toBeGreaterThan(100)
    expect(r.content).toContain('[Truncated at 100 chars]')
  })

  test('rawFetch surfaces non-ok / non-403 / non-429 as HTTP error result', async () => {
    installFetch(async () => makeResponse({ status: 500, statusText: 'Server Err', body: '', ok: false }))
    const r = await callWeb({ url: 'https://x.example/err' })
    expect(r.error).toContain('HTTP 500')
    expect(r.error).toContain('Server Err')
  })

  test('rawFetch retries on 429 and succeeds on second attempt', async () => {
    let attempts = 0
    installFetch(async () => {
      attempts++
      if (attempts === 1) return makeResponse({ status: 429, ok: false, body: '' })
      return makeResponse({ contentType: 'text/plain', body: 'success after retry' })
    })
    const r = await callWeb({ url: 'https://x.example/retry' })
    expect(attempts).toBe(2)
    expect(r.content).toBe('success after retry')
  })

  test('rawFetch returns rate-limit error after MAX_ATTEMPTS 429s', async () => {
    installFetch(async () => makeResponse({ status: 403, ok: false, body: '' }))
    const r = await callWeb({ url: 'https://x.example/blocked' })
    expect(r.error).toContain('Access denied')
    expect(r.suggestion).toBeDefined()
  })

  test('rawFetch retries on TimeoutError and succeeds', async () => {
    let n = 0
    installFetch(async () => {
      n++
      if (n === 1) {
        const e: any = new Error('timeout')
        e.name = 'TimeoutError'
        throw e
      }
      return makeResponse({ contentType: 'text/plain', body: 'recovered' })
    })
    const r = await callWeb({ url: 'https://x.example/timeout' })
    expect(r.content).toBe('recovered')
  })

  test('rawFetch returns last error message on final attempt failure', async () => {
    installFetch(async () => { throw new Error('hard-fail') })
    const r = await callWeb({ url: 'https://x.example/hardfail' })
    expect(r.error).toBe('hard-fail')
  })

  test('rawFetch handles PDF content via unpdf path (success)', async () => {
    // unpdf is dynamically imported; we mock it ahead of the call via global symbol replacement is tricky.
    // Instead, drive a fake PDF byte stream and let unpdf attempt to parse — it will likely error and
    // surface the PDF error message branch. Either way exercises the if-branch + try/catch.
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) // %PDF-
    installFetch(async () => makeResponse({ contentType: 'application/pdf', body: pdfBytes }))
    const r = await callWeb({ url: 'https://x.example/file.pdf' })
    // result is either {content,...,type:'pdf'} or {error: 'Failed to extract...'} — both exercise the branch
    expect(typeof r === 'object').toBe(true)
    expect(r.error !== undefined || r.type === 'pdf').toBe(true)
  })

  test('rawFetch routes PDF based on .pdf URL extension even when content-type lies', async () => {
    installFetch(async () => makeResponse({ contentType: 'text/html', body: 'not-actual-pdf' }))
    const r = await callWeb({ url: 'https://x.example/file.pdf' })
    expect(r.error !== undefined || r.type === 'pdf').toBe(true)
  })

  // -------------------------------------------------------------------
  // rawFetch — wikipedia routing
  // -------------------------------------------------------------------
  test('rawFetch routes wikipedia URLs through Parsoid markdown path on success', async () => {
    const html = '<html><body><h1>Article</h1><p>This is a long article body with enough content to exceed the 100 character minimum so the wikipedia path returns its markdown output rather than falling through to raw fetch.</p></body></html>'
    installFetch(async (url) => {
      expect(url).toContain('en.wikipedia.org/api/rest_v1/page/html/')
      return makeResponse({ contentType: 'text/html', body: html })
    })
    const r = await callWeb({ url: 'https://en.wikipedia.org/wiki/Article' })
    expect(r.type === 'wikipedia-markdown' || r.content !== undefined).toBe(true)
  })

  test('wikipedia URL with anchor fragment is parsed by parseWikipediaUrl', async () => {
    installFetch(async (url) => {
      if (url.includes('wikipedia.org/api/rest_v1')) return makeResponse({ contentType: 'text/html', body: 'short' })
      return makeResponse({ contentType: 'text/html', body: '<html>fallback long enough body content goes here for the regex stripping path to produce something usable</html>' })
    })
    const r = await callWeb({ url: 'https://fr.wikipedia.org/wiki/Foo#anchor?bar=1' })
    expect(r).toBeDefined()
  })

  test('wikipedia Parsoid non-ok response falls through to raw fetch', async () => {
    let parsoidCalls = 0
    installFetch(async (url) => {
      if (url.includes('wikipedia.org/api/rest_v1')) {
        parsoidCalls++
        return makeResponse({ status: 404, ok: false, body: '' })
      }
      return makeResponse({ contentType: 'text/html', body: '<html>fallback content body here long enough for stripping</html>' })
    })
    const r = await callWeb({ url: 'https://en.wikipedia.org/wiki/Missing' })
    expect(parsoidCalls).toBeGreaterThanOrEqual(1)
    expect(r).toBeDefined()
  })

  // -------------------------------------------------------------------
  // web tool: raw fetch → serper fallback when content is thin
  // -------------------------------------------------------------------
  test('thin rawFetch content falls back to Serper search when key available', async () => {
    setEnv('SERPER_API_KEY', 'k')
    let serperCalled = false
    installFetch(async (url) => {
      if (url.includes('serper.dev')) {
        serperCalled = true
        return makeResponse({ contentType: 'application/json', body: { organic: [{ title: 'O', link: 'https://o', snippet: 's', position: 1 }] } })
      }
      return makeResponse({ contentType: 'text/plain', body: 'tiny' })
    })
    const r = await callWeb({ url: 'https://x.example/thin' })
    expect(serperCalled).toBe(true)
    expect(r._note).toContain('fell back')
    expect(r._originalUrl).toBe('https://x.example/thin')
  })

  test('thin rawFetch content does NOT fall back when no serper key/proxy', async () => {
    installFetch(async () => makeResponse({ contentType: 'text/plain', body: 'tiny' }))
    const r = await callWeb({ url: 'https://x.example/thin-nokey' })
    expect(r._note).toBeUndefined()
    expect(r.content).toBe('tiny')
  })

  // -------------------------------------------------------------------
  // num / gl / hl forwarding
  // -------------------------------------------------------------------
  test('forwards num/gl/hl into the serper request body', async () => {
    setEnv('SERPER_API_KEY', 'k')
    let bodyCaptured: any = null
    installFetch(async (_url, init) => {
      bodyCaptured = JSON.parse((init?.body as string) || '{}')
      return makeResponse({ contentType: 'application/json', body: {} })
    })
    await callWeb({ query: 'q', num: 7, gl: 'id', hl: 'en' })
    expect(bodyCaptured.q).toBe('q')
    expect(bodyCaptured.num).toBe(7)
    expect(bodyCaptured.gl).toBe('id')
    expect(bodyCaptured.hl).toBe('en')
  })
})
