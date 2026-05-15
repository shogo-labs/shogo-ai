// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/lib/interleaved-stream.ts — the AI SDK fullStream →
 * UIMessageChunk transformer that preserves text/tool interleaving
 * boundaries. The module is pure (no I/O, no network), so we feed it
 * hand-rolled async iterables and assert on the yielded chunks.
 */

import { describe, expect, test } from 'bun:test'
import {
  finalizeCurrentText,
  processInterleavedStream,
} from '../lib/interleaved-stream'

// ─── helpers ───────────────────────────────────────────────────────────────

async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

const TEXT_ID_RE = /^text-[A-Za-z0-9_-]+$/

// ─── text events ───────────────────────────────────────────────────────────

describe('text-delta', () => {
  test('first text-delta emits text-start then text-delta with same id', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([{ type: 'text-delta', text: 'hello' } as any]),
      ),
    )
    expect(out).toHaveLength(2)
    expect(out[0].type).toBe('text-start')
    expect(out[1].type).toBe('text-delta')
    const startId = (out[0] as any).id
    expect(startId).toMatch(TEXT_ID_RE)
    expect((out[1] as any).id).toBe(startId)
    expect((out[1] as any).delta).toBe('hello')
  })

  test('subsequent text-deltas reuse the same id (no second text-start)', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'text-delta', text: 'a' } as any,
          { type: 'text-delta', text: 'b' } as any,
          { type: 'text-delta', text: 'c' } as any,
        ]),
      ),
    )
    expect(out.map((c) => c.type)).toEqual([
      'text-start',
      'text-delta',
      'text-delta',
      'text-delta',
    ])
    const id = (out[0] as any).id
    expect((out[1] as any).id).toBe(id)
    expect((out[2] as any).id).toBe(id)
    expect((out[3] as any).id).toBe(id)
    expect(out.slice(1).map((c) => (c as any).delta)).toEqual(['a', 'b', 'c'])
  })

  test('renames event.text → chunk.delta (key contract with frontend)', async () => {
    const out = await collect(
      processInterleavedStream(fromArray([{ type: 'text-delta', text: 'X' } as any])),
    )
    const delta = out[1] as any
    expect(delta.delta).toBe('X')
    expect(delta.text).toBeUndefined()
  })
})

describe('text-start / text-end passthrough', () => {
  test('SDK text-start when no current text → generates our own start', async () => {
    const out = await collect(
      processInterleavedStream(fromArray([{ type: 'text-start', id: 'sdk-id' } as any])),
    )
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('text-start')
    expect((out[0] as any).id).not.toBe('sdk-id') // we override with our own id
    expect((out[0] as any).id).toMatch(TEXT_ID_RE)
  })

  test('SDK text-start when there is already a current text → no-op (idempotent)', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'text-delta', text: 'a' } as any,
          { type: 'text-start', id: 'ignored' } as any,
        ]),
      ),
    )
    expect(out.map((c) => c.type)).toEqual(['text-start', 'text-delta'])
  })

  test('SDK text-end finalizes the current text part', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'text-delta', text: 'a' } as any,
          { type: 'text-end', id: 'ignored' } as any,
        ]),
      ),
    )
    expect(out.map((c) => c.type)).toEqual(['text-start', 'text-delta', 'text-end'])
    const id = (out[0] as any).id
    expect((out[2] as any).id).toBe(id)
  })

  test('text-end with no open text part is a safe no-op', async () => {
    const out = await collect(
      processInterleavedStream(fromArray([{ type: 'text-end', id: 'x' } as any])),
    )
    expect(out).toHaveLength(0)
  })
})

// ─── tool events ──────────────────────────────────────────────────────────

describe('tool-input-start / interleaving boundary', () => {
  test('tool-input-start finalizes any open text BEFORE emitting tool chunk', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'text-delta', text: 'preamble' } as any,
          {
            type: 'tool-input-start',
            id: 'call-1',
            toolName: 'Bash',
            providerExecuted: false,
            dynamic: true,
            title: 'Run shell',
          } as any,
        ]),
      ),
    )
    expect(out.map((c) => c.type)).toEqual([
      'text-start',
      'text-delta',
      'text-end',
      'tool-input-start',
    ])
    const textId = (out[0] as any).id
    expect((out[2] as any).id).toBe(textId)
    const ti = out[3] as any
    expect(ti.toolCallId).toBe('call-1')
    expect(ti.toolName).toBe('Bash')
    expect(ti.providerExecuted).toBe(false)
    expect(ti.dynamic).toBe(true)
    expect(ti.title).toBe('Run shell')
  })

  test('two consecutive text-deltas, then a tool start, then text again → distinct text ids', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'text-delta', text: 'a' } as any,
          { type: 'text-delta', text: 'b' } as any,
          { type: 'tool-input-start', id: 'c1', toolName: 't' } as any,
          { type: 'tool-call', toolCallId: 'c1', toolName: 't', input: {} } as any,
          { type: 'tool-result', toolCallId: 'c1', output: 'ok' } as any,
          { type: 'text-delta', text: 'c' } as any,
        ]),
      ),
    )
    const firstId = (out[0] as any).id
    const lastTextStart = out.find((_, i) => i > 4 && out[i].type === 'text-start') as any
    expect(lastTextStart).toBeDefined()
    expect(lastTextStart.id).not.toBe(firstId)
    expect(lastTextStart.id).toMatch(TEXT_ID_RE)
  })
})

