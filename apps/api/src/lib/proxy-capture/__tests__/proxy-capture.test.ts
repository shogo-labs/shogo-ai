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
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-2', name: 'search' } },
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
