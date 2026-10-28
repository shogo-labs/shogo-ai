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
 * Native follows the same shape as the deliverable download chip: fetch the
 * bytes, write them into app storage, then present the share sheet.
 */

import { InteractionManager, Linking, Platform } from 'react-native'

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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  // Chunked, so a large file cannot blow the argument stack.
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
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
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download failed (${response.status})`)
  const base64 = arrayBufferToBase64(await response.arrayBuffer())

  const { cacheDirectory, writeAsStringAsync, EncodingType } = await import('expo-file-system/legacy')
  if (!cacheDirectory) throw new Error('Could not reach app storage')
  const fileUri = `${cacheDirectory}${Date.now()}-${name}`
  await writeAsStringAsync(fileUri, base64, { encoding: EncodingType.Base64 })

  // Let the screen settle before the OS presents its sheet.
  await new Promise<void>((resolve) => {
    InteractionManager.runAfterInteractions(() => resolve())
  })

  const Sharing = await import('expo-sharing')
  try {
    await Sharing.shareAsync(fileUri, { dialogTitle: `Download ${name}` })
  } catch (shareError: unknown) {
    if (Platform.OS !== 'ios') throw shareError
    const { Share } = await import('react-native')
    await Share.share({ url: fileUri, title: name })
  }
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