describe('tool-input-delta', () => {
  test('renames event.delta → chunk.inputTextDelta', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([{ type: 'tool-input-delta', id: 'c1', delta: '{"x":' } as any]),
      ),
    )
    expect(out).toHaveLength(1)
    const c = out[0] as any
    expect(c.type).toBe('tool-input-delta')
    expect(c.toolCallId).toBe('c1')
    expect(c.inputTextDelta).toBe('{"x":')
    expect(c.delta).toBeUndefined()
  })
})

describe('tool-input-end', () => {
  test('emits nothing (tool tracked until tool-call/tool-result)', async () => {
    const out = await collect(
      processInterleavedStream(fromArray([{ type: 'tool-input-end', id: 'c1' } as any])),
    )
    expect(out).toHaveLength(0)
  })
})

describe('tool-call', () => {
  test('emits tool-input-available with input from event.input', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'Bash',
            input: { cmd: 'ls' },
          } as any,
        ]),
      ),
    )
    expect(out).toHaveLength(1)
    const c = out[0] as any
    expect(c.type).toBe('tool-input-available')
    expect(c.toolCallId).toBe('c1')
    expect(c.toolName).toBe('Bash')
    expect(c.input).toEqual({ cmd: 'ls' })
  })
})

describe('tool-result success path', () => {
  test('emits tool-output-available with the output payload', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'tool-result', toolCallId: 'c1', output: { stdout: 'hi' } } as any,
        ]),
      ),
    )
    expect(out).toHaveLength(1)
    const c = out[0] as any
    expect(c.type).toBe('tool-output-available')
    expect(c.toolCallId).toBe('c1')
    expect(c.output).toEqual({ stdout: 'hi' })
  })
})

describe('tool-result error path (isError: true)', () => {
  test('string output is used as-is for errorText', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          {
            type: 'tool-result',
            toolCallId: 'c1',
            isError: true,
            output: 'command failed',
          } as any,
        ]),
      ),
    )
    expect(out[0].type).toBe('tool-output-error')
    expect((out[0] as any).errorText).toBe('command failed')
  })

  test('object output with stderr → errorText comes from .stderr', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          {
            type: 'tool-result',
            toolCallId: 'c1',
            isError: true,
            output: { stderr: 'bash: foo: not found', stdout: '' },
          } as any,
        ]),
      ),
    )
    expect((out[0] as any).errorText).toBe('bash: foo: not found')
  })

  test('object output without stderr → JSON.stringified', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          {
            type: 'tool-result',
            toolCallId: 'c1',
            isError: true,
            output: { code: 127 },
          } as any,
        ]),
      ),
    )
    expect((out[0] as any).errorText).toBe(JSON.stringify({ code: 127 }))
  })

  test('null output → generic fallback text', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'tool-result', toolCallId: 'c1', isError: true, output: null } as any,
        ]),
      ),
    )
    expect((out[0] as any).errorText).toBe('Tool execution failed')
  })
})

describe('tool-error', () => {
  test('Error instance → errorText is the .message', async () => {
    const err = new Error('boom')
    const out = await collect(
      processInterleavedStream(
        fromArray([{ type: 'tool-error', toolCallId: 'c1', error: err } as any]),
      ),
    )
    expect(out[0].type).toBe('tool-output-error')
    expect((out[0] as any).errorText).toBe('boom')
  })

  test('plain object error with .message → message used', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'tool-error', toolCallId: 'c1', error: { message: 'nope' } } as any,
        ]),
      ),
    )
    expect((out[0] as any).errorText).toBe('nope')
  })

  test('plain object error without .message → JSON.stringified', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'tool-error', toolCallId: 'c1', error: { code: 500 } } as any,
        ]),
      ),
    )
    expect((out[0] as any).errorText).toBe(JSON.stringify({ code: 500 }))
  })

  test('string error is forwarded directly', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([{ type: 'tool-error', toolCallId: 'c1', error: 'kaboom' } as any]),
      ),
    )
    expect((out[0] as any).errorText).toBe('kaboom')
  })

  test('empty / whitespace error falls back to generic text', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([{ type: 'tool-error', toolCallId: 'c1', error: '   ' } as any]),
      ),
    )
    expect((out[0] as any).errorText).toBe('Tool execution failed')
  })

  test('null error falls back to generic text', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([{ type: 'tool-error', toolCallId: 'c1', error: null } as any]),
      ),
    )
    expect((out[0] as any).errorText).toBe('Tool execution failed')
  })
})

