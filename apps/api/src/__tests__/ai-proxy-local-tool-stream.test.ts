// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The local-LLM leg of the Anthropic proxy converts an OpenAI SSE stream into
 * Anthropic events. It used to drop `tool_calls`, so a local model could never
 * call a tool. These tests pin the Anthropic events it must now produce.
 */
process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-secret-ai-proxy-do-not-use-in-prod'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret'

import { describe, expect, test } from 'bun:test'
import { convertOpenAIStreamToAnthropicStream } from '../routes/ai-proxy'

function openAIStream(chunks: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const lines = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n']
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  })
}

async function events(stream: ReadableStream<Uint8Array>): Promise<Array<Record<string, any>>> {
  const text = await new Response(stream).text()
  return text
    .split('\n\n')
    .map((frame) => frame.split('\n').find((l) => l.startsWith('data: ')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(6)))
}

const delta = (d: Record<string, unknown>) => ({ choices: [{ index: 0, delta: d, finish_reason: null }] })

describe('convertOpenAIStreamToAnthropicStream', () => {
  test('text only ends the turn', async () => {
    const out = await events(convertOpenAIStreamToAnthropicStream(openAIStream([delta({ content: 'hi ' }), delta({ content: 'there' })]), 'm'))
    const types = out.map((e) => e.type)
    expect(types).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
    expect(out.find((e) => e.type === 'message_delta')!.delta.stop_reason).toBe('end_turn')
  })

  test('a streamed tool call becomes a tool_use block and stops with tool_use', async () => {
    const out = await events(
      convertOpenAIStreamToAnthropicStream(
        openAIStream([
          delta({ content: 'checking ' }),
          delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }] }),
          delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
          delta({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }),
        ]),
        'm',
      ),
    )

    const start = out.find((e) => e.type === 'content_block_start' && e.content_block.type === 'tool_use')!
    expect(start.index).toBe(1)
    expect(start.content_block).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'read_file' })

    const json = out
      .filter((e) => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta')
      .map((e) => e.delta.partial_json)
      .join('')
    expect(JSON.parse(json)).toEqual({ path: 'a.txt' })

    // The text block closes before the tool block opens, and the tool block closes before the message ends.
    const order = out.map((e) => `${e.type}:${e.index ?? ''}`)
    expect(order.indexOf('content_block_stop:0')).toBeLessThan(order.indexOf('content_block_start:1'))
    expect(order.indexOf('content_block_stop:1')).toBeLessThan(order.indexOf('message_delta:'))
    expect(out.find((e) => e.type === 'message_delta')!.delta.stop_reason).toBe('tool_use')
  })

  test('two tool calls get separate blocks', async () => {
    const out = await events(
      convertOpenAIStreamToAnthropicStream(
        openAIStream([
          delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'one', arguments: '{}' } }] }),
          delta({ tool_calls: [{ index: 1, id: 'b', function: { name: 'two', arguments: '{}' } }] }),
        ]),
        'm',
      ),
    )
    const starts = out.filter((e) => e.type === 'content_block_start' && e.content_block.type === 'tool_use')
    expect(starts.map((e) => [e.index, e.content_block.name])).toEqual([[1, 'one'], [2, 'two']])
  })
})
