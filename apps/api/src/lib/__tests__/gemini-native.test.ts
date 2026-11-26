// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Gemini native translation (§A of SHO-591, #2268).
 *
 * The compat endpoint samples every clip at 1 frame per second of duration and
 * silently ignores the rate setting, so video turns are translated to the
 * native `generateContent` body (where `videoMetadata.fps` exists) and the
 * native response is translated back into exactly the chunks/objects our compat
 * rewriter produces. These tests pin both directions, plus the usage mapping
 * `recordUsage` bills from.
 *
 * Run: bun test apps/api/src/lib/__tests__/gemini-native.test.ts
 */
import { describe, it, expect } from 'bun:test'
import {
  buildGeminiNativeBody,
  convertGeminiNativeResponse,
  createGeminiNativeSseRewriter,
  geminiNativeFinishReason,
  geminiNativeUsage,
  getGeminiNativeBaseUrl,
  geminiNativeEndpoint,
  hasGeminiVideoTurn,
  splitDataUrl,
  type NativeChatMessage,
  type NativeTranslationRequest,
} from '../gemini-native'

const VIDEO_URL = 'data:video/mp4;fps=10;start=5;end=10;base64,AAAB'
const PNG_URL = 'data:image/png;base64,iVBORw0KGgo='

function body(request: Partial<NativeTranslationRequest>, overrides: Partial<{ thinkingLevel: string; maxOutputTokens: number }> = {}) {
  return buildGeminiNativeBody(
    { messages: [], ...request } as NativeTranslationRequest,
    {
      apiModel: 'gemini-4-hydrogen',
      thinkingLevel: overrides.thinkingLevel ?? 'high',
      maxOutputTokens: overrides.maxOutputTokens ?? 65_536,
    },
  ) as any
}

describe('hasGeminiVideoTurn', () => {
  it('detects a data:video block', () => {
    expect(hasGeminiVideoTurn([{ role: 'user', content: [{ type: 'image_url', image_url: { url: VIDEO_URL } }] }])).toBe(true)
  })

  it('detects the native video_url shape too', () => {
    expect(hasGeminiVideoTurn([{ role: 'user', content: [{ type: 'video_url', video_url: { url: VIDEO_URL } }] }])).toBe(true)
  })

  it('is false for text, images and tool-only turns', () => {
    expect(hasGeminiVideoTurn([{ role: 'user', content: 'describe this' }])).toBe(false)
    expect(hasGeminiVideoTurn([{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG_URL } }] }])).toBe(false)
    expect(
      hasGeminiVideoTurn([
        { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'x', arguments: '{}' } }] },
      ]),
    ).toBe(false)
  })
})

describe('splitDataUrl', () => {
  it('splits a base64 data URL into media type and payload', () => {
    expect(splitDataUrl(VIDEO_URL)).toEqual({ mimeType: 'video/mp4;fps=10;start=5;end=10', data: 'AAAB' })
  })

  it('rejects anything that is not an inline base64 URL', () => {
    expect(splitDataUrl('https://example.com/clip.mp4')).toBeNull()
    expect(splitDataUrl('data:video/mp4,notbase64')).toBeNull()
  })
})

