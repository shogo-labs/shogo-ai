// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import { runHeadless, projectIdForCwd, readPrintPrompt, type InteractiveGateway, type OutputSink } from '../run'
import type { TurnSink } from '../terminal-writer'

class StringSink implements OutputSink {
  data = ''
  write(chunk: string) {
    this.data += chunk
    return true
  }
}

/** A fake gateway that replays a scripted chunk sequence into the writer. */
function fakeGateway(script: Array<Record<string, any>>, opts: { throwError?: string } = {}): InteractiveGateway {
  return {
    async processChatMessageStream(_text: string, writer: TurnSink) {
      if (opts.throwError) throw new Error(opts.throwError)
      for (const chunk of script) writer.write(chunk)
    },
  }
}

describe('runHeadless (one-shot -p)', () => {
  test('streams assistant text to stdout and tool activity to stderr, exit 0', async () => {
    const out = new StringSink()
    const err = new StringSink()
    const gateway = fakeGateway([
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Looking…' },
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'read_file' },
      { type: 'tool-output-available', toolCallId: 'c1', output: { ok: true } },
      { type: 'text-delta', id: 't1', delta: ' done.' },
    ])

    const code = await runHeadless({ gateway, prompt: 'hi', sessionId: 's1', out, err })

    expect(code).toBe(0)
    expect(out.data).toContain('Looking… done.')
    expect(err.data).toContain('read_file')
  })

  test('returns 1 when the stream emits an error chunk', async () => {
    const out = new StringSink()
    const err = new StringSink()
    const gateway = fakeGateway([{ type: 'error', errorText: 'no model' }])

    const code = await runHeadless({ gateway, prompt: 'hi', sessionId: 's1', out, err })

    expect(code).toBe(1)
    expect(err.data).toContain('no model')
  })

  test('returns 1 when processChatMessageStream throws', async () => {
    const out = new StringSink()
    const err = new StringSink()
    const gateway = fakeGateway([], { throwError: 'kaboom' })

    const code = await runHeadless({ gateway, prompt: 'hi', sessionId: 's1', out, err })

    expect(code).toBe(1)
    expect(err.data).toContain('kaboom')
  })
})

describe('projectIdForCwd', () => {
  test('is stable and 24 hex chars', () => {
    const a = projectIdForCwd('/Users/jane/app')
    const b = projectIdForCwd('/Users/jane/app')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{24}$/)
    expect(projectIdForCwd('/Users/jane/other')).not.toBe(a)
  })
})

describe('readPrintPrompt', () => {
  test('reads -p value from argv', () => {
    expect(readPrintPrompt(['bun', 'bin', 'interactive', '-p', 'review this'], {})).toBe('review this')
  })

  test('reads --print=value form', () => {
    expect(readPrintPrompt(['bun', 'bin', '--print=hello'], {})).toBe('hello')
  })

  test('prefers SHOGO_PRINT_PROMPT env', () => {
    expect(readPrintPrompt(['bun', 'bin'], { SHOGO_PRINT_PROMPT: 'env prompt' })).toBe('env prompt')
  })

  test('returns undefined when no print flag', () => {
    expect(readPrintPrompt(['bun', 'bin', 'interactive'], {})).toBeUndefined()
  })
})
