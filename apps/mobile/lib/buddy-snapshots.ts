// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Still images of Shogo buddy looks, for lists of agents on native. A buddy is
 * drawn by a WebView there, far too heavy to put in every message row, so one
 * hidden renderer (`BuddySnapshotHost`) draws each distinct look once and the
 * rows show the resulting picture. Results are cached in memory and in
 * storage, keyed by the look and body colour.
 */
import type { BuddyLook } from '@shogo/shared-app/buddy-look'
import { safeGetItem, safeSetItem } from './safe-storage'

const STORAGE_PREFIX = 'shogo-buddy-snapshot-v1:'
/** Body width the renderer draws at; avatars are shown at up to about half of this. */
export const SNAPSHOT_BODY_SIZE = 96

export interface SnapshotRequest {
  key: string
  look: BuddyLook
  color: string
}

const images = new Map<string, string>()
const queue: SnapshotRequest[] = []
const queued = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

export function snapshotKey(look: BuddyLook, color: string): string {
  return JSON.stringify([look.topper, look.face, look.tail, look.eyewear, look.neck, look.bolts, look.blush, look.finish, color.toUpperCase()])
}

function changed() {
  version += 1
  for (const listener of [...listeners]) listener()
}

export function subscribeSnapshots(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function snapshotVersion(): number {
  return version
}

/** The cached picture (a data URL) for `key`, from memory or storage. */
export function getSnapshot(key: string): string | null {
  const hit = images.get(key)
  if (hit) return hit
  try {
    const stored = safeGetItem(STORAGE_PREFIX + key)
    if (stored) {
      images.set(key, stored)
      return stored
    }
  } catch {}
  return null
}

/** Ask for a picture of `look`; a no-op if it's cached or already queued. */
export function requestSnapshot(look: BuddyLook, color: string): string {
  const key = snapshotKey(look, color)
  if (!getSnapshot(key) && !queued.has(key)) {
    queued.add(key)
    queue.push({ key, look, color })
    changed()
  }
  return key
}

/** The next look the renderer should draw, or null when it's caught up. */
export function nextSnapshotRequest(): SnapshotRequest | null {
  return queue[0] ?? null
}

/** The renderer finished `key`. */
export function resolveSnapshot(key: string, dataUrl: string | null) {
  const index = queue.findIndex((r) => r.key === key)
  if (index >= 0) queue.splice(index, 1)
  queued.delete(key)
  if (dataUrl) {
    images.set(key, dataUrl)
    try {
      safeSetItem(STORAGE_PREFIX + key, dataUrl)
    } catch {}
  }
  changed()
}

/** Test seam. */
export function resetSnapshots() {
  images.clear()
  queue.length = 0
  queued.clear()
  version += 1
}