describe('buildGeminiNativeBody — a full conversation', () => {
  // One request covering everything the plan calls out: system prompt, text,
  // image, video with frame settings, two parallel tool calls (one with a
  // stored signature, one without), consecutive tool results, tools and
  // tool_choice.
  const messages: NativeChatMessage[] = [
    { role: 'system', content: 'You are terse.' },
    { role: 'developer', content: [{ type: 'text', text: 'Prefer SI units.' }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What happens between 5 s and 10 s?' },
        { type: 'image_url', image_url: { url: PNG_URL } },
        { type: 'image_url', image_url: { url: VIDEO_URL } },
      ],
    },
    {
      role: 'assistant',
      content: 'Checking the clip.',
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'probe', arguments: '{"seconds":5}' } },
        { id: 'call_b', type: 'function', function: { name: 'count', arguments: '{"what":"frames"}' } },
      ],
      reasoning_details: [{ type: 'reasoning.encrypted', id: 'call_a', data: 'SIG-A' }],
    },
    { role: 'tool', tool_call_id: 'call_a', content: '{"ok":true}' },
    { role: 'tool', tool_call_id: 'call_b', content: '50' },
  ]

  const translated = body({
    messages,
    max_tokens: 2048,
    temperature: 0.2,
    top_p: 0.9,
    stop: 'END',
    tools: [
      {
        type: 'function',
        function: {
          name: 'probe',
          description: 'Read a timestamp',
          parameters: {
            type: 'object',
            additionalProperties: false,
            $schema: 'http://json-schema.org/draft-07/schema#',
            properties: {
              seconds: { type: 'number', description: 'Second to probe', exclusiveMinimum: 0 },
            },
            required: ['seconds'],
          },
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'probe' } },
  })

  it('folds system and developer prompts into one systemInstruction', () => {
    expect(translated.systemInstruction).toEqual({ parts: [{ text: 'You are terse.' }, { text: 'Prefer SI units.' }] })
  })

  it('maps the frame settings onto videoMetadata in seconds, and keeps the media type bare', () => {
    const videoPart = translated.contents[0].parts[2]
    expect(videoPart.inlineData).toEqual({ mimeType: 'video/mp4', data: 'AAAB' })
    expect(videoPart.videoMetadata).toEqual({ fps: 10, startOffset: '5s', endOffset: '10s' })
  })

  it('sends the image as inlineData with no videoMetadata', () => {
    const imagePart = translated.contents[0].parts[1]
    expect(imagePart.inlineData).toEqual({ mimeType: 'image/png', data: 'iVBORw0KGgo=' })
    expect(imagePart.videoMetadata).toBeUndefined()
  })

  it('becomes a model turn with text then functionCall parts carrying signatures', () => {
    const modelTurn = translated.contents[1]
    expect(modelTurn.role).toBe('model')
    expect(modelTurn.parts[0]).toEqual({ text: 'Checking the clip.' })
    expect(modelTurn.parts[1]).toEqual({
      functionCall: { name: 'probe', args: { seconds: 5 } },
      thoughtSignature: 'SIG-A',
    })
    // No stored signature for the second call: Google's documented escape hatch,
    // not a bare part, which the API rejects outright.
    expect(modelTurn.parts[2]).toEqual({
      functionCall: { name: 'count', args: { what: 'frames' } },
      thoughtSignature: 'skip_thought_signature_validator',
    })
  })

  it('merges consecutive tool results into one user turn, named from their calls', () => {
    expect(translated.contents).toHaveLength(3)
    expect(translated.contents[2]).toEqual({
      role: 'user',
      parts: [
        { functionResponse: { name: 'probe', response: { ok: true } } },
        // A tool that answered with a bare number is wrapped, not dropped.
        { functionResponse: { name: 'count', response: { result: '50' } } },
      ],
    })
  })

  it('translates tools to functionDeclarations and drops keys Gemini rejects', () => {
    expect(translated.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'probe',
            description: 'Read a timestamp',
            parameters: {
              type: 'OBJECT',
              properties: { seconds: { type: 'NUMBER', description: 'Second to probe' } },
              required: ['seconds'],
            },
          },
        ],
      },
    ])
    const parameters = translated.tools[0].functionDeclarations[0].parameters
    expect(parameters.additionalProperties).toBeUndefined()
    expect(parameters.$schema).toBeUndefined()
  })

  it('maps tool_choice onto toolConfig', () => {
    expect(translated.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['probe'] },
    })
  })

  it('carries generation settings into generationConfig', () => {
    expect(translated.generationConfig).toEqual({
      maxOutputTokens: 2048,
      temperature: 0.2,
      topP: 0.9,
      stopSequences: ['END'],
      thinkingConfig: { thinkingLevel: 'high', includeThoughts: true },
    })
  })
})