describe('tool-output-denied', () => {
  test('emits tool-output-denied with toolCallId only', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([{ type: 'tool-output-denied', toolCallId: 'c1' } as any]),
      ),
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ type: 'tool-output-denied', toolCallId: 'c1' })
  })
})

// ─── reasoning ────────────────────────────────────────────────────────────

describe('reasoning events', () => {
  test('reasoning-start passes through id + providerMetadata', async () => {
    const meta = { source: 'anthropic' }
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'reasoning-start', id: 'r1', providerMetadata: meta } as any,
        ]),
      ),
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      type: 'reasoning-start',
      id: 'r1',
      providerMetadata: meta,
    } as any)
  })

  test('reasoning-delta renames text → delta', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'reasoning-delta', id: 'r1', text: 'pondering...' } as any,
        ]),
      ),
    )
    const c = out[0] as any
    expect(c.type).toBe('reasoning-delta')
    expect(c.id).toBe('r1')
    expect(c.delta).toBe('pondering...')
  })

  test('reasoning-end passes through', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([{ type: 'reasoning-end', id: 'r1' } as any]),
      ),
    )
    expect(out[0].type).toBe('reasoning-end')
    expect((out[0] as any).id).toBe('r1')
  })
})

// ─── lifecycle ─────────────────────────────────────────────────────────────

describe('lifecycle events', () => {
  test('start / start-step / finish-step pass through', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'start' } as any,
          { type: 'start-step' } as any,
          { type: 'finish-step', providerMetadata: {} } as any,
        ]),
      ),
    )
    expect(out.map((c) => c.type)).toEqual(['start', 'start-step', 'finish-step'])
  })

  test('finish finalizes open text and emits finish with finishReason', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'text-delta', text: 'hi' } as any,
          { type: 'finish', finishReason: 'stop' } as any,
        ]),
      ),
    )
    expect(out.map((c) => c.type)).toEqual([
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ])
    expect((out[3] as any).finishReason).toBe('stop')
    expect((out[3] as any).messageMetadata).toBeUndefined()
  })

  test('finish invokes getMessageMetadata with the last providerMetadata captured from finish-step', async () => {
    const captured: any[] = []
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'finish-step', providerMetadata: { token: 'abc' } } as any,
          { type: 'finish', finishReason: 'stop' } as any,
        ]),
        {
          getMessageMetadata: (pm) => {
            captured.push(pm)
            return { sessionId: 's-1' }
          },
        },
      ),
    )
    expect(captured).toEqual([{ token: 'abc' }])
    const finish = out.find((c) => c.type === 'finish') as any
    expect(finish.messageMetadata).toEqual({ sessionId: 's-1' })
  })

  test('finish without any prior finish-step → getMessageMetadata receives undefined', async () => {
    let pmSeen: unknown = 'untouched'
    await collect(
      processInterleavedStream(
        fromArray([{ type: 'finish', finishReason: 'stop' } as any]),
        {
          getMessageMetadata: (pm) => {
            pmSeen = pm
            return undefined
          },
        },
      ),
    )
    expect(pmSeen).toBeUndefined()
  })

  test('abort finalizes open text and forwards the reason', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'text-delta', text: 'hi' } as any,
          { type: 'abort', reason: 'user-canceled' } as any,
        ]),
      ),
    )
    expect(out.map((c) => c.type)).toEqual([
      'text-start',
      'text-delta',
      'text-end',
      'abort',
    ])
    expect((out[3] as any).reason).toBe('user-canceled')
  })
})

// ─── error event ──────────────────────────────────────────────────────────

describe('error event', () => {
  test('Error instance → errorText is the message', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([{ type: 'error', error: new Error('rate limit') } as any]),
      ),
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ type: 'error', errorText: 'rate limit' } as any)
  })

  test('non-Error → stringified', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([{ type: 'error', error: { code: 429 } } as any]),
      ),
    )
    expect((out[0] as any).errorText).toBe('[object Object]')
  })
})

// ─── source events ─────────────────────────────────────────────────────────

