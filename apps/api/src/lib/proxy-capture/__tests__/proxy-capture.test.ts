import { describe, expect, test } from 'bun:test'
import { normalizeCapture, scrubHeaders } from '../normalize'
import { wrapCaptureStream } from '../reassemble'

describe('proxy capture normalization', () => {
  test('scrubs secrets from captured headers', () => {
    expect(scrubHeaders({
      authorization: 'Bearer secret',
      'x-api-key': 'secret',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    })).toEqual({
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    })
  })

  test('deduplicates system and tool prefixes and extracts turn metadata', () => {
    const blobs: Array<{ key: string; value: unknown }> = []
    const capture = normalizeCapture(
      {
        authKind: 'runtime',
        client: 'desktop',
        workspaceId: 'workspace-1',
        chatSessionId: 'session-1',
        endpoint: 'chat.completions',
        requestedModel: 'auto',
        resolvedModel: 'claude-sonnet',
        provider: 'anthropic',
      },
      {
        model: 'claude-sonnet',
        system: [{ type: 'text', text: 'stable system prompt' }],
        tools: [{ type: 'function', name: 'search', parameters: {} }],
        messages: [{ role: 'user', content: 'Find the release notes' }],
      },
      { content: 'Here are the release notes.' },
      (key, value) => blobs.push({ key, value }),
    )

    expect((capture.request as any).system.$ref).toContain('v1/blobs/')
    expect((capture.request as any).tools.$ref).toContain('v1/blobs/')
    expect(blobs).toHaveLength(2)
    expect(capture.source).toBe('desktop_proxy')
    expect(capture.userText).toBe('Find the release notes')
    expect(capture.assistantText).toBe('Here are the release notes.')
    expect(capture.toolNames).toEqual(['search'])
    expect(capture.turnKey).toHaveLength(64)
  })

  test('deduplicates string system prompts, Responses instructions and leading system messages', () => {
    const blobs: Array<{ key: string; value: unknown }> = []
    const write = (key: string, value: unknown) => blobs.push({ key, value })
    const meta = { authKind: 'runtime', workspaceId: 'workspace-1', endpoint: 'chat.completions' }

    const anthropic = normalizeCapture(meta, { system: 'string prompt', messages: [{ role: 'user', content: 'hi' }] }, null, write)
    const responses = normalizeCapture(meta, { instructions: 'be brief', input: 'hi' }, null, write)
    const chat = normalizeCapture(meta, {
      messages: [
        { role: 'system', content: 'chat system prompt' },
        { role: 'developer', content: 'developer prompt' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'mid-conversation note' },
      ],
    }, null, write)

    expect((anthropic.request as any).system.$ref).toContain('v1/blobs/')
    expect((responses.request as any).instructions.$ref).toContain('v1/blobs/')
    const messages = (chat.request as any).messages
    expect(messages[0].content.$ref).toContain('v1/blobs/')
    expect(messages[1].content.$ref).toContain('v1/blobs/')
    expect(messages[2].content).toBe('hi')
    expect(messages[3].content).toBe('mid-conversation note')
    expect(blobs.map((blob) => blob.value)).toEqual(['string prompt', 'be brief', 'chat system prompt', 'developer prompt'])
    expect(chat.userText).toBe('hi')
  })

  test('extracts user text from a string Responses input and summarizes tool-only responses', () => {
    const meta = { authKind: 'runtime', workspaceId: 'workspace-1', endpoint: 'responses' }
    const responses = normalizeCapture(meta, { input: 'what changed?' }, {
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Checking.' }] },
        { type: 'function_call', name: 'git_log', arguments: '{}' },
      ],
    }, () => {})
    expect(responses.userText).toBe('what changed?')
    expect(responses.assistantText).toBe('Checking.\n[tool call: git_log]')

    const streamedToolOnly = normalizeCapture(meta, { messages: [{ role: 'user', content: 'weather?' }] }, {
      tool_calls: [{ id: 'call-1', name: 'lookup_weather', arguments: '{"city":"Paris"}' }],
    }, () => {})
    expect(streamedToolOnly.assistantText).toBe('[tool call: lookup_weather]')

    const anthropicToolOnly = normalizeCapture(meta, { messages: [{ role: 'user', content: 'weather?' }] }, {
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup_weather', input: { city: 'Paris' } }],
    }, () => {})
    expect(anthropicToolOnly.assistantText).toBe('[tool call: lookup_weather]')
  })

  test('keys turns by serving region so replicated regions never share a turn key', () => {
    const meta = { authKind: 'runtime', workspaceId: 'workspace-1', chatSessionId: 'session-1', endpoint: 'chat.completions' }
    const body = { messages: [{ role: 'user', content: 'same turn' }] }
    const previous = process.env.REGION_ID
    try {
      process.env.REGION_ID = 'us-ashburn-1'
      const us = normalizeCapture(meta, body, null, () => {}).turnKey
      process.env.REGION_ID = 'eu-frankfurt-1'
      const eu = normalizeCapture(meta, body, null, () => {}).turnKey
      expect(us).not.toBe(eu)
      expect(normalizeCapture(meta, body, null, () => {}).turnKey).toBe(eu)
    } finally {
      if (previous === undefined) delete process.env.REGION_ID
      else process.env.REGION_ID = previous
    }
  })

  test('extracts media into a stable reference', () => {
    const capture = normalizeCapture(
      {
        authKind: 'runtime',
        workspaceId: 'workspace-1',
        endpoint: 'images.generations',
      },
      { prompt: 'describe', image: 'data:image/png;base64,aGVsbG8=' },
      { content: 'done' },
      () => {},
    )

    expect((capture.request as any).image.$media).toHaveLength(64)
    expect(capture.media[0]?.mime).toBe('image/png')
    expect(capture.media[0]?.bytes.toString()).toBe('hello')
  })
})

