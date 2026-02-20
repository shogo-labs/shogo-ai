/**
 * User message extraction for AI SDK v3 (parts) and legacy (content) formats.
 * Shared between project-runtime and agent-runtime.
 */

/** Anthropic API content block types used by session.send(SDKUserMessage) */
export type TextBlock = { type: 'text'; text: string }
export type ImageBlock = {
  type: 'image'
  source: {
    type: 'base64'
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
    data: string
  }
}
export type ContentBlock = TextBlock | ImageBlock

/**
 * Find the last user message in a messages array.
 */
export function findLastUserMessage(messages: any[]): any | null {
  return [...messages].reverse().find((m: any) => m.role === 'user') ?? null
}

/**
 * Extract plain text from a user message object.
 * Handles AI SDK v3 `parts` format, legacy `content` string,
 * and legacy `content` array format.
 */
export function extractUserText(message: any): string {
  if (typeof message.content === 'string') {
    return message.content
  }
  if (Array.isArray(message.parts)) {
    return message.parts
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('\n')
  }
  return String(message.content ?? '')
}

/**
 * Safely read session.sessionId, which throws if the session hasn't
 * received its first message yet (e.g. freshly created, no prewarm).
 */
export function safeSessionId(session: { readonly sessionId: string }): string {
  try {
    return session.sessionId
  } catch {
    return ''
  }
}

function parseDataUrl(dataUrl: string): { mimeType: string; base64Data: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  return { mimeType: match[1], base64Data: match[2] }
}

/**
 * Extract full user content including images, returning a format compatible
 * with Anthropic's MessageParam content field.
 *
 * Returns a plain string when no images are present (backward compatible).
 * Returns an array of ContentBlockParam (text + image blocks) when images exist.
 */
export function extractUserContent(message: any): string | ContentBlock[] {
  if (typeof message.content === 'string') {
    return message.content
  }

  if (Array.isArray(message.parts)) {
    const blocks: ContentBlock[] = []
    let hasImages = false

    for (const part of message.parts) {
      if (part.type === 'text' && part.text) {
        blocks.push({ type: 'text', text: part.text })
      } else if (part.type === 'file' && part.mediaType?.startsWith('image/') && part.url) {
        const parsed = parseDataUrl(part.url)
        if (parsed) {
          hasImages = true
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: parsed.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: parsed.base64Data,
            },
          })
        }
      }
    }

    if (!hasImages) {
      return blocks
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
    }

    return blocks
  }

  return String(message.content ?? '')
}
