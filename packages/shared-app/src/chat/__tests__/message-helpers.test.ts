// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'vitest'
import {
  extractTextContent,
  formatErrorMessage,
  isTunnelDisconnectError,
  formatToolName,
  getToolCategory,
  ERROR_CODE_MESSAGES,
} from '../message-helpers'

describe('extractTextContent', () => {
  it('returns content string when present', () => {
    expect(extractTextContent({ content: 'Hello world' })).toBe('Hello world')
  })

  it('extracts text from parts array', () => {
    const message = {
      parts: [
        { type: 'text', text: 'Hello ' },
        { type: 'tool-call' },
        { type: 'text', text: 'world' },
      ],
    }
    expect(extractTextContent(message)).toBe('Hello world')
  })

  it('prefers content string over parts', () => {
    const message = {
      content: 'from content',
      parts: [{ type: 'text', text: 'from parts' }],
    }
    expect(extractTextContent(message)).toBe('from content')
  })

  it('returns empty string when no content or parts', () => {
    expect(extractTextContent({})).toBe('')
  })

  it('returns empty string when content is empty string', () => {
    expect(extractTextContent({ content: '' })).toBe('')
  })

  it('handles parts with missing text', () => {
    const message = { parts: [{ type: 'text' }, { type: 'text', text: 'ok' }] }
    expect(extractTextContent(message)).toBe('ok')
  })
})

describe('ERROR_CODE_MESSAGES', () => {
  it('has messages for all known error codes', () => {
    const codes = ['pod_unavailable', 'rate_limit_exceeded', 'usage_limit_reached',
      'insufficient_credits', 'session_expired', 'internal_error', 'shutting_down', 'offline']
    for (const code of codes) {
      expect(ERROR_CODE_MESSAGES[code]).toBeDefined()
      expect(typeof ERROR_CODE_MESSAGES[code]).toBe('string')
    }
  })
})

describe('isTunnelDisconnectError', () => {
  it('detects tunnel disconnect patterns', () => {
    expect(isTunnelDisconnectError('tunnel disconnected')).toBe(true)
    expect(isTunnelDisconnectError('instance is offline')).toBe(true)
    expect(isTunnelDisconnectError('stream error occurred')).toBe(true)
    expect(isTunnelDisconnectError('stream timed out')).toBe(true)
  })

  it('detects connection error patterns', () => {
    expect(isTunnelDisconnectError('network error')).toBe(true)
    expect(isTunnelDisconnectError('fetch failed')).toBe(true)
    expect(isTunnelDisconnectError('ECONNRESET')).toBe(true)
    expect(isTunnelDisconnectError('socket hang up')).toBe(true)
  })

  it('detects JSON-wrapped offline error', () => {
    const json = JSON.stringify({ error: { code: 'offline' } })
    expect(isTunnelDisconnectError(json)).toBe(true)
  })

  it('detects JSON-wrapped tunnel message', () => {
    const json = JSON.stringify({ error: { message: 'tunnel disconnected' } })
    expect(isTunnelDisconnectError(json)).toBe(true)
  })

  it('returns false for normal errors', () => {
    expect(isTunnelDisconnectError('something else went wrong')).toBe(false)
    expect(isTunnelDisconnectError('invalid input')).toBe(false)
  })
})

describe('formatErrorMessage', () => {
  it('returns friendly message for known error codes in JSON', () => {
    const json = JSON.stringify({ error: { code: 'rate_limit_exceeded' } })
    expect(formatErrorMessage(json)).toBe(ERROR_CODE_MESSAGES.rate_limit_exceeded)
  })

  it('returns error.message from JSON', () => {
    const json = JSON.stringify({ error: { message: 'Custom error text' } })
    expect(formatErrorMessage(json)).toBe('Custom error text')
  })

  it('returns top-level message from JSON', () => {
    const json = JSON.stringify({ message: 'Top level' })
    expect(formatErrorMessage(json)).toBe('Top level')
  })

  it('returns connection interrupted for network errors', () => {
    expect(formatErrorMessage('fetch failed')).toBe('Connection interrupted. Please tap Retry to continue.')
    expect(formatErrorMessage('ECONNREFUSED')).toBe('Connection interrupted. Please tap Retry to continue.')
  })

  it('returns raw message when not JSON and no pattern match', () => {
    expect(formatErrorMessage('Some random error')).toBe('Some random error')
  })
})

describe('formatToolName', () => {
  it('formats MCP tool names with dots', () => {
    expect(formatToolName('mcp__shogo__store_query')).toBe('shogo.store_query')
  })

  it('handles MCP tools with single part', () => {
    expect(formatToolName('mcp__toolname')).toBe('toolname')
  })

  it('returns non-MCP names unchanged', () => {
    expect(formatToolName('Read')).toBe('Read')
    expect(formatToolName('Write')).toBe('Write')
    expect(formatToolName('custom_tool')).toBe('custom_tool')
  })
})

describe('getToolCategory', () => {
  it('categorizes MCP tools', () => {
    expect(getToolCategory('mcp__shogo__query')).toBe('mcp')
    expect(getToolCategory('mcp__github__pr')).toBe('mcp')
  })

  it('categorizes file tools', () => {
    expect(getToolCategory('Read')).toBe('file')
    expect(getToolCategory('Write')).toBe('file')
    expect(getToolCategory('Edit')).toBe('file')
    expect(getToolCategory('Glob')).toBe('file')
    expect(getToolCategory('Grep')).toBe('file')
  })

  it('categorizes skill tools', () => {
    expect(getToolCategory('Skill')).toBe('skill')
    expect(getToolCategory('Task')).toBe('skill')
  })

  it('returns other for unknown tools', () => {
    expect(getToolCategory('CustomTool')).toBe('other')
    expect(getToolCategory('something')).toBe('other')
  })
})
