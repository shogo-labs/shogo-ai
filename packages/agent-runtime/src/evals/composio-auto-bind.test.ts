// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Composio schema fetch integration tests
 *
 * Tests against the real Composio REST API to validate tool schema fetching
 * with output_parameters.
 *
 * Requires COMPOSIO_API_KEY env var. Tests are skipped if not set.
 */

import { afterEach, describe, test, expect } from 'bun:test'
import { fetchComposioToolSchemas, type ComposioToolSchema } from '../composio-auto-bind'

const API_KEY = process.env.COMPOSIO_API_KEY
const SKIP = !API_KEY

// ---------------------------------------------------------------------------
// Schema fetching
// ---------------------------------------------------------------------------

describe('fetchComposioToolSchemas', () => {
  test.skipIf(SKIP)('fetches Google Calendar tools with output schemas', async () => {
    const tools = await fetchComposioToolSchemas('googlecalendar')

    expect(tools.length).toBeGreaterThan(0)

    for (const tool of tools) {
      expect(tool.slug).toBeTruthy()
      expect(tool.name).toBeTruthy()
      expect(tool.input_parameters).toBeDefined()
      expect(tool.output_parameters).toBeDefined()
      expect(tool.tags).toBeInstanceOf(Array)
      expect(tool.toolkit?.slug).toBe('googlecalendar')
    }
  })

  test.skipIf(SKIP)('fetches GitHub tools', async () => {
    const tools = await fetchComposioToolSchemas('github', { important: true })

    expect(tools.length).toBeGreaterThan(0)

    const slugs = tools.map(t => t.slug)
    expect(slugs.some(s => s.includes('CREATE'))).toBe(true)
    expect(slugs.some(s => s.includes('LIST'))).toBe(true)
  })

  test.skipIf(SKIP)('fetches Linear tools', async () => {
    const tools = await fetchComposioToolSchemas('linear')

    expect(tools.length).toBeGreaterThan(0)
    expect(tools.some(t => t.slug.includes('ISSUE'))).toBe(true)
  })

  test.skipIf(SKIP)('output_parameters has data wrapper structure', async () => {
    const tools = await fetchComposioToolSchemas('googlecalendar')
    const listTool = tools.find(t => t.slug === 'GOOGLECALENDAR_EVENTS_LIST')

    expect(listTool).toBeDefined()
    const out = listTool!.output_parameters as ComposioToolSchema['output_parameters'] & {
      properties: Record<string, unknown>
    }
    expect(out.properties.data).toBeDefined()
    expect(out.properties.successful).toBeDefined()
    expect(out.properties.error).toBeDefined()

    // The list tool should have data.items array
    const dataProps = (out.properties.data as { properties: Record<string, unknown> }).properties
    expect(dataProps.items).toBeDefined()
    expect((dataProps.items as { type?: string }).type).toBe('array')
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  test('invalid API key throws', async () => {
    await expect(
      fetchComposioToolSchemas('googlecalendar', { apiKey: 'invalid_key_12345' })
    ).rejects.toThrow()
  })

  test.skipIf(SKIP)('non-existent toolkit returns empty', async () => {
    const tools = await fetchComposioToolSchemas('nonexistent_toolkit_xyz_999')
    expect(tools.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Fetch-mock coverage (lines 94-100)
// ---------------------------------------------------------------------------

describe('fetchComposioToolSchemas — mocked fetch paths', () => {
  const origFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = origFetch })

  test('throws on non-OK HTTP response (line 94 !res.ok branch)', async () => {
    globalThis.fetch = async () =>
      ({ ok: false, status: 429, statusText: 'Too Many Requests' }) as Response
    await expect(
      fetchComposioToolSchemas('sometoolkit', { apiKey: 'test-key' })
    ).rejects.toThrow('Composio API error: 429 Too Many Requests')
  })

  test('returns items from successful response (lines 96-100)', async () => {
    const fakeItem = { slug: 'TOOL_ONE', name: 'Tool One' }
    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => ({
          total_items: 1,
          current_page: 1,
          total_pages: 1,
          next_cursor: null,
          items: [fakeItem],
        }),
      }) as unknown as Response
    const log = console.log
    const logs: string[] = []
    console.log = (...a: any[]) => logs.push(a.join(' '))
    try {
      const tools = await fetchComposioToolSchemas('sometoolkit', { apiKey: 'test-key' })
      expect(tools).toHaveLength(1)
      expect(tools[0]!.slug).toBe('TOOL_ONE')
      // Verify the timing log was emitted (line 99).
      expect(logs.some((l) => l.includes('[Composio] [Timing]'))).toBe(true)
    } finally {
      console.log = log
    }
  })

  test('falls back to [] when items is missing from response', async () => {
    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => ({ total_items: 0, current_page: 1, total_pages: 0, items: undefined }),
      }) as unknown as Response
    const tools = await fetchComposioToolSchemas('sometoolkit', { apiKey: 'test-key' })
    expect(tools).toEqual([])
  })
})
