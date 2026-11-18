// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reading a `data:` URL in the app.
 *
 * A pasted long-text block travels through chat as a `data:text/markdown;base64,…`
 * attachment (see `long-text-utils`), and Android cannot open a `data:` URL —
 * handing one to `Linking.openURL` throws `Could not open URL 'data:…'`
 * (SHOGO-ANDROID-1D, SHO-436). The bytes are already here, so text files are
 * decoded locally and shown in the app's own viewer.
 */

export interface DataUrlText {
  text: string
  mediaType: string
}

const DATA_URL_RE = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/is

function decodeBase64(value: string): string | null {
  const clean = value.replace(/\s+/g, '')
  let binary: string
  try {
    const decoded = (globalThis as any).atob(clean) as string | undefined
    if (typeof decoded !== 'string') return null
    binary = decoded
  } catch {
    return null
  }

  const decoder: any = (globalThis as any).TextDecoder
  if (typeof decoder === 'function') {
    try {
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
      return new decoder('utf-8').decode(bytes)
    } catch {}
  }
  try {
    return decodeURIComponent(escape(binary))
  } catch {
    return binary
  }
}

/**
 * The text a `data:` URL carries, or null when it is not a data URL, not text,
 * or cannot be decoded. Percent-encoded and base64 bodies both work.
 */
export function decodeDataUrlText(url: string): DataUrlText | null {
  if (typeof url !== 'string' || !url.startsWith('data:')) return null
  const match = DATA_URL_RE.exec(url)
  if (!match) return null

  const mediaType = (match[1] || 'text/plain').toLowerCase()
  const parameters = match[2] ?? ''
  const body = match[3] ?? ''

  const isText = mediaType.startsWith('text/') || mediaType.includes('json') || mediaType.includes('markdown')
  if (!isText) return null

  if (/;base64/i.test(parameters)) {
    const text = decodeBase64(body)
    return text === null ? null : { text, mediaType }
  }

  try {
    return { text: decodeURIComponent(body), mediaType }
  } catch {
    return { text: body, mediaType }
  }
}
