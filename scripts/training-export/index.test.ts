import { describe, expect, test } from 'bun:test'
import { scrubText, toTrainingExample } from './index'

describe('training export normalization', () => {
  test('resolves deduplicated tools and preserves tool calls/results', () => {
    const example = toTrainingExample(
      {
        id: 'capture-1',
        ts: '2026-09-26T05:00:00.000Z',
        workspaceId: 'workspace-1',
        turnKey: 'turn-1',
        source: 'desktop_proxy',
        resolvedModel: 'claude-sonnet',
        request: {
          system: { $ref: 'v1/blobs/system.json.gz', kind: 'system' },
          tools: { $ref: 'v1/blobs/tools.json.gz', kind: 'tools' },
          messages: [
            { role: 'user', content: 'Search the docs' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'search', input: { q: 'docs' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Found it' }] },
          ],
        },
        response: {
          content: 'The docs are here.',
          tool_calls: [],
        },
      },
      { feedback: 'up', revertedAt: null, hadError: false, truncated: false },
      new Map([
        ['v1/blobs/system.json.gz', [{ type: 'text', text: 'You are helpful.' }]],
        ['v1/blobs/tools.json.gz', [{ type: 'function', name: 'search' }]],
      ]),
    )

    expect(example).not.toBeNull()
    expect(example!.tools).toEqual([{ type: 'function', name: 'search' }])
    expect(example!.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
    expect(example!.signals.feedback).toBe('up')
  })

  test('rejects secrets and scrubs PII in text', () => {
    expect(toTrainingExample({
      id: 'capture-2',
      ts: '2026-09-26T05:00:00.000Z',
      workspaceId: 'workspace-1',
      turnKey: 'turn-2',
      request: { messages: [{ role: 'user', content: 'token: sk-test-123456789012345678901234' }] },
      response: { content: 'ok' },
    })).toBeNull()

    expect(scrubText('Contact me at person@example.com or 415-555-1212').value)
      .toBe('Contact me at [REDACTED_PII] or [REDACTED_PII]')
  })

  test('exports media references as dataset assets', () => {
    const example = toTrainingExample({
      id: 'capture-3',
      ts: '2026-09-26T05:00:00.000Z',
      workspaceId: 'workspace-1',
      turnKey: 'turn-3',
      request: {
        messages: [{
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: { $media: 'image-hash', mime: 'image/png' } } }],
        }],
      },
      response: { content: 'I see an image.' },
    })

    expect(example?.media).toEqual([{
      hash: 'image-hash',
      mime: 'image/png',
      path: 'media/image-hash',
    }])
  })

  test('normalizes Responses reasoning items and function calls', () => {
    const example = toTrainingExample({
      id: 'capture-4',
      ts: '2026-09-26T05:00:00.000Z',
      workspaceId: 'workspace-1',
      turnKey: 'turn-4',
      request: { input: [{ role: 'user', content: 'Call the search tool' }] },
      response: {
        output: [
          { type: 'reasoning', id: 'reason-1', summary: [{ type: 'summary_text', text: 'I should search.' }] },
          { type: 'function_call', call_id: 'call-3', name: 'search', arguments: '{"q":"docs"}' },
        ],
      },
    })

    expect(example?.messages.at(-1)).toMatchObject({
      role: 'assistant',
      reasoning_content: 'I should search.',
      tool_calls: [{
        id: 'call-3',
        function: { name: 'search', arguments: '{"q":"docs"}' },
      }],
    })
  })

  test('normalizes a Claude assistant content block response', () => {
    const example = toTrainingExample({
      id: 'capture-5',
      ts: '2026-09-26T05:00:00.000Z',
      workspaceId: 'workspace-1',
      turnKey: 'turn-5',
      request: { messages: [{ role: 'user', content: 'Explain the result' }] },
      response: {
        content: [
          { type: 'thinking', thinking: 'I should be concise.' },
          { type: 'text', text: 'The result is ready.' },
          { type: 'tool_use', id: 'call-5', name: 'search', input: { q: 'result' } },
        ],
      },
    })

    expect(example?.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'The result is ready.',
      reasoning_content: 'I should be concise.',
      tool_calls: [{
        id: 'call-5',
        function: { name: 'search', arguments: '{"q":"result"}' },
      }],
    })
  })
})
