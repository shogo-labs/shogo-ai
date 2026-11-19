// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Saving a chat file to the device from the attachment card.
 *
 * The attachment URL already carries its own signed token, so no session or
 * cookie is involved on either platform.
 *
 * The route already serves pictures, video, audio and PDFs `inline` so they can
 * be previewed in place, which means following the link would open them instead
 * of saving them. Every download therefore asks for one explicitly (`?dl=1`,
 * see the conversation-file route), and the browser is handed an anchor with a
 * `download` name as well — the header is what does the work when the file is
 * served from another origin, where the attribute is ignored.
 *
 * Native streams the file straight to app storage (`download-to-file`, SHO-434)
 * and then presents the share sheet.
 */

import { Linking, Platform } from 'react-native'
import { downloadFileToCache, shareCachedFile } from './download-to-file'

/** `?dl=1` on a capability URL, keeping the token it already carries. */
export function attachmentDownloadUrl(url: string): string {
  const [beforeHash, ...rest] = url.split('#')
  const hash = rest.length ? `#${rest.join('#')}` : ''
  if (/[?&]dl=1(?:&|$)/.test(beforeHash)) return url
  const separator = beforeHash.includes('?') ? '&' : '?'
  return `${beforeHash}${separator}dl=1${hash}`
}

function fileNameFrom(name: string): string {
  const base = name.split(/[\\/]/).pop()?.trim()
  return base || 'download'
}

function clickDownloadLink(href: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename
  anchor.rel = 'noopener noreferrer'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

async function saveToDevice(url: string, name: string): Promise<void> {
  // The URL carries its own signed token, so no session header is needed — and
  // the bytes go to disk on the native side, never through the JS heap
  // (SHO-434: a large attachment asked Android for a 54 MB allocation).
  const fileUri = await downloadFileToCache(url, { name })
  await shareCachedFile(fileUri, name)
}

export async function downloadAttachment(url: string, name: string): Promise<void> {
  const href = attachmentDownloadUrl(url)
  const filename = fileNameFrom(name)

  if (Platform.OS === 'web') {
    if (typeof document !== 'undefined') clickDownloadLink(href, filename)
    return
  }

  try {
    await saveToDevice(href, filename)
  } catch {
    // The share sheet needs the file on disk; when that fails the link still
    // hands the file to the browser or the OS, which is better than nothing.
    await Linking.openURL(href).catch(() => undefined)
  }
}
