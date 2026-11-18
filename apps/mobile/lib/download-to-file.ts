// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A remote file into app storage, without the bytes crossing the JS bridge.
 *
 * Every native "save / share this file" affordance used to read the whole
 * response into `arrayBuffer()`, build a binary string in 32 KB chunks and
 * `btoa()` that into a base64 string 33% larger — three full copies of the file
 * on the JS heap at once, plus the transient string each `binary +=` allocates.
 * A single large attachment asked Android for a 54 MB allocation and took the
 * process down (SHO-434); on iOS the same spike is what the RAM watchdog kills
 * an app for, and a multi-megabyte `btoa()` also blocks the JS thread long
 * enough to look like a hang.
 *
 * `expo-file-system`'s `downloadAsync` hands the URL to the platform's own
 * networking stack and writes straight to disk, so the JS heap holds nothing
 * but a path, whatever the file's size.
 *
 * Nothing here imports React Native or expo statically: the module is unit
 * tested in a plain Bun process, and every platform call happens inside the
 * function that needs it.
 */

/** How long a share sheet may wait for the screen to settle before it opens. */
export const SHARE_SETTLE_MS = 2000

export interface DownloadToCacheOptions {
  /** File name for the local copy — the share sheet's suggestion to the user. */
  name: string
  /** Request headers. An authenticated URL needs the session cookie here. */
  headers?: Record<string, string>
  /** Directory to write into. Defaults to the app's cache directory. */
  directory?: string
}

/**
 * The leaf name to write, made safe for a filesystem path.
 *
 * The name arrives from a chat message, so it can carry a path from another
 * machine (`conversations/ws-1/report.pdf`) or characters a file system will
 * not take. A download must never be able to write outside the cache
 * directory because of what the sender called the file.
 */
export function safeCacheFileName(name: string, fallback = 'download'): string {
  const leaf = (name.split(/[\\/]/).pop() ?? '').trim()
  const cleaned = leaf
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || fallback
}

/**
 * Download `url` to a file in app storage and return its `file://` URI.
 *
 * Throws on a non-2xx status so the caller can report the real reason; the
 * half-written file is removed rather than left in the cache.
 */
export async function downloadFileToCache(
  url: string,
  options: DownloadToCacheOptions,
): Promise<string> {
  const { cacheDirectory, downloadAsync, deleteAsync } = await import(
    'expo-file-system/legacy'
  )
  const dir = options.directory ?? cacheDirectory
  if (!dir) throw new Error('Could not reach app storage')

  const target = `${dir}${Date.now()}-${safeCacheFileName(options.name)}`
  const result = await downloadAsync(
    url,
    target,
    options.headers && Object.keys(options.headers).length
      ? { headers: options.headers }
      : undefined,
  )

  if (result.status < 200 || result.status >= 300) {
    await deleteAsync(target, { idempotent: true }).catch(() => {})
    throw new Error(`Download failed (${result.status})`)
  }
  return result.uri
}

/**
 * Present a downloaded file through the OS share / save sheet.
 *
 * iOS falls back to React Native's own `Share` when the share extension
 * declines (a simulator, or a file type it will not preview); Android rethrows,
 * because its sheet opens for anything the app can read.
 */
export async function shareCachedFile(
  fileUri: string,
  name: string,
): Promise<void> {
  const { InteractionManager, Platform, Share } = await import('react-native')
  // Let the screen settle before the OS presents its sheet.
  await new Promise<void>((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    // A sheet is a nicety; a screen mid-animation must not be able to wedge it.
    setTimeout(done, SHARE_SETTLE_MS)
    InteractionManager.runAfterInteractions(done)
  })

  const Sharing = await import('expo-sharing')
  try {
    await Sharing.shareAsync(fileUri, { dialogTitle: `Download ${name}` })
  } catch (shareError: unknown) {
    if (Platform.OS !== 'ios') throw shareError
    await Share.share({ url: fileUri, title: name })
  }
}
