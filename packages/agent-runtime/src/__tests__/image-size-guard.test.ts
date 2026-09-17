// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from '@mariozechner/pi-ai'
import {
  MAX_IMAGE_BASE64_BYTES,
  SUPPORTED_IMAGE_MIME_TYPES,
  buildOversizedPlaceholder,
  buildUnsupportedFormatPlaceholder,
  enforceImageSizeLimit,
  scrubOversizedImages,
} from '../image-size-guard'

function smallImage(): ImageContent {
  return { type: 'image', data: 'AAAA', mimeType: 'image/png' }
}

function bigImage(): ImageContent {
  return {
    type: 'image',
    data: 'A'.repeat(MAX_IMAGE_BASE64_BYTES + 1),
    mimeType: 'image/png',
  }
}

/** A tiny, well-under-size image whose format no provider accepts. */
function unsupportedFormatImage(mimeType = 'image/x-icon'): ImageContent {
  return { type: 'image', data: 'AAAA', mimeType }
}

function text(t: string): TextContent {
  return { type: 'text', text: t }
}

describe('buildOversizedPlaceholder', () => {
  test('reports the byte count and a path-specific downscale hint when given a path', () => {
    const block = buildOversizedPlaceholder({
      label: 'read_file',
      base64Length: 6_000_000,
      mimeType: 'image/png',
      pathHint: 'screenshots/big.png',
    })
    expect(block.type).toBe('text')
    expect(block.text).toContain('6000000')
    expect(block.text).toContain('image/png')
    expect(block.text).toContain('screenshots/big.png')
    expect(block.text.toLowerCase()).toMatch(/sips|convert/)
  })

  test('falls back to a generic hint when no path is available', () => {
    const block = buildOversizedPlaceholder({
      label: 'mcp:foo',
      base64Length: 6_000_000,
    })
    expect(block.text).toContain('mcp:foo')
    expect(block.text.toLowerCase()).toMatch(/sips|convert/)
  })
})

describe('SUPPORTED_IMAGE_MIME_TYPES', () => {
  test('is exactly the formats DeepSeek and Anthropic both document support for', () => {
    expect([...SUPPORTED_IMAGE_MIME_TYPES].sort()).toEqual(
      ['image/gif', 'image/jpeg', 'image/png', 'image/webp'].sort()
    )
  })
})

describe('buildUnsupportedFormatPlaceholder', () => {
  test('names the rejected format and the accepted set, with a convert hint when a path is available', () => {
    const block = buildUnsupportedFormatPlaceholder({
      label: 'read_file',
      mimeType: 'image/x-icon',
      pathHint: 'public/favicon.ico',
    })
    expect(block.type).toBe('text')
    expect(block.text).toContain('image/x-icon')
    expect(block.text).toContain('public/favicon.ico')
    expect(block.text.toLowerCase()).toMatch(/sips|convert/)
    expect(block.text).toContain('png')
  })

  test('falls back to a generic convert hint when no path is available', () => {
    const block = buildUnsupportedFormatPlaceholder({ label: 'mcp:foo', mimeType: 'image/bmp' })
    expect(block.text).toContain('mcp:foo')
    expect(block.text).toContain('image/bmp')
  })
})

describe('enforceImageSizeLimit', () => {
  test('passes through arrays that contain only small images and text', () => {
    const content: (TextContent | ImageContent)[] = [smallImage(), text('hi')]
    const out = enforceImageSizeLimit(content, { label: 'read_file' })
    expect(out).toBe(content)
  })

  test('replaces oversized images with a placeholder text block and keeps the rest', () => {
    const content: (TextContent | ImageContent)[] = [bigImage(), text('details')]
    const out = enforceImageSizeLimit(content, {
      label: 'read_file',
      pathHint: 'a/b.png',
    })
    expect(out).not.toBe(content)
    expect(out).toHaveLength(2)
    expect(out[0].type).toBe('text')
    expect((out[0] as TextContent).text).toContain('Image omitted')
    expect((out[0] as TextContent).text).toContain('a/b.png')
    expect(out[1]).toBe(content[1])
  })

  test('handles arrays with multiple oversized images', () => {
    const a = bigImage()
    const b = bigImage()
    const out = enforceImageSizeLimit([a, b], { label: 'browser:screenshot' })
    expect(out).toHaveLength(2)
    expect(out[0].type).toBe('text')
    expect(out[1].type).toBe('text')
  })

  test('replaces images in an unsupported format (e.g. .ico read via read_file) with a placeholder', () => {
    const content: (TextContent | ImageContent)[] = [unsupportedFormatImage(), text('meta')]
    const out = enforceImageSizeLimit(content, { label: 'read_file', pathHint: 'public/favicon.ico' })
    expect(out).not.toBe(content)
    expect(out).toHaveLength(2)
    expect(out[0].type).toBe('text')
    expect((out[0] as TextContent).text).toContain('Image omitted')
    expect((out[0] as TextContent).text).toContain('image/x-icon')
    expect(out[1]).toBe(content[1])
  })

  test.each(['image/bmp', 'image/avif', 'image/heic', 'image/svg+xml'])(
    'flags %s as unsupported',
    (mimeType) => {
      const out = enforceImageSizeLimit([unsupportedFormatImage(mimeType)], { label: 'read_file' })
      expect(out[0].type).toBe('text')
    }
  )

  test.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])(
    'passes %s through untouched',
    (mimeType) => {
      const content: (TextContent | ImageContent)[] = [unsupportedFormatImage(mimeType)]
      const out = enforceImageSizeLimit(content, { label: 'read_file' })
      expect(out).toBe(content)
    }
  )

  test('is case-insensitive when matching mimeType against the supported set', () => {
    const content: (TextContent | ImageContent)[] = [{ type: 'image', data: 'AAAA', mimeType: 'IMAGE/PNG' }]
    const out = enforceImageSizeLimit(content, { label: 'read_file' })
    expect(out).toBe(content)
  })

  test('does not format-check images with no mimeType (can\'t validate what we can\'t identify)', () => {
    const content: (TextContent | ImageContent)[] = [{ type: 'image', data: 'AAAA' } as ImageContent]
    const out = enforceImageSizeLimit(content, { label: 'read_file' })
    expect(out).toBe(content)
  })

  test('checks format before size, so an unsupported-format image gets the format placeholder even if also oversized', () => {
    const badBoth: ImageContent = {
      type: 'image',
      data: 'A'.repeat(MAX_IMAGE_BASE64_BYTES + 1),
      mimeType: 'image/bmp',
    }
    const out = enforceImageSizeLimit([badBoth], { label: 'read_file' })
    expect((out[0] as TextContent).text).toContain('image/bmp')
    expect((out[0] as TextContent).text).not.toContain('exceeds')
  })
})

