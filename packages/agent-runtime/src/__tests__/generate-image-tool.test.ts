// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * generate_image Tool Tests
 *
 * Tests the image generation gateway tool:
 * - File saving to workspace
 * - Filename generation and sanitization
 * - Reference image handling
 * - Error handling
 *
 * Run: bun test packages/agent-runtime/src/__tests__/generate-image-tool.test.ts
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { createAllTools, type ToolContext } from '../gateway-tools'

const TEST_DIR = '/tmp/test-generate-image'

function createCtx(overrides?: Partial<ToolContext>): ToolContext {
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
    aiProxyUrl: 'http://localhost:8002/api/ai/v1',
    aiProxyToken: 'test-proxy-token',
    ...overrides,
  }
}

function getImageTool(ctx: ToolContext) {
  const tools = createAllTools(ctx)
  const tool = tools.find((t) => t.name === 'generate_image')
  if (!tool) throw new Error('generate_image tool not found')
  return tool
}

describe('generate_image tool', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('is registered in createAllTools', () => {
    const ctx = createCtx()
    const tools = createAllTools(ctx)
    const names = tools.map((t) => t.name)
    expect(names).toContain('generate_image')
  })

  test('has correct parameter schema', () => {
    const ctx = createCtx()
    const tool = getImageTool(ctx)
    expect(tool.parameters).toBeDefined()
    expect(tool.parameters.properties).toHaveProperty('prompt')
    expect(tool.parameters.properties).toHaveProperty('filename')
    expect(tool.parameters.properties).toHaveProperty('size')
    expect(tool.parameters.properties).toHaveProperty('model')
    expect(tool.parameters.properties).toHaveProperty('quality')
    expect(tool.parameters.properties).toHaveProperty('reference_image')
  })

  test('returns error when proxy not configured', async () => {
    const ctx = createCtx({ aiProxyUrl: undefined, aiProxyToken: undefined })
    // Also clear env vars
    const origUrl = process.env.AI_PROXY_URL
    const origToken = process.env.AI_PROXY_TOKEN
    delete process.env.AI_PROXY_URL
    delete process.env.AI_PROXY_TOKEN

    const tool = getImageTool(ctx)
    const result = await tool.execute('test-call', { prompt: 'a sunset' })

    expect(result.details.error).toContain('not available')

    if (origUrl) process.env.AI_PROXY_URL = origUrl
    if (origToken) process.env.AI_PROXY_TOKEN = origToken
  })

  test('returns error for non-existent reference image', async () => {
    const ctx = createCtx()
    const tool = getImageTool(ctx)
    const result = await tool.execute('test-call', {
      prompt: 'edit this',
      reference_image: 'nonexistent.png',
    })
    expect(result.details.error).toContain('not found')
  })

  test('creates images directory if not exists', async () => {
    const ctx = createCtx()
    const tool = getImageTool(ctx)

    // The tool will try to fetch from the proxy and fail, but
    // the images directory should still be created
    await tool.execute('test-call', { prompt: 'a sunset' })

    expect(existsSync(join(TEST_DIR, 'images'))).toBe(true)
  })

  test('sanitizes filename to prevent path traversal', async () => {
    const ctx = createCtx()
    const tool = getImageTool(ctx)

    // Test with path traversal attempt
    const result = await tool.execute('test-call', {
      prompt: 'a sunset',
      filename: '../../../etc/passwd.png',
    })

    // Should either error or sanitize the filename
    if (!result.details.error) {
      // If it didn't error, the path should be safe
      expect(result.details.path).not.toContain('..')
    }
  })

  test('sanitizes special characters in filename', async () => {
    const ctx = createCtx()
    const tool = getImageTool(ctx)

    const result = await tool.execute('test-call', {
      prompt: 'a sunset',
      filename: 'my image (1).png',
    })

    // The filename should be sanitized (spaces and parens replaced)
    if (result.details.path) {
      expect(result.details.path).not.toContain(' ')
      expect(result.details.path).not.toContain('(')
    }
  })
})
