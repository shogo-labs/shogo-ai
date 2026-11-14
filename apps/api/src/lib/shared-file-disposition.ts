// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which types a share link serves `inline` instead of `attachment`.
 *
 * A picture, a video, audio or a PDF has to render in place: the app points an
 * image / a player / a PDF view straight at the link, and a viewer's WebView
 * only renders a document when the response says `inline`. Everything else
 * keeps saving, which is what a person expects from a download link.
 *
 * SVG is deliberately excluded: it can carry script, so the routes already
 * relabel it `application/octet-stream` and it must stay an attachment.
 */
export function isInlinePreviewContentType(contentType: string | null | undefined): boolean {
  const type = (contentType ?? '').toLowerCase().split(';')[0]!.trim()
  if (!type) return false
  if (type === 'application/pdf') return true
  if (type === 'image/svg+xml') return false
  return type.startsWith('image/') || type.startsWith('video/') || type.startsWith('audio/')
}
