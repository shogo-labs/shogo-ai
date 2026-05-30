// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared image actions for chat image previews and thumbnail context menus.
 */

import { Platform } from "react-native"
import * as Clipboard from "expo-clipboard"
import { agentFetch } from "../../lib/agent-fetch"

export type CopyState = "idle" | "copying" | "copied" | "failed"

/**
 * True when running inside the Shogo desktop (Electron) shell, detected via the
 * preload-injected `shogoDesktop` global. The desktop app renders the web
 * bundle, so this lets shared components branch on the desktop runtime (e.g. the
 * image right-click menu only exists on desktop).
 */
export function isShogoDesktop(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as { shogoDesktop?: { isDesktop?: boolean } }).shogoDesktop?.isDesktop
  )
}

function inferImageMimeType(url: string, mediaType?: string): string {
  if (mediaType?.startsWith("image/")) return mediaType
  const dataMatch = /^data:([^;,]+)[;,]/.exec(url)
  if (dataMatch?.[1]?.startsWith("image/")) return dataMatch[1]
  if (/\.jpe?g($|[?#])/i.test(url)) return "image/jpeg"
  if (/\.webp($|[?#])/i.test(url)) return "image/webp"
  if (/\.gif($|[?#])/i.test(url)) return "image/gif"
  return "image/png"
}

function dataUrlToBlob(dataUrl: string, mediaType?: string): Blob {
  const commaIndex = dataUrl.indexOf(",")
  const meta = commaIndex >= 0 ? dataUrl.slice(0, commaIndex) : ""
  const payload = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : ""
  const type = inferImageMimeType(dataUrl, mediaType)
  if (/;base64/i.test(meta)) {
    const binary = atob(payload)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return new Blob([bytes], { type })
  }
  return new Blob([decodeURIComponent(payload)], { type })
}

async function fetchImageBlob(url: string, mediaType?: string): Promise<Blob> {
  // `data:` URLs (e.g. pasted screenshots) must be decoded locally. Routing
  // them through `fetch`/`agentFetch` trips the desktop app's Content-Security-
  // Policy `connect-src` rule, which doesn't allow the `data:` scheme — so the
  // request is refused and "Copy failed" appears even though the inline `<img>`
  // renders fine via `img-src`. Decoding the bytes directly avoids the network.
  if (url.startsWith("data:")) {
    return dataUrlToBlob(url, mediaType)
  }
  // Chat images (especially generated images) are served from the
  // agent proxy at `${agentUrl}/agent/workspace/download/...`, which is
  // cross-origin to the web app and gated behind the session cookie.
  // A bare `fetch` omits credentials and gets a 401/403 even though the
  // `<img>` tag renders fine — so go through `agentFetch`, which sends
  // the cookie on web and a `Cookie` header on native.
  const response = await agentFetch(url)
  if (!response.ok) {
    throw new Error(`Image request failed with ${response.status}`)
  }
  const blob = await response.blob()
  if (blob.type) return blob
  return new Blob([blob], { type: inferImageMimeType(url, mediaType) })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image"))
    reader.readAsDataURL(blob)
  })
}

async function blobToPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob
  if (
    Platform.OS !== "web" ||
    typeof window === "undefined" ||
    typeof document === "undefined"
  ) {
    return blob
  }

  const objectUrl = URL.createObjectURL(blob)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new window.Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error("Failed to decode image"))
      image.src = objectUrl
    })
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, img.naturalWidth || img.width)
    canvas.height = Math.max(1, img.naturalHeight || img.height)
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Canvas is unavailable")
    context.drawImage(img, 0, 0)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((pngBlob) => {
        if (pngBlob) resolve(pngBlob)
        else reject(new Error("Failed to encode image"))
      }, "image/png")
    })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export async function copyImageToClipboard(
  url: string,
  mediaType?: string,
): Promise<Exclude<CopyState, "idle" | "copying">> {
  if (Platform.OS === "web") {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : null
    const ClipboardItemCtor =
      typeof ClipboardItem !== "undefined" ? ClipboardItem : undefined
    if (clipboard?.write && ClipboardItemCtor) {
      try {
        // Resolve the PNG bytes BEFORE constructing the ClipboardItem.
        // Passing a `Promise<Blob>` to `ClipboardItem` is spec-valid but
        // Electron's Chromium fails to write image data that way, so the
        // desktop app reported "Copy failed" even though the fetch
        // succeeded. The originating click keeps transient activation
        // alive across the (fast, local) agent fetch, so writing the
        // already-resolved blob is reliable on both web and desktop.
        const pngBlob = await blobToPng(await fetchImageBlob(url, mediaType))
        await clipboard.write([
          new ClipboardItemCtor({ "image/png": pngBlob }),
        ])
        return "copied"
      } catch {
        return "failed"
      }
    }
    return "failed"
  }

  try {
    const setImageAsync = (Clipboard as typeof Clipboard & {
      setImageAsync?: (base64Image: string) => Promise<void>
    }).setImageAsync
    if (setImageAsync) {
      const blob = await fetchImageBlob(url, mediaType)
      const dataUrl = await blobToDataUrl(blob)
      const base64 = dataUrl.split(",")[1]
      if (base64) {
        await setImageAsync(base64)
        return "copied"
      }
    }
  } catch {
    return "failed"
  }
  return "failed"
}

function inferImageFilename(url: string, fallbackTitle?: string): string {
  const cleanTitle = fallbackTitle
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const fallback = cleanTitle || "image"

  try {
    const pathname = new URL(url, window.location.href).pathname
    const basename = pathname.split("/").filter(Boolean).pop()
    if (basename && /\.[a-z0-9]+$/i.test(basename)) return basename
  } catch {
    // data URLs and malformed remote URLs fall back to the title-based name.
  }

  return `${fallback}.png`
}

function clickDownloadLink(href: string, filename: string): void {
  const anchor = document.createElement("a")
  anchor.href = href
  anchor.download = filename
  anchor.rel = "noopener noreferrer"
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

export async function downloadImage(
  url: string,
  fallbackTitle?: string,
  mediaType?: string,
): Promise<void> {
  if (Platform.OS !== "web" || typeof document === "undefined") return
  const filename = inferImageFilename(url, fallbackTitle)
  try {
    const blob = await fetchImageBlob(url, mediaType)
    const objectUrl = URL.createObjectURL(blob)
    clickDownloadLink(objectUrl, filename)
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  } catch {
    clickDownloadLink(url, filename)
  }
}
