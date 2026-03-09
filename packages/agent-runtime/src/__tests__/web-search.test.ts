// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { createAllTools, type ToolContext } from '../gateway-tools'

const TEST_DIR = '/tmp/test-web-search'

const SERPER_API_KEY = process.env.SERPER_API_KEY

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
  const tools = createAllTools(ctx)
  const tool = tools.find(t => t.name === 'web')
  if (!tool) throw new Error('web tool not found in createAllTools()')
  return tool
}

async function search(params: Record<string, any>) {
  const ctx = createCtx()
  const tool = getWebTool(ctx)
  const result = await tool.execute('test-call', params)
  return result.details
}

describe('web tool', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('tool is registered in createAllTools', () => {
    const ctx = createCtx()
    const tools = createAllTools(ctx)
    const names = tools.map(t => t.name)
    expect(names).toContain('web')
  })

  test('tool has correct parameter schema', () => {
    const ctx = createCtx()
    const tool = getWebTool(ctx)
    expect(tool.parameters).toBeDefined()
    expect(tool.parameters.properties.url).toBeDefined()
    expect(tool.parameters.properties.query).toBeDefined()
    expect(tool.parameters.properties.searchType).toBeDefined()
    expect(tool.parameters.properties.num).toBeDefined()
    expect(tool.parameters.properties.gl).toBeDefined()
    expect(tool.parameters.properties.hl).toBeDefined()
    expect(tool.parameters.properties.maxChars).toBeDefined()
  })

  test('returns error when neither url nor query provided', async () => {
    const result = await search({})
    expect(result.error).toContain('Provide either')
  })

  test('returns error when SERPER_API_KEY is not set (query mode)', async () => {
    const originalKey = process.env.SERPER_API_KEY
    delete process.env.SERPER_API_KEY

    try {
      const result = await search({ query: 'test' })
      expect(result.error).toContain('SERPER_API_KEY not configured')
    } finally {
      if (originalKey) process.env.SERPER_API_KEY = originalKey
    }
  })

  test('fetches a URL directly when no Google routing needed', async () => {
    const result = await search({ url: 'https://httpbin.org/json' })
    expect(result.error).toBeUndefined()
    expect(result.content).toBeDefined()
    expect(result.status).toBe(200)
  }, 15000)
})

// Live API tests — only run when SERPER_API_KEY is available
const describeLive = SERPER_API_KEY ? describe : describe.skip

describeLive('web tool live API tests', () => {
  beforeAll(() => {
    if (!SERPER_API_KEY) throw new Error('SERPER_API_KEY required for live tests')
    process.env.SERPER_API_KEY = SERPER_API_KEY
  })

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('basic search returns structured results', async () => {
    const result = await search({ query: 'TypeScript programming language', num: 5 })

    expect(result.error).toBeUndefined()
    expect(result.results).toBeDefined()
    expect(typeof result.results).toBe('string')
    expect(result.results.length).toBeGreaterThan(50)
    expect(result.raw).toBeDefined()
    expect(result.raw.organic).toBeDefined()
    expect(Array.isArray(result.raw.organic)).toBe(true)
    expect(result.raw.organic.length).toBeGreaterThan(0)

    const firstResult = result.raw.organic[0]
    expect(firstResult.title).toBeDefined()
    expect(firstResult.link).toBeDefined()
    expect(typeof firstResult.link).toBe('string')
    expect(firstResult.link.startsWith('http')).toBe(true)
  }, 15000)

  test('Google Maps directions URL auto-routes to Serper search', async () => {
    const result = await search({
      url: 'https://www.google.com/maps/dir/2220+Bella+Vista+Drive,+Montecito,+CA/Los+Angeles+International+Airport,+World+Way,+Los+Angeles,+CA',
    })

    expect(result.error).toBeUndefined()
    expect(result.results).toBeDefined()
    expect(result.query).toContain('directions from')
    expect(result.searchType).toBe('search')
  }, 15000)

  test('Google Maps place URL auto-routes to Serper places', async () => {
    const result = await search({
      url: 'https://www.google.com/maps/place/Eiffel+Tower',
    })

    expect(result.error).toBeUndefined()
    expect(result.results).toBeDefined()
    expect(result.searchType).toBe('places')
  }, 15000)

  test('flight search returns relevant results', async () => {
    const result = await search({
      query: 'flights from Los Angeles LAX to Bali Denpasar DPS April 20 2026',
      num: 10,
    })

    expect(result.error).toBeUndefined()
    expect(result.results).toBeDefined()
    expect(result.raw).toBeDefined()
    expect(result.raw.organic?.length).toBeGreaterThan(0)

    const allText = result.results.toLowerCase()
    const hasFlightContent =
      allText.includes('flight') ||
      allText.includes('airline') ||
      allText.includes('lax') ||
      allText.includes('bali') ||
      allText.includes('denpasar')
    expect(hasFlightContent).toBe(true)
  }, 15000)

  test('news search type works', async () => {
    const result = await search({
      query: 'artificial intelligence',
      searchType: 'news',
      num: 5,
    })

    expect(result.error).toBeUndefined()
    expect(result.raw).toBeDefined()
    expect(result.searchType).toBe('news')
    if (result.raw.news) {
      expect(Array.isArray(result.raw.news)).toBe(true)
      expect(result.raw.news.length).toBeGreaterThan(0)
      expect(result.raw.news[0].title).toBeDefined()
    }
  }, 15000)

  test('places search type works', async () => {
    const result = await search({
      query: 'best restaurants in Seminyak Bali',
      searchType: 'places',
      num: 5,
    })

    expect(result.error).toBeUndefined()
    expect(result.raw).toBeDefined()
    expect(result.searchType).toBe('places')
  }, 15000)

  test('localized search with gl and hl params', async () => {
    const result = await search({
      query: 'restaurants near me',
      gl: 'id',
      hl: 'en',
      num: 5,
    })

    expect(result.error).toBeUndefined()
    expect(result.raw?.organic?.length).toBeGreaterThan(0)
  }, 15000)

  test('formatted results contain markdown structure', async () => {
    const result = await search({ query: 'What is the capital of France', num: 5 })

    expect(result.error).toBeUndefined()
    expect(result.results).toBeDefined()
    const hasFormatting =
      result.results.includes('**') ||
      result.results.includes('Search Results') ||
      result.results.includes('Answer')
    expect(hasFormatting).toBe(true)
  }, 15000)
})
