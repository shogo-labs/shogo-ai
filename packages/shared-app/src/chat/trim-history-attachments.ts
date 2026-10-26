// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Keep a chat turn's request body small by dropping the *bytes* of attachments
 * from earlier turns.
 *
 * The transport POSTs the whole transcript on every send, so one file attached
 * an hour ago was re-uploaded on every later turn — and if it was attached as
 * a base64 data URL (the pre-SHO-213 transport, still present in old rows)
 * that is the entire file, every time. Newer turns carry a *reference* part
 * instead (`savedPath` + a workspace URL), which is tiny and passes through
 * untouched; this only rewrites the legacy `data:` parts.
 *
 * The current message is never touched: it is the turn being sent. Earlier
 * messages keep a stub plus a one-line note, so the model still knows
 * something was attached instead of silently losing the fact.
 *
 * Images are the exception: the runtime seeds a cold session's vision context
 * from the client-sent history (SHO-44), so the last few small images stay
 * inline and a reopened chat can still show them to the model.
 */

/** An inline image at or below this size stays inline in earlier turns. */
export const LEGACY_INLINE_IMAGE_KEEP_BYTES = 1024 * 1024

/** How many of the newest inline images earlier turns keep (matches the runtime seed cap). */
export const LEGACY_INLINE_IMAGE_KEEP_COUNT = 6

interface AnyPart {
  type?: string
  url?: string
  mediaType?: string
  name?: string
  filename?: string
  savedPath?: string
  [key: string]: unknown
}

interface AnyMessage {
  role?: string
  parts?: AnyPart[]
  [key: string]: unknown
}

function isInlineDataUrl(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('data:')
}

function inlineBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma === -1) return 0
  return Math.max(0, Math.floor(((dataUrl.length - comma - 1) * 3) / 4))
}

function attachmentName(part: AnyPart): string {
  const name = part.name || part.filename
  return typeof name === 'string' && name ? name : 'attachment'
}

function stubNote(part: AnyPart): string {
  const kind = typeof part.mediaType === 'string' ? part.mediaType : 'file'
  return `[Attachment "${attachmentName(part)}" (${kind}) was sent earlier in this chat; its contents are not resent with later turns.]`
}

/**
 * Messages to POST: identical except that earlier turns' legacy inline
 * attachments become stubs. Returns the same array when nothing changes, so a
 * transcript with no legacy attachments costs nothing.
 */
export function trimLegacyInlineAttachments<M extends AnyMessage>(
  messages: M[],
  options: {
    keepImageBytes?: number
    keepImageCount?: number
  } = {},
): M[] {
  if (messages.length === 0) return messages
  const keepImageBytes = options.keepImageBytes ?? LEGACY_INLINE_IMAGE_KEEP_BYTES
  const keepImageCount = options.keepImageCount ?? LEGACY_INLINE_IMAGE_KEEP_COUNT

  // Everything from the last user message on is the turn being sent (a
  // regenerate re-sends that user message, so its attachments have to stay).
  let boundary = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      boundary = i
      break
    }
  }

  // Which inline images (by message index + part index) survive, newest first.
  const keptImages = new Set<string>()
  for (let m = boundary - 1; m >= 0 && keptImages.size < keepImageCount; m--) {
    const parts = messages[m].parts
    if (!Array.isArray(parts)) continue
    for (let p = parts.length - 1; p >= 0 && keptImages.size < keepImageCount; p--) {
      const part = parts[p]
      if (part?.type !== 'file') continue
      if (!part.mediaType?.startsWith('image/')) continue
      if (!isInlineDataUrl(part.url)) continue
      if (inlineBytes(part.url) > keepImageBytes) continue
      keptImages.add(`${m}:${p}`)
    }
  }

  let changed = false
  const out = messages.map((message, m) => {
    if (m >= boundary) return message
    const parts = message.parts
    if (!Array.isArray(parts)) return message

    let messageChanged = false
    const nextParts: AnyPart[] = []
    parts.forEach((part, p) => {
      if (part?.type !== 'file' || !isInlineDataUrl(part.url)) {
        nextParts.push(part)
        return
      }
      if (keptImages.has(`${m}:${p}`)) {
        nextParts.push(part)
        return
      }
      messageChanged = true
      const stub: AnyPart = { type: 'file' }
      if (part.mediaType) stub.mediaType = part.mediaType
      if (part.name) stub.name = part.name
      else if (part.filename) stub.filename = part.filename
      nextParts.push(stub, { type: 'text', text: stubNote(part) })
    })

    if (!messageChanged) return message
    changed = true
    return { ...message, parts: nextParts }
  })

  return changed ? out : messages
}
