// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for terminal-selection and AddToChatButton.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { captureTerminalText, formatTerminalContextForChat } from '../terminal-selection'
import { dispatchAddToChat, onAddToChat, ADD_TO_CHAT_EVENT } from '../add-to-chat-button'

// ─── terminal-selection ──────────────────────────────────────────────

describe('terminal-selection', () => {
  function mockTerminal(selection: string = '', lines: string[] = []) {
    const bufferLines = lines.map((text) => ({
      translateToString: () => text,
    }))
    return {
      getSelection: () => selection,
      buffer: {
        active: {
          length: lines.length,
          baseY: 0,
          getLine: (i: number) => bufferLines[i] ?? null,
        },
      },
    } as any
  }

  describe('captureTerminalText', () => {
    it('returns user selection when text is selected', () => {
      const term = mockTerminal('$ echo hello\nhello')
      const result = captureTerminalText(term)
      expect(result.text).toBe('$ echo hello\nhello')
      expect(result.isSelection).toBe(true)
    })

    it('falls back to scrollback when no selection', () => {
      const term = mockTerminal('', ['$ ls', 'file1.txt', 'file2.txt', '$ '])
      const result = captureTerminalText(term)
      expect(result.text).toContain('$ ls')
      expect(result.text).toContain('file1.txt')
      expect(result.isSelection).toBe(false)
    })

    it('trims leading empty lines from scrollback', () => {
      const term = mockTerminal('', ['', '', '$ echo hi', 'hi'])
      const result = captureTerminalText(term)
      expect(result.text).toBe('$ echo hi\nhi')
    })

    it('respects maxLines option', () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
      const term = mockTerminal('', lines)
      const result = captureTerminalText(term, { maxLines: 5 })
      expect(result.text).toContain('line 95')
      expect(result.text).toContain('line 99')
      expect(result.text).not.toContain('line 0')
    })

    it('includes cwd when provided', () => {
      const term = mockTerminal('$ pwd')
      const result = captureTerminalText(term, { cwd: '/Users/test' })
      expect(result.cwd).toBe('/Users/test')
    })

    it('returns empty text for empty terminal', () => {
      const term = mockTerminal('')
      const result = captureTerminalText(term)
      expect(result.text).toBe('')
    })
  })

  describe('formatTerminalContextForChat', () => {
    it('wraps text in CONTEXT block with delimiters', () => {
      const result = formatTerminalContextForChat({
        text: '$ ls\nfile1.txt',
        isSelection: false,
        cwd: '/tmp',
      })
      expect(result).toContain('[CONTEXT — auto-generated, do not cite directly]')
      expect(result).toContain('[END CONTEXT]')
      expect(result).toContain('$ ls\nfile1.txt')
      expect(result).toContain('cwd: /tmp')
    })

    it('includes cwd only when provided', () => {
      const withCwd = formatTerminalContextForChat({ text: 'hi', isSelection: true, cwd: '/a' })
      expect(withCwd).toContain('cwd: /a')

      const noCwd = formatTerminalContextForChat({ text: 'hi', isSelection: true, cwd: null })
      expect(noCwd).not.toContain('cwd:')
    })
  })
})

// ─── AddToChatButton events ──────────────────────────────────────────

describe('AddToChatButton event system', () => {
  // Minimal window mock for event dispatching
  const listeners = new Map<string, Set<EventListener>>()
  const mockWindow = {
    addEventListener: (type: string, handler: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(handler)
    },
    removeEventListener: (type: string, handler: EventListener) => {
      listeners.get(type)?.delete(handler)
    },
    dispatchEvent: (event: Event) => {
      listeners.get(event.type)?.forEach((handler) => handler(event))
      return true
    },
  }

  beforeEach(() => {
    listeners.clear()
    // Replace global window with mock
    ;(globalThis as any).window = mockWindow
  })

  afterEach(() => {
    delete (globalThis as any).window
    listeners.clear()
  })

  it('dispatchAddToChat sends a custom event', () => {
    let received = ''
    const unsub = onAddToChat((text) => { received = text })

    dispatchAddToChat('$ echo test')
    expect(received).toBe('$ echo test')
    unsub()
  })

  it('onAddToChat returns unsubscribe function', () => {
    let count = 0
    const unsub = onAddToChat(() => { count++ })

    dispatchAddToChat('a')
    dispatchAddToChat('b')
    expect(count).toBe(2)

    unsub()
    dispatchAddToChat('c')
    expect(count).toBe(2)
  })

  it('multiple listeners all receive events', () => {
    const results: string[] = []
    const unsub1 = onAddToChat((t) => results.push('a:' + t))
    const unsub2 = onAddToChat((t) => results.push('b:' + t))

    dispatchAddToChat('hello')
    expect(results).toContain('a:hello')
    expect(results).toContain('b:hello')

    unsub1()
    unsub2()
  })
})