describe('buildGeminiNativeBody — smaller shapes', () => {
  it('omits videoMetadata when no rate was asked for, keeping Google at 1 fps', () => {
    const translated = body({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:video/mp4;base64,AAAB' } }] }],
    })
    expect(translated.contents[0].parts[0].videoMetadata).toBeUndefined()
  })

  it('clamps a rate above 24 down to Google\'s ceiling', () => {
    const translated = body({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:video/mp4;fps=60;base64,AAAB' } }] }],
    })
    expect(translated.contents[0].parts[0].videoMetadata).toEqual({ fps: 24 })
  })

  it('sends a Shogo `xhigh` effort as the native `high`, which is the enum\'s ceiling', () => {
    const translated = body({ messages: [{ role: 'user', content: 'hi' }] }, { thinkingLevel: 'xhigh' })
    expect(translated.generationConfig.thinkingConfig.thinkingLevel).toBe('high')
  })

  it('omits systemInstruction and tools entirely when there are none', () => {
    const translated = body({ messages: [{ role: 'user', content: 'hi' }] })
    expect(translated.systemInstruction).toBeUndefined()
    expect(translated.tools).toBeUndefined()
    expect(translated.toolConfig).toBeUndefined()
  })

  it('drops empty turns instead of sending a partless content entry', () => {
    const translated = body({
      messages: [
        { role: 'assistant', content: '' },
        { role: 'user', content: [{ type: 'text', text: '' }] },
        { role: 'user', content: 'real' },
      ],
    })
    expect(translated.contents).toEqual([{ role: 'user', parts: [{ text: 'real' }] }])
  })
})

describe('createGeminiNativeSseRewriter', () => {
  function run(lines: string[], ids?: string[]): any[] {
    let next = 0
    const rewriter = createGeminiNativeSseRewriter({
      model: 'gemini-4-hydrogen',
      nextToolCallId: ids ? () => ids[next++] : undefined,
    })
    const out: string[] = []
    for (const line of lines) {
      const produced = rewriter(line)
      for (const piece of Array.isArray(produced) ? produced : [produced]) out.push(piece)
    }
    const flushed = rewriter.flush?.() ?? []
    for (const piece of Array.isArray(flushed) ? flushed : [flushed]) out.push(piece)
    return out
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice(6)))
  }

  const event = (payload: unknown) => `data: ${JSON.stringify(payload)}`

  it('moves thought text into reasoning_content and reply text into content', () => {
    const chunks = run([
      event({ candidates: [{ content: { role: 'model', parts: [{ text: 'weighing it up', thought: true }] } }] }),
      event({ candidates: [{ content: { role: 'model', parts: [{ text: 'The ball costs 5¢.' }] } }] }),
      'data: [DONE]',
    ])
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', reasoning_content: 'weighing it up' })
    expect(chunks[1].choices[0].delta).toEqual({ content: 'The ball costs 5¢.' })
    expect(chunks[0].object).toBe('chat.completion.chunk')
    expect(chunks[0].model).toBe('gemini-4-hydrogen')
  })

  it('emits a tool call delta whose reasoning_details carry the thought signature', () => {
    const chunks = run(
      [
        event({
          candidates: [{
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'probe', args: { seconds: 5 } }, thoughtSignature: 'SIG-A' }],
            },
            finishReason: 'STOP',
          }],
        }),
        event({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 15 } }),
        'data: [DONE]',
      ],
      ['call_1'],
    )
    const delta = chunks[0].choices[0].delta
    expect(delta.tool_calls).toEqual([
      { index: 0, id: 'call_1', type: 'function', function: { name: 'probe', arguments: '{"seconds":5}' } },
    ])
    expect(delta.reasoning_details).toEqual([{ type: 'reasoning.encrypted', id: 'call_1', data: 'SIG-A' }])
    // A turn that called a tool finished with tool_calls, not stop — pi-ai and
    // the runtime both branch on that.
    const finish = chunks.find((chunk) => chunk.choices[0]?.finish_reason)
    expect(finish.choices[0].finish_reason).toBe('tool_calls')
  })

  it('reports usage on a choices-less final chunk, in OpenAI field names', () => {
    const chunks = run([
      event({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }),
      event({
        usageMetadata: {
          promptTokenCount: 120,
          candidatesTokenCount: 30,
          thoughtsTokenCount: 12,
          cachedContentTokenCount: 40,
          totalTokenCount: 162,
        },
      }),
      'data: [DONE]',
    ])
    const usageChunk = chunks.find((chunk) => chunk.usage)
    expect(usageChunk.choices).toEqual([])
    expect(usageChunk.usage).toEqual({
      prompt_tokens: 120,
      completion_tokens: 42,
      total_tokens: 162,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 12 },
    })
  })

  it('maps every finishReason, and passes an error event through untouched', () => {
    expect(geminiNativeFinishReason('STOP', false)).toBe('stop')
    expect(geminiNativeFinishReason('MAX_TOKENS', false)).toBe('length')
    expect(geminiNativeFinishReason('SAFETY', false)).toBe('content_filter')
    expect(geminiNativeFinishReason('RECITATION', false)).toBe('content_filter')
    expect(geminiNativeFinishReason('STOP', true)).toBe('tool_calls')
    expect(geminiNativeFinishReason(undefined, false)).toBeNull()

    const errorLine = event({ error: { code: 500, message: 'internal' } })
    const rewriter = createGeminiNativeSseRewriter({ model: 'gemini-4-hydrogen' })
    expect(rewriter(errorLine)).toBe(errorLine)
  })

  it('emits [DONE] once on flush when the stream did not send one', () => {
    const rewriter = createGeminiNativeSseRewriter({ model: 'gemini-4-hydrogen' })
    rewriter(event({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }))
    expect(rewriter.flush?.()).toEqual(['data: [DONE]'])
  })
})

