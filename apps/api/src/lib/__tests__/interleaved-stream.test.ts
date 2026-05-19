// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { processInterleavedStream, finalizeCurrentText } from '../interleaved-stream'

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const i of items) yield i
}

async function collect(stream: AsyncIterable<any>): Promise<any[]> {
  const out: any[] = []
  for await (const c of stream) out.push(c)
  return out
}

describe('finalizeCurrentText', () => {
  it('yields a text-end when currentTextId is set', () => {
    const state: any = { currentTextId: 'text-123', activeToolCalls: new Map() }
    const out = Array.from(finalizeCurrentText(state))
    expect(out).toEqual([{ type: 'text-end', id: 'text-123' }])
    expect(state.currentTextId).toBeNull()
  })
  it('yields nothing when currentTextId is null', () => {
    const state: any = { currentTextId: null, activeToolCalls: new Map() }
    expect(Array.from(finalizeCurrentText(state))).toEqual([])
  })
})

describe('processInterleavedStream — text', () => {
  it('first text-delta emits text-start + text-delta', async () => {
    const out = await collect(
      processInterleavedStream(fromArray([{ type: 'text-delta', text: 'hello' }] as any)),
    )
    expect(out).toHaveLength(2)
    expect(out[0].type).toBe('text-start')
    expect(out[1].type).toBe('text-delta')
    expect(out[1].delta).toBe('hello')
    expect(out[1].id).toBe(out[0].id)
  })

  it('subsequent text-deltas reuse the same id and skip text-start', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'text-delta', text: 'hello ' },
          { type: 'text-delta', text: 'world' },
        ] as any),
      ),
    )
    expect(out.map((c) => c.type)).toEqual(['text-start', 'text-delta', 'text-delta'])
    expect(out[1].id).toBe(out[2].id)
  })

  it('explicit text-start without a prior delta still produces one', async () => {
    const out = await collect(processInterleavedStream(fromArray([{ type: 'text-start' }] as any)))
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('text-start')
  })

  it('explicit text-start AFTER a delta is a no-op (already started)', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'text-delta', text: 'a' },
          { type: 'text-start' },
        ] as any),
      ),
    )
    expect(out.filter((c) => c.type === 'text-start')).toHaveLength(1)
  })

  it('text-end finalizes current text part', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([{ type: 'text-delta', text: 'a' }, { type: 'text-end' }] as any),
      ),
    )
    expect(out[out.length - 1].type).toBe('text-end')
  })

  it('text-end with no open text yields nothing', async () => {
    const out = await collect(processInterleavedStream(fromArray([{ type: 'text-end' }] as any)))
    expect(out).toEqual([])
  })
})

