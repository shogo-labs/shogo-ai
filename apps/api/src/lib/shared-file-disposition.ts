// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which types a share link serves `inline` instead of `attachment`.
 *
 * A picture or a PDF has to render in place: the app points an image / a PDF
 * view straight at the link, and a native WebView only renders a document when
 * the response says `inline` (SHO-388). Everything else keeps saving, which is
 * what a person expects from a download link.
 *
 * SVG is deliberately excluded: it can carry script, so the routes already
 * relabel it `application/octet-stream` and it must stay an attachment.
 *
 * Video and audio are NOT here on purpose. Streaming a clip in place is its own
 * card (SHO-387 / #2001), which owns the range support and the disposition for
 * `video/*` and `audio/*`; this card only adds the picture and the PDF.
 */
export function isInlinePreviewContentType(contentType: string | null | undefined): boolean {
  const type = (contentType ?? '').toLowerCase().split(';')[0]!.trim()
  if (!type) return false
  if (type === 'application/pdf') return true
  if (type === 'image/svg+xml') return false
  return type.startsWith('image/')
}