describe('scrubOversizedImages', () => {
  function userMsg(content: UserMessage['content']): UserMessage {
    return { role: 'user', content, timestamp: 0 }
  }

  function toolResultMsg(content: ToolResultMessage['content']): ToolResultMessage {
    return {
      role: 'toolResult',
      toolCallId: 't1',
      toolName: 'read_file',
      content,
      isError: false,
      timestamp: 0,
    }
  }

  function assistantMsg(): AssistantMessage {
    return {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 0,
    }
  }

  test('returns the same array reference when nothing needs scrubbing', () => {
    const messages: Message[] = [
      userMsg([text('hi'), smallImage()]),
      toolResultMsg([smallImage(), text('ok')]),
      assistantMsg(),
    ]
    const out = scrubOversizedImages(messages)
    expect(out).toBe(messages)
  })

  test('rewrites oversized images in ToolResultMessage.content', () => {
    const toolResult = toolResultMsg([bigImage(), text('meta')])
    const messages: Message[] = [toolResult]
    const out = scrubOversizedImages(messages)
    expect(out).not.toBe(messages)
    const cleaned = out[0] as ToolResultMessage
    expect(cleaned.role).toBe('toolResult')
    expect(cleaned.toolCallId).toBe('t1')
    expect(cleaned.content[0].type).toBe('text')
    expect((cleaned.content[0] as TextContent).text).toContain('Image omitted')
    expect(cleaned.content[1]).toEqual({ type: 'text', text: 'meta' })
  })

  test('rewrites oversized images in UserMessage.content arrays', () => {
    const messages: Message[] = [userMsg([bigImage()])]
    const out = scrubOversizedImages(messages)
    expect(out).not.toBe(messages)
    const cleaned = out[0] as UserMessage
    expect(Array.isArray(cleaned.content)).toBe(true)
    const arr = cleaned.content as (TextContent | ImageContent)[]
    expect(arr[0].type).toBe('text')
  })

  test('leaves UserMessage with string content untouched', () => {
    const msg: UserMessage = { role: 'user', content: 'plain text', timestamp: 0 }
    const out = scrubOversizedImages([msg])
    expect(out[0]).toBe(msg)
  })

  test('leaves AssistantMessage untouched even when adjacent messages get scrubbed', () => {
    const assistant = assistantMsg()
    const tool = toolResultMsg([bigImage()])
    const messages: Message[] = [assistant, tool]
    const out = scrubOversizedImages(messages)
    expect(out[0]).toBe(assistant)
    expect(out[1]).not.toBe(tool)
  })

  test('is deterministic: re-running on already-scrubbed messages is a no-op', () => {
    const messages: Message[] = [toolResultMsg([bigImage()])]
    const once = scrubOversizedImages(messages)
    const twice = scrubOversizedImages(once)
    expect(twice).toBe(once)
  })

  test('rewrites unsupported-format images already sitting in ToolResultMessage history', () => {
    // Regression test: an agent reading e.g. `public/favicon.ico` via
    // read_file embeds an `image/x-icon` block into a tool result. Every
    // subsequent turn that replays this message from history must NOT
    // resend the raw .ico bytes — DeepSeek (and any provider outside
    // {png,jpeg,gif,webp}) rejects the whole request with a 400, which
    // previously repeated on every later turn in the same session.
    const toolResult = toolResultMsg([unsupportedFormatImage(), text('meta')])
    const messages: Message[] = [toolResult]
    const out = scrubOversizedImages(messages)
    expect(out).not.toBe(messages)
    const cleaned = out[0] as ToolResultMessage
    expect(cleaned.content[0].type).toBe('text')
    expect((cleaned.content[0] as TextContent).text).toContain('Image omitted')
  })
})
