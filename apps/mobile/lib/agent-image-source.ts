// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useState } from "react"
import { Platform, type ImageURISource } from "react-native"
import { authClient } from "./auth-client"
import { agentFetch } from "./agent-fetch"
import { createAgentImageSource as createCoreAgentImageSource } from "./agent-image-source-core"

/**
 * React Native Image does not use the native fetch cookie jar. Attach the
 * Better Auth session explicitly on iOS and Android while leaving web to its
 * normal credentialed request behavior.
 */
export function createAgentImageSource(
  uri: string,
  platform: string,
  cookie?: string | null,
): ImageURISource {
  return createCoreAgentImageSource(uri, platform, cookie)
}

export function getAgentImageSource(uri: string): ImageURISource {
  return createAgentImageSource(
    uri,
    Platform.OS,
    (authClient as any).getCookie?.(),
  )
}

/**
 * A workspace download URL is behind the session, so `<Image>` cannot fetch it
 * on its own: web `<img>` does not reliably send cross-origin cookies and
 * native Image implementations differ in `Cookie` header support. Those go
 * through the loader below; everything else (a `data:` URL, a capability URL
 * with its own signed token, a `blob:`) loads directly.
 */
export function needsAgentImageLoad(uri: string): boolean {
  return uri.includes("/agent/workspace/download/")
}

/** How many decoded images stay in memory before the oldest is dropped. */
export const MAX_CACHED_IMAGES = 40

/**
 * How many images may be in flight at once. A resumed chat mounts every photo
 * in the turn window at the same moment; without a cap they all compete for
 * the connection and the one at the bottom — the one the person is looking at
 * — finishes last.
 */
export const MAX_CONCURRENT_IMAGE_LOADS = 3

/** uri -> something `<Image>` can paint (`blob:` on web, `file://` on native). */
const resolved = new Map<string, string>()
/** uri -> the load already running for it, so two callers share one request. */
const inFlight = new Map<string, Promise<string | null>>()

let activeLoads = 0
/**
 * Waiting loads, newest first. Mount order in a resumed chat runs oldest turn
 * to newest, so the last request queued is the photo nearest the bottom of the
 * screen — the one that has to appear first.
 */
const waiting: Array<() => void> = []

function cacheGet(uri: string): string | null {
  const hit = resolved.get(uri)
  if (!hit) return null
  // Re-insert so the map's own order is the LRU order.
  resolved.delete(uri)
  resolved.set(uri, hit)
  return hit
}

function cacheSet(uri: string, displayUri: string): void {
  resolved.delete(uri)
  resolved.set(uri, displayUri)
  while (resolved.size > MAX_CACHED_IMAGES) {
    const oldest = resolved.keys().next()
    if (oldest.done) break
    const evicted = resolved.get(oldest.value)
    resolved.delete(oldest.value)
    // A native file stays on disk (that is the point of the disk cache), so
    // only a web object URL has to be released.
    if (evicted && evicted.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(evicted)
      } catch {
        /* already revoked */
      }
    }
  }
}

/** Test seam: forget every cached image and pending load. */
export function resetAgentImageCache(): void {
  for (const displayUri of resolved.values()) {
    if (displayUri.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(displayUri)
      } catch {
        /* already revoked */
      }
    }
  }
  resolved.clear()
  inFlight.clear()
  waiting.length = 0
  activeLoads = 0
}

function acquireSlot(): Promise<void> {
  if (activeLoads < MAX_CONCURRENT_IMAGE_LOADS) {
    activeLoads += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    waiting.push(() => {
      activeLoads += 1
      resolve()
    })
  })
}

function releaseSlot(): void {
  activeLoads = Math.max(0, activeLoads - 1)
  const next = waiting.pop()
  next?.()
}

/** Stable, filesystem-safe name for a URL, so a resume reuses the same file. */
export function imageCacheKey(uri: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < uri.length; index += 1) {
    hash ^= uri.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const tail = uri.split(/[?#]/)[0].split("/").pop() || "image"
  const safeTail = tail.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-40)
  return `${hash.toString(16)}-${safeTail}`
}

async function loadOnWeb(uri: string): Promise<string | null> {
  const response = await agentFetch(uri)
  if (!response.ok) throw new Error(`Image request failed (${response.status})`)
  const blob = await response.blob()
  return URL.createObjectURL(blob)
}

async function loadOnNative(uri: string): Promise<string | null> {
  const { cacheDirectory, downloadAsync, getInfoAsync, makeDirectoryAsync } =
    await import("expo-file-system/legacy")
  if (!cacheDirectory) return null
  const dir = `${cacheDirectory}chat-images/`
  await makeDirectoryAsync(dir, { intermediates: true }).catch(() => {})
  const target = `${dir}${imageCacheKey(uri)}`
  // The disk cache is what makes a second resume free: the file is already
  // there, so nothing goes over the network.
  const existing = await getInfoAsync(target).catch(() => null)
  if (existing?.exists) return target
  const cookie = (authClient as any).getCookie?.()
  const result = await downloadAsync(
    uri,
    target,
    cookie ? { headers: { Cookie: cookie } } : undefined,
  )
  if (result.status !== 200) {
    throw new Error(`Image request failed (${result.status})`)
  }
  return result.uri
}

/**
 * The display URI for `uri`, loading it once and caching the result.
 *
 * Concurrent callers for the same URL share one request, and at most
 * `MAX_CONCURRENT_IMAGE_LOADS` run at a time. Resolves to null when the image
 * cannot be loaded, so the caller can fall back to the raw URL.
 */
export function loadAgentImage(uri: string): Promise<string | null> {
  const cached = cacheGet(uri)
  if (cached) return Promise.resolve(cached)
  const running = inFlight.get(uri)
  if (running) return running

  const load = (async () => {
    await acquireSlot()
    try {
      const displayUri =
        Platform.OS === "web" ? await loadOnWeb(uri) : await loadOnNative(uri)
      if (displayUri) cacheSet(uri, displayUri)
      return displayUri
    } catch {
      return null
    } finally {
      releaseSlot()
      inFlight.delete(uri)
    }
  })()

  inFlight.set(uri, load)
  return load
}

export function useAgentImageSource(uri: string | null): ImageURISource | null {
  const [source, setSource] = useState<ImageURISource | null>(() => {
    if (!uri) return null
    const cached = cacheGet(uri)
    if (cached) return { uri: cached }
    return needsAgentImageLoad(uri) ? null : getAgentImageSource(uri)
  })

  useEffect(() => {
    let cancelled = false
    if (!uri) {
      setSource(null)
      return () => {
        cancelled = true
      }
    }

    const cached = cacheGet(uri)
    if (cached) {
      setSource({ uri: cached })
      return () => {
        cancelled = true
      }
    }

    if (!needsAgentImageLoad(uri)) {
      setSource(getAgentImageSource(uri))
      return () => {
        cancelled = true
      }
    }

    setSource(null)
    void loadAgentImage(uri).then((displayUri) => {
      if (cancelled) return
      // A failed load still hands `<Image>` the raw URL: on native that can
      // work through the platform's own cookie handling, and a broken image
      // beats a permanently blank box.
      setSource(displayUri ? { uri: displayUri } : getAgentImageSource(uri))
    })

    return () => {
      cancelled = true
    }
  }, [uri])

  return source
}
