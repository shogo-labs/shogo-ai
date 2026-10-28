// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Eval mocks for integration tools must hit the same result-size cap as the
 * real Composio path (composio.ts: smartTruncateJson at
 * COMPOSIO_MAX_RESULT_CHARS, default 25k, plus a TRUNCATED annotation).
 * Uncapped mock payloads (1.1M chars) blew a 2M-token context in evals.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { AgentGateway, capIntegrationMockResult } from '../gateway'

const TEST_DIR = '/tmp/test-gw-mock-result-cap'

function setupWorkspace(): void {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(join(TEST_DIR, 'memory'), { recursive: true })
  mkdirSync(join(TEST_DIR, 'skills'), { recursive: true })
  writeFileSync(join(TEST_DIR, 'config.json'), JSON.stringify({
    heartbeatInterval: 1800,
    heartbeatEnabled: false,
    quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
    channels: [],
    model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
  }))
  writeFileSync(join(TEST_DIR, 'AGENTS.md'), '# Identity\nMock cap\n')
  writeFileSync(join(TEST_DIR, 'MEMORY.md'), '# Memory\n')
}

afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }))

function hugePayload(): { successful: boolean; data: { items: Array<{ id: number; text: string }> } } {
  return {
    successful: true,
    data: { items: Array.from({ length: 5000 }, (_, i) => ({ id: i, text: 'x'.repeat(200) })) },
  }
}

function text(result: any): string {
  return result.content[0].text as string
}

describe('capIntegrationMockResult', () => {
  test('caps a huge payload at the Composio limit and annotates it', () => {
    const out = text(capIntegrationMockResult('SHOPIFY_LIST_PRODUCTS', hugePayload()))
    expect(out.length).toBeLessThan(27_000)
    expect(out).toContain('TRUNCATED')
    expect(out).toContain('skill server pattern')
  })

  test('small payloads pass through unchanged', () => {
    const data = { successful: true, data: { id: 1 } }
    const result: any = capIntegrationMockResult('GMAIL_SEND_EMAIL', data)
    expect(result.details).toEqual(data)
    expect(text(result)).not.toContain('TRUNCATED')
  })

  test('respects COMPOSIO_MAX_RESULT_CHARS', () => {
    const prev = process.env.COMPOSIO_MAX_RESULT_CHARS
    process.env.COMPOSIO_MAX_RESULT_CHARS = '200000'
    try {
      const out = text(capIntegrationMockResult('SHOPIFY_LIST_PRODUCTS', hugePayload()))
      expect(out.length).toBeGreaterThan(100_000)
      expect(out.length).toBeLessThan(202_000)
    } finally {
      if (prev === undefined) delete process.env.COMPOSIO_MAX_RESULT_CHARS
      else process.env.COMPOSIO_MAX_RESULT_CHARS = prev
    }
  })

  test('Google Docs results get the export hint', () => {
    const doc = { data: { body: 'y'.repeat(100_000), more: 'z'.repeat(100_000) } }
    expect(text(capIntegrationMockResult('GOOGLEDOCS_GET_DOCUMENT_BY_ID', doc))).toContain('GOOGLEDRIVE_EXPORT_FILE')
  })
})

describe('promoted integration mocks are capped', () => {
  let gw: AgentGateway
  beforeEach(() => {
    setupWorkspace()
    gw = new AgentGateway(TEST_DIR, 'test-project')
  })

  test('a promoted hidden mock returns the capped result', async () => {
    gw.setToolMocks(
      { SHOPIFY_LIST_PRODUCTS: () => hugePayload() },
      { SHOPIFY_LIST_PRODUCTS: { description: 'List products', paramKeys: [] } },
      new Set(['SHOPIFY_LIST_PRODUCTS']),
    )
    gw._promoteHiddenMocksFromInstall({ tools: ['SHOPIFY_LIST_PRODUCTS'] })
    const tool = (gw as any).promotedMockTools.find((t: any) => t.name === 'SHOPIFY_LIST_PRODUCTS')
    const result = await tool.execute('c1', {})
    expect(text(result).length).toBeLessThan(27_000)
    expect(text(result)).toContain('TRUNCATED')
  })

  test('multipart mock results are not touched', async () => {
    const multipart = { __multipart: true, content: [{ type: 'text', text: 'x'.repeat(50_000) }] }
    gw.setToolMocks(
      { SHOPIFY_LIST_PRODUCTS: () => multipart },
      undefined,
      new Set(['SHOPIFY_LIST_PRODUCTS']),
    )
    gw._promoteHiddenMocksFromInstall({ tools: ['SHOPIFY_LIST_PRODUCTS'] })
    const tool = (gw as any).promotedMockTools[0]
    const result = await tool.execute('c1', {})
    expect(result.content[0].text.length).toBe(50_000)
  })
})