describe('source events', () => {
  test('source with url → source-url with provided id', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          {
            type: 'source',
            id: 's-1',
            url: 'https://example.com',
            title: 'Example',
          } as any,
        ]),
      ),
    )
    expect(out).toHaveLength(1)
    const c = out[0] as any
    expect(c.type).toBe('source-url')
    expect(c.sourceId).toBe('s-1')
    expect(c.url).toBe('https://example.com')
    expect(c.title).toBe('Example')
  })

  test('source with url and no id → sourceId is auto-generated', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([{ type: 'source', url: 'https://example.com' } as any]),
      ),
    )
    expect((out[0] as any).sourceId).toBeTruthy()
    expect(typeof (out[0] as any).sourceId).toBe('string')
  })

  test('source WITHOUT url → ignored', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([{ type: 'source', id: 's-1', title: 'no url' } as any]),
      ),
    )
    expect(out).toHaveLength(0)
  })
})

// ─── file event ───────────────────────────────────────────────────────────

describe('file event', () => {
  test('builds a data URL from mediaType + base64', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          {
            type: 'file',
            file: { mediaType: 'image/png', base64: 'AAAA' },
          } as any,
        ]),
      ),
    )
    expect(out).toHaveLength(1)
    const c = out[0] as any
    expect(c.type).toBe('file')
    expect(c.url).toBe('data:image/png;base64,AAAA')
    expect(c.mediaType).toBe('image/png')
  })
})

// ─── raw + unknown ─────────────────────────────────────────────────────────

describe('raw + unknown events', () => {
  test('raw events are ignored silently', async () => {
    const warn = console.warn
    const calls: any[] = []
    console.warn = (...args: any[]) => calls.push(args)
    try {
      const out = await collect(
        processInterleavedStream(fromArray([{ type: 'raw', any: 'thing' } as any])),
      )
      expect(out).toHaveLength(0)
      expect(calls).toHaveLength(0)
    } finally {
      console.warn = warn
    }
  })

  test('unknown event types are logged and ignored', async () => {
    const warn = console.warn
    const calls: any[] = []
    console.warn = (...args: any[]) => calls.push(args)
    try {
      const out = await collect(
        processInterleavedStream(
          fromArray([{ type: 'totally-made-up' } as any]),
        ),
      )
      expect(out).toHaveLength(0)
      expect(calls).toHaveLength(1)
      expect(calls[0].join(' ')).toContain('totally-made-up')
    } finally {
      console.warn = warn
    }
  })
})

// ─── finalizeCurrentText helper ───────────────────────────────────────────

describe('finalizeCurrentText (exported helper)', () => {
  test('yields a text-end when there is a current text id and clears it', () => {
    const state = {
      currentTextId: 'text-abc',
      activeToolCalls: new Map(),
      lastProviderMetadata: undefined,
    } as any
    const out = [...finalizeCurrentText(state)]
    expect(out).toEqual([{ type: 'text-end', id: 'text-abc' }])
    expect(state.currentTextId).toBeNull()
  })

  test('yields nothing when currentTextId is null', () => {
    const state = {
      currentTextId: null,
      activeToolCalls: new Map(),
      lastProviderMetadata: undefined,
    } as any
    const out = [...finalizeCurrentText(state)]
    expect(out).toEqual([])
    expect(state.currentTextId).toBeNull()
  })
})

// ─── end-to-end interleaved scenario ──────────────────────────────────────

describe('end-to-end interleaved scenario', () => {
  test('text → tool → text emits text-end before tool, fresh text-start after', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'start' } as any,
          { type: 'text-delta', text: 'Let me check. ' } as any,
          { type: 'text-delta', text: 'One sec.' } as any,
          { type: 'tool-input-start', id: 'c1', toolName: 'Bash' } as any,
          { type: 'tool-input-delta', id: 'c1', delta: '{"cmd":"ls"}' } as any,
          { type: 'tool-input-end', id: 'c1' } as any,
          { type: 'tool-call', toolCallId: 'c1', toolName: 'Bash', input: { cmd: 'ls' } } as any,
          { type: 'tool-result', toolCallId: 'c1', output: 'file1\nfile2' } as any,
          { type: 'text-delta', text: 'Done.' } as any,
          { type: 'finish', finishReason: 'stop' } as any,
        ]),
      ),
    )
    expect(out.map((c) => c.type)).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'tool-input-start',
      'tool-input-delta',
      'tool-input-available',
      'tool-output-available',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ])
    const firstTextId = (out[1] as any).id
    const secondTextId = (out[9] as any).id
    expect(firstTextId).not.toBe(secondTextId)
    expect((out[4] as any).id).toBe(firstTextId)
    expect((out[11] as any).id).toBe(secondTextId)
  })
})