describe('convertGeminiNativeResponse', () => {
  it('produces the chat.completion shape the compat rewriter produces', () => {
    const native = {
      candidates: [{
        content: {
          role: 'model',
          parts: [
            { text: 'thinking it over', thought: true },
            { text: 'The answer is 5.' },
            { functionCall: { name: 'probe', args: { seconds: 5 } }, thoughtSignature: 'SIG-A' },
          ],
        },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 1, totalTokenCount: 15 },
    }
    const result = convertGeminiNativeResponse(native, 'gemini-4-hydrogen') as any
    const message = result.choices[0].message
    expect(message.role).toBe('assistant')
    expect(message.content).toBe('The answer is 5.')
    expect(message.reasoning_content).toBe('thinking it over')
    expect(message.tool_calls[0].function).toEqual({ name: 'probe', arguments: '{"seconds":5}' })
    expect(message.reasoning_details[0]).toEqual({
      type: 'reasoning.encrypted',
      id: message.tool_calls[0].id,
      data: 'SIG-A',
    })
    expect(result.choices[0].finish_reason).toBe('tool_calls')
    expect(result.usage.prompt_tokens).toBe(10)
  })

  it('returns null content for a call-only turn, like the compat path', () => {
    const result = convertGeminiNativeResponse(
      { candidates: [{ content: { parts: [{ functionCall: { name: 'x', args: {} } }] }, finishReason: 'STOP' }] },
      'gemini-4-hydrogen',
    ) as any
    expect(result.choices[0].message.content).toBeNull()
  })
})

describe('geminiNativeUsage', () => {
  it('counts thoughts as output tokens and cached content as cached input', () => {
    expect(geminiNativeUsage({
      promptTokenCount: 1000,
      candidatesTokenCount: 100,
      thoughtsTokenCount: 50,
      cachedContentTokenCount: 250,
      totalTokenCount: 1150,
    })).toEqual({
      prompt_tokens: 1000,
      completion_tokens: 150,
      total_tokens: 1150,
      prompt_tokens_details: { cached_tokens: 250 },
      completion_tokens_details: { reasoning_tokens: 50 },
    })
  })

  it('is undefined with no metadata, so a caller can omit usage entirely', () => {
    expect(geminiNativeUsage(undefined)).toBeUndefined()
  })
})

describe('native endpoints', () => {
  it('derives the native base by dropping the compat /openai suffix', () => {
    const previous = process.env.GOOGLE_BASE_URL
    process.env.GOOGLE_BASE_URL = 'https://example.test/v1beta/openai/'
    try {
      expect(getGeminiNativeBaseUrl()).toBe('https://example.test/v1beta')
      expect(geminiNativeEndpoint('gemini-4-hydrogen', true)).toBe(
        'https://example.test/v1beta/models/gemini-4-hydrogen:streamGenerateContent?alt=sse',
      )
      expect(geminiNativeEndpoint('gemini-4-hydrogen', false)).toBe(
        'https://example.test/v1beta/models/gemini-4-hydrogen:generateContent',
      )
    } finally {
      if (previous === undefined) delete process.env.GOOGLE_BASE_URL
      else process.env.GOOGLE_BASE_URL = previous
    }
  })
})
