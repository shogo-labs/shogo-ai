// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Image size guard — enforces Anthropic's 5 MB per-image limit on tool_result
 * and user-vision payloads.
 *
 * Anthropic rejects any `tool_result.content[].image.source.base64` whose
 * encoded payload exceeds 5,242,880 bytes. Base64 inflates raw bytes by ~33%,
 * so a ~4.4 MB PNG can produce a ~5.86 MB string that trips the cap. We guard
 * at two layers:
 *
 *   1. At emission time inside tools that can produce images (read_file,
 *      browser screenshot, MCP passthrough), so oversized images never enter
 *      session history.
 *   2. In the per-API-call transformContext, scrub any oversized images that
 *      may already be sitting in history from before this guard shipped.
 *
 * Both layers use the same pure helpers below. The functions are deterministic
 * so they don't disturb stable-compaction's "byte-identical prompt prefix"
 * invariant.
 */

import type { ImageContent, Message, TextContent } from '@mariozechner/pi-ai'

/**
 * Maximum base64 string length permitted in a single image block.
 *
 * Anthropic's documented limit is exactly 5 * 1024 * 1024 bytes; we leave a
 * 4 KB safety margin to avoid tripping the cap on borderline images.
 */
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024 - 4096

export interface OversizedPlaceholderOptions {
  /** Short human-readable source label, e.g. `read_file` or `mcp:foo`. */
  label: string
  /** Original byte length of the base64 string that exceeded the cap. */
  base64Length: number
  /** MIME type of the dropped image, if known. */
  mimeType?: string
  /**
   * Optional workspace-relative path the model can pass to a shell tool to
   * downscale and re-read. When provided, the placeholder embeds a copy-pasta
   * `sips` / `convert` command keyed to this path.
   */
  pathHint?: string
}

/**
 * Build a TextContent block that replaces an oversized image. The text is
 * model-actionable: it names the cap, reports the exact byte count, and (when
 * a path is available) suggests concrete downscale commands.
 */
export function buildOversizedPlaceholder(opts: OversizedPlaceholderOptions): TextContent {
  const { label, base64Length, mimeType, pathHint } = opts
  const sizeMb = (base64Length / (1024 * 1024)).toFixed(2)
  const capMb = (MAX_IMAGE_BASE64_BYTES / (1024 * 1024)).toFixed(2)
  const lines: string[] = [
    `[Image omitted — ${label}]`,
    `Reason: the image's base64 payload is ${base64Length} bytes (${sizeMb} MB), ` +
      `which exceeds Anthropic's per-image cap of ${MAX_IMAGE_BASE64_BYTES} bytes (~${capMb} MB).`,
  ]
  if (mimeType) lines.push(`MIME type: ${mimeType}.`)
  if (pathHint) {
    lines.push(
      `The full image is still on disk at "${pathHint}". ` +
        'Downscale it before reading, e.g. on macOS: ' +
        `\`sips -Z 1024 "${pathHint}" --out "${pathHint}.small.png"\`, ` +
        `or with ImageMagick: \`convert "${pathHint}" -resize 1024x1024 "${pathHint}.small.png"\`, ` +
        'then read the resized file.'
    )
  } else {
    lines.push(
      'Ask for a smaller image, downscale at the source, or use a shell tool to resize ' +
        '(e.g. `sips -Z 1024 <input> --out <output>` or `convert <input> -resize 1024x1024 <output>`).'
    )
  }
  return { type: 'text', text: lines.join(' ') }
}

/**
 * Return a new content array where any ImageContent whose base64 `data`
 * exceeds the cap is replaced with a placeholder TextContent. Content blocks
 * that are already small (or already text) pass through by reference so the
 * caller can rely on cheap equality checks if nothing changed.
 */
export function enforceImageSizeLimit(
  content: ReadonlyArray<TextContent | ImageContent>,
  opts: { label: string; pathHint?: string }
): (TextContent | ImageContent)[] {
  let mutated = false
  const next: (TextContent | ImageContent)[] = []
  for (const block of content) {
    if (block.type === 'image' && typeof block.data === 'string' && block.data.length > MAX_IMAGE_BASE64_BYTES) {
      next.push(buildOversizedPlaceholder({
        label: opts.label,
        base64Length: block.data.length,
        mimeType: block.mimeType,
        pathHint: opts.pathHint,
      }))
      mutated = true
    } else {
      next.push(block)
    }
  }
  return mutated ? next : (content as (TextContent | ImageContent)[])
}

/**
 * Walk a message history and rewrite any UserMessage / ToolResultMessage that
 * carries an oversized image block. AssistantMessages cannot contain images
 * in pi-ai's type model so they're passed through untouched.
 *
 * Returns the same array reference when no message needed scrubbing; this
 * keeps prompt-cache hashes stable across calls when no image is oversized.
 */
export function scrubOversizedImages(messages: ReadonlyArray<Message>): Message[] {
  let mutated = false
  const next: Message[] = []
  for (const msg of messages) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const cleaned = enforceImageSizeLimit(msg.content, { label: 'user_input' })
      if (cleaned !== msg.content) {
        next.push({ ...msg, content: cleaned })
        mutated = true
        continue
      }
    } else if (msg.role === 'toolResult') {
      const cleaned = enforceImageSizeLimit(msg.content, {
        label: `tool:${msg.toolName}`,
      })
      if (cleaned !== msg.content) {
        next.push({ ...msg, content: cleaned })
        mutated = true
        continue
      }
    }
    next.push(msg)
  }
  return mutated ? next : (messages as Message[])
}