describe('proxy capture stream reassembly', () => {
  test('passes through split OpenAI SSE and captures text, tools, and usage', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hel',
      'lo"}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"search","arguments":"{\\"q\\":\\""}}]}}]}\n\n',
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'docs"}' } }], }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 4 } })}\n\ndata: [DONE]\n\n`,
    ]
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })
    let captured: any
    const response = wrapCaptureStream(
      new Response(source, { status: 200 }),
      'openai-chat',
      (result) => { captured = result },
    )

    expect(await response.text()).toContain('data: {"choices"')
    expect(captured.body.content).toBe('hello')
    expect(captured.body.tool_calls[0].name).toBe('search')
    expect(captured.body.tool_calls[0].arguments).toBe('{"q":"docs"}')
    expect(captured.usage.inputTokens).toBe(10)
    expect(captured.usage.outputTokens).toBe(4)
  })

  test('captures Anthropic thinking blocks and input JSON deltas', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 7 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reason ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'carefully.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-2', name: 'search', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"docs"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    ]
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')))
        controller.close()
      },
    })
    let captured: any
    await wrapCaptureStream(
      new Response(source),
      'anthropic',
      (result) => { captured = result },
    ).text()

    expect(captured.body.reasoning_content).toBe('Reason carefully.')
    expect(captured.body.reasoning_blocks[0]).toMatchObject({
      type: 'thinking',
      signature: 'sig-1',
    })
    expect(captured.body.tool_calls[0]).toMatchObject({
      id: 'call-2',
      name: 'search',
      arguments: '{"q":"docs"}',
    })
    expect(captured.usage).toMatchObject({ inputTokens: 7, outputTokens: 5 })
  })

  test('keeps a non-empty Anthropic tool_use input when no deltas follow', async () => {
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-3', name: 'noop', input: { a: 1 } } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
    ]
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')))
        controller.close()
      },
    })
    let captured: any
    await wrapCaptureStream(new Response(source), 'anthropic', (result) => { captured = result }).text()

    expect(captured.body.tool_calls).toEqual([{ id: 'call-3', name: 'noop', arguments: '{"a":1}' }])
  })

  test('does not duplicate Responses API function calls across added, delta, done and completed events', async () => {
    const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'search' }
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"q":' },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '"docs"}' },
      { type: 'response.output_item.done', output_index: 0, item: { ...item, arguments: '{"q":"docs"}' } },
      {
        type: 'response.completed',
        response: { status: 'completed', output: [{ ...item, arguments: '{"q":"docs"}' }], usage: { input_tokens: 3, output_tokens: 2 } },
      },
    ]
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')))
        controller.close()
      },
    })
    let captured: any
    await wrapCaptureStream(new Response(source), 'openai-responses', (result) => { captured = result }).text()

    expect(captured.body.tool_calls).toEqual([{ id: 'call_1', name: 'search', arguments: '{"q":"docs"}' }])
  })

  test('finalizes an error stream even without a done marker', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify({ error: { type: 'rate_limit_error' } })}\n\n`,
        ))
        controller.close()
      },
    })
    let captured: any
    await wrapCaptureStream(new Response(source, { status: 429 }), 'openai-chat', (result) => {
      captured = result
    }).text()

    expect(captured.status).toBe(429)
    expect(captured.errorType).toBe('rate_limit_error')
  })
})