describe('processInterleavedStream — tool events', () => {
  it('tool-input-start finalizes any open text first', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'text-delta', text: 'a' },
          { type: 'tool-input-start', id: 't1', toolName: 'fetch', providerExecuted: false, dynamic: false, title: 'Fetch' },
        ] as any),
      ),
    )
    expect(out.map((c) => c.type)).toEqual([
      'text-start',
      'text-delta',
      'text-end',
      'tool-input-start',
    ])
    expect(out[3]).toMatchObject({ toolCallId: 't1', toolName: 'fetch', title: 'Fetch' })
  })

  it('tool-input-delta maps id->toolCallId and delta->inputTextDelta', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([{ type: 'tool-input-delta', id: 't1', delta: '{"a":' }] as any),
      ),
    )
    expect(out[0]).toEqual({ type: 'tool-input-delta', toolCallId: 't1', inputTextDelta: '{"a":' })
  })

  it('tool-input-end yields nothing', async () => {
    const out = await collect(
      processInterleavedStream(fromArray([{ type: 'tool-input-end', id: 't1' }] as any)),
    )
    expect(out).toEqual([])
  })

  it('tool-call emits tool-input-available', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([{ type: 'tool-call', toolCallId: 't1', toolName: 'fetch', input: { x: 1 } }] as any),
      ),
    )
    expect(out[0]).toEqual({
      type: 'tool-input-available',
      toolCallId: 't1',
      toolName: 'fetch',
      input: { x: 1 },
    })
  })

  it('tool-result success emits tool-output-available', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([{ type: 'tool-result', toolCallId: 't1', output: { ok: 1 } }] as any),
      ),
    )
    expect(out[0]).toEqual({ type: 'tool-output-available', toolCallId: 't1', output: { ok: 1 } })
  })

  it('tool-result with isError:true + string output emits tool-output-error with the string', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'tool-result', toolCallId: 't1', output: 'boom', isError: true },
        ] as any),
      ),
    )
    expect(out[0]).toEqual({ type: 'tool-output-error', toolCallId: 't1', errorText: 'boom' })
  })

  it('tool-result with isError:true + {stderr} emits stderr text', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'tool-result', toolCallId: 't1', output: { stderr: 'cmd failed' }, isError: true },
        ] as any),
      ),
    )
    expect(out[0].errorText).toBe('cmd failed')
  })

  it('tool-result with isError:true + other object emits JSON.stringify(output)', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'tool-result', toolCallId: 't1', output: { code: 1 }, isError: true },
        ] as any),
      ),
    )
    expect(out[0].errorText).toBe('{"code":1}')
  })

  it('tool-result with isError:true and null output falls back to default text', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([{ type: 'tool-result', toolCallId: 't1', output: null, isError: true }] as any),
      ),
    )
    expect(out[0].errorText).toBe('Tool execution failed')
  })

  it('tool-error with object .message uses that message', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'tool-error', toolCallId: 't1', error: { message: 'rate limited' } },
        ] as any),
      ),
    )
    expect(out[0]).toEqual({ type: 'tool-output-error', toolCallId: 't1', errorText: 'rate limited' })
  })

  it('tool-error with object but no message falls back to JSON.stringify', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([{ type: 'tool-error', toolCallId: 't1', error: { code: 42 } }] as any),
      ),
    )
    expect(out[0].errorText).toBe('{"code":42}')
  })

  it('tool-error with empty string falls back to default text', async () => {
    const out = await collect(
      processInterleavedStream(fromArray([{ type: 'tool-error', toolCallId: 't1', error: '   ' }] as any)),
    )
    expect(out[0].errorText).toBe('Tool execution failed')
  })

  it('tool-error with null error falls back to default text', async () => {
    const out = await collect(
      processInterleavedStream(fromArray([{ type: 'tool-error', toolCallId: 't1', error: null }] as any)),
    )
    expect(out[0].errorText).toBe('Tool execution failed')
  })

  it('tool-output-denied passes through', async () => {
    const out = await collect(
      processInterleavedStream(fromArray([{ type: 'tool-output-denied', toolCallId: 't1' }] as any)),
    )
    expect(out[0]).toEqual({ type: 'tool-output-denied', toolCallId: 't1' })
  })
})

describe('processInterleavedStream — reasoning + steps', () => {
  it('reasoning-start/delta/end pass through and translate "text" to "delta"', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'reasoning-start', id: 'r1', providerMetadata: { x: 1 } },
          { type: 'reasoning-delta', id: 'r1', text: 'thinking', providerMetadata: { x: 1 } },
          { type: 'reasoning-end', id: 'r1', providerMetadata: { x: 1 } },
        ] as any),
      ),
    )
    expect(out[0]).toMatchObject({ type: 'reasoning-start', id: 'r1' })
    expect(out[1]).toMatchObject({ type: 'reasoning-delta', id: 'r1', delta: 'thinking' })
    expect(out[2]).toMatchObject({ type: 'reasoning-end', id: 'r1' })
  })

  it('start-step / finish-step yield matching chunks', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'start-step' },
          { type: 'finish-step', providerMetadata: { foo: 'bar' } },
        ] as any),
      ),
    )
    expect(out).toEqual([{ type: 'start-step' }, { type: 'finish-step' }])
  })
})

