// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * createShogoLlmProvider video input: a `video/*` file part reaches the
 * gateway as an OpenAI-style `video_url` block instead of throwing
 * `UnsupportedFunctionalityError` inside @ai-sdk/openai-compatible.
 *
 *   bun test packages/sdk/src/llm/__tests__/llm-video.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { generateText, streamText } from 'ai'

import { createShogoLlmProvider } from '../index'

const VIDEO_BYTES = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
const VIDEO_B64 = Buffer.from(VIDEO_BYTES).toString('base64')
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function capture() {
  const bodies: any[] = []
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    if (body.stream) {
      const sse = [
        `data: ${JSON.stringify({ id: '1', created: 0, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ id: '1', created: 0, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
        'data: [DONE]',
        '',
      ].join('\n\n')
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response(
      JSON.stringify({
        id: '1',
        created: 0,
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  const provider = createShogoLlmProvider({ apiKey: 'shogo_sk_test', baseUrl: 'https://studio.example', fetch })
  return { provider, bodies }
}

describe('createShogoLlmProvider — video input', () => {
  test('a video file part (bytes) goes out as a video_url block via generateText', async () => {
    const { provider, bodies } = capture()
    const { text } = await generateText({
      model: provider('glm-5-3-flash'),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'file', mediaType: 'video/mp4', data: VIDEO_BYTES },
            { type: 'text', text: 'What happens?' },
          ],
        },
      ],
    })
    expect(text).toBe('ok')
    expect(bodies[0].messages[0].content).toEqual([
      { type: 'video_url', video_url: { url: `data:video/mp4;base64,${VIDEO_B64}` } },
      { type: 'text', text: 'What happens?' },
    ])
  })

  test('base64 strings, data URLs and streamText all work, through every provider entry point', async () => {
    const { provider, bodies } = capture()
    await generateText({
      model: provider.chatModel('glm-5-3-flash'),
      messages: [{ role: 'user', content: [{ type: 'file', mediaType: 'video/webm', data: VIDEO_B64 }] }],
    })
    await generateText({
      model: provider.languageModel('glm-5-3-flash'),
      messages: [
        { role: 'user', content: [{ type: 'file', mediaType: 'video/mp4', data: `data:video/mp4;base64,${VIDEO_B64}` }] },
      ],
    })
    const stream = streamText({
      model: provider('glm-5-3-flash'),
      messages: [{ role: 'user', content: [{ type: 'file', mediaType: 'video/quicktime', data: VIDEO_BYTES }] }],
    })
    expect(await stream.text).toBe('ok')

    const blocks = bodies.map((b) => b.messages[0].content[0])
    expect(blocks).toEqual([
      { type: 'video_url', video_url: { url: `data:video/webm;base64,${VIDEO_B64}` } },
      { type: 'video_url', video_url: { url: `data:video/mp4;base64,${VIDEO_B64}` } },
      { type: 'video_url', video_url: { url: `data:video/quicktime;base64,${VIDEO_B64}` } },
    ])
    expect(bodies[2].stream).toBe(true)
  })

  test('a video URL the caller passes straight to the model is sent as-is', async () => {
    const { provider, bodies } = capture()
    await provider.chatModel('glm-5-3-flash').doGenerate({
      prompt: [
        {
          role: 'user',
          content: [{ type: 'file', mediaType: 'video/mp4', data: new URL('https://cdn.example/clip.mp4') }],
        },
      ],
    } as any)
    expect(bodies[0].messages[0].content).toEqual([
      { type: 'video_url', video_url: { url: 'https://cdn.example/clip.mp4' } },
    ])
  })

  test('images and text-only prompts are unchanged, and no marker leaks onto the wire', async () => {
    const { provider, bodies } = capture()
    await generateText({
      model: provider('claude-sonnet-4-5'),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', image: PNG_B64, mediaType: 'image/png' },
            { type: 'file', mediaType: 'video/mp4', data: VIDEO_BYTES },
            { type: 'text', text: 'compare' },
          ],
        },
      ],
    })
    await generateText({ model: provider('claude-sonnet-4-5'), prompt: 'hi' })

    expect(bodies[0].messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
      { type: 'video_url', video_url: { url: `data:video/mp4;base64,${VIDEO_B64}` } },
      { type: 'text', text: 'compare' },
    ])
    expect(JSON.stringify(bodies)).not.toContain('shogoVideo')
    expect(bodies[1].messages).toEqual([{ role: 'user', content: 'hi' }])
  })
})