describe('processInterleavedStream — lifecycle', () => {
  it('start / finish lifecycle', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([{ type: 'start' }, { type: 'finish', finishReason: 'stop' }] as any),
      ),
    )
    expect(out[0]).toEqual({ type: 'start' })
    expect(out[1]).toMatchObject({ type: 'finish', finishReason: 'stop' })
  })

  it('finish finalizes any open text part first', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'text-delta', text: 'a' },
          { type: 'finish', finishReason: 'stop' },
        ] as any),
      ),
    )
    expect(out.map((c) => c.type)).toEqual(['text-start', 'text-delta', 'text-end', 'finish'])
  })

  it('finish runs getMessageMetadata with stored providerMetadata', async () => {
    let received: any
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'finish-step', providerMetadata: { trace: 'abc' } },
          { type: 'finish', finishReason: 'stop' },
        ] as any),
        {
          getMessageMetadata: (pm) => {
            received = pm
            return { capturedFrom: pm?.trace }
          },
        },
      ),
    )
    expect(received).toEqual({ trace: 'abc' })
    expect(out[out.length - 1].messageMetadata).toEqual({ capturedFrom: 'abc' })
  })

  it('abort finalizes open text and emits abort', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'text-delta', text: 'a' },
          { type: 'abort', reason: 'user-cancel' },
        ] as any),
      ),
    )
    expect(out.map((c) => c.type)).toEqual(['text-start', 'text-delta', 'text-end', 'abort'])
    expect((out[out.length - 1] as any).reason).toBe('user-cancel')
  })

  it('error with Error instance extracts .message', async () => {
    const out = await collect(
      processInterleavedStream(fromArray([{ type: 'error', error: new Error('boom') }] as any)),
    )
    expect(out[0]).toEqual({ type: 'error', errorText: 'boom' })
  })

  it('error with non-Error coerces via String()', async () => {
    const out = await collect(
      processInterleavedStream(fromArray([{ type: 'error', error: 42 }] as any)),
    )
    expect(out[0].errorText).toBe('42')
  })
})

describe('processInterleavedStream — source / file / raw / unknown', () => {
  it('source with url emits source-url', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([
          { type: 'source', id: 's1', url: 'https://x.example', title: 'X', providerMetadata: { p: 1 } },
        ] as any),
      ),
    )
    expect(out[0]).toMatchObject({
      type: 'source-url',
      sourceId: 's1',
      url: 'https://x.example',
      title: 'X',
    })
  })

  it('source without an explicit id mints one via nanoid', async () => {
    const out = await collect(
      processInterleavedStream(fromArray([{ type: 'source', url: 'https://y.example' }] as any)),
    )
    expect(out[0].sourceId).toBeTruthy()
  })

  it('source without a url is dropped', async () => {
    const out = await collect(
      processInterleavedStream(fromArray([{ type: 'source', id: 'nope' }] as any)),
    )
    expect(out).toEqual([])
  })

  it('file emits a data: URL with base64 + mediaType', async () => {
    const out = await collect(
      processInterleavedStream(
        fromArray([{ type: 'file', file: { mediaType: 'image/png', base64: 'AAAA' } }] as any),
      ),
    )
    expect(out[0]).toEqual({
      type: 'file',
      url: 'data:image/png;base64,AAAA',
      mediaType: 'image/png',
    })
  })

  it('raw events are silently ignored', async () => {
    const out = await collect(
      processInterleavedStream(fromArray([{ type: 'raw', payload: 'whatever' }] as any)),
    )
    expect(out).toEqual([])
  })

  it('unknown event types are logged and ignored', async () => {
    const origWarn = console.warn
    let captured: any[] = []
    console.warn = (...args: any[]) => {
      captured = args
    }
    try {
      const out = await collect(
        processInterleavedStream(fromArray([{ type: 'wat-is-this' }] as any)),
      )
      expect(out).toEqual([])
      expect(captured[0]).toContain('Unknown event')
    } finally {
      console.warn = origWarn
    }
  })
})
