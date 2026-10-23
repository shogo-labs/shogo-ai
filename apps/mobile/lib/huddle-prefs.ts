// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * How you like your huddles on this device: which view the call opens in,
 * your mic / camera / speaker, your camera background, and the layout. Kept
 * per device (like the dock bounce), restored on the next call and applied
 * again whenever the camera turns on.
 */
import { useSyncExternalStore } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'

const STORAGE_KEY = 'shogo:huddle-prefs'

/** The call surface: a full panel, a small floating card, or a pill. */
export type HuddleViewMode = 'expanded' | 'mini' | 'pill'
export type HuddleLayout = 'grid' | 'speaker'
export type MiniCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** What replaces (or softens) the background behind you. */
export type BackgroundEffect =
  | { kind: 'none' }
  | { kind: 'blur'; radius: number }
  | { kind: 'image'; url: string; name: string }

export interface HuddlePrefs {
  view: HuddleViewMode
  layout: HuddleLayout
  miniCorner: MiniCorner
  micId: string | null
  cameraId: string | null
  speakerId: string | null
  background: BackgroundEffect
  autoFraming: boolean
  lowLight: boolean
  /** Join with the camera off even when it was on last time. */
  previewBeforeJoin: boolean
}

export const DEFAULT_HUDDLE_PREFS: HuddlePrefs = {
  view: 'mini',
  layout: 'grid',
  miniCorner: 'bottom-right',
  micId: null,
  cameraId: null,
  speakerId: null,
  background: { kind: 'none' },
  autoFraming: false,
  lowLight: false,
  previewBeforeJoin: true,
}

/** Backgrounds that ship with the app: soft gradients, so no image files are needed. */
export const BUILT_IN_BACKGROUNDS: Array<{ id: string; name: string; url: string }> = [
  { id: 'dusk', name: 'Dusk', url: gradientDataUrl('#312e81', '#be185d') },
  { id: 'ocean', name: 'Ocean', url: gradientDataUrl('#0f766e', '#1d4ed8') },
  { id: 'forest', name: 'Forest', url: gradientDataUrl('#14532d', '#65a30d') },
  { id: 'slate', name: 'Slate', url: gradientDataUrl('#1e293b', '#64748b') },
]

function gradientDataUrl(from: string, to: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>` +
    `<rect width="1280" height="720" fill="url(#g)"/></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

let prefs: HuddlePrefs = DEFAULT_HUDDLE_PREFS
let hydrated = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

function sanitize(raw: unknown): Partial<HuddlePrefs> {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: Partial<HuddlePrefs> = {}
  if (r.view === 'expanded' || r.view === 'mini' || r.view === 'pill') out.view = r.view
  if (r.layout === 'grid' || r.layout === 'speaker') out.layout = r.layout
  if (r.miniCorner === 'top-left' || r.miniCorner === 'top-right' || r.miniCorner === 'bottom-left' || r.miniCorner === 'bottom-right') out.miniCorner = r.miniCorner
  for (const key of ['micId', 'cameraId', 'speakerId'] as const) {
    if (typeof r[key] === 'string' || r[key] === null) out[key] = r[key] as string | null
  }
  const bg = r.background as Record<string, unknown> | undefined
  if (bg?.kind === 'none') out.background = { kind: 'none' }
  else if (bg?.kind === 'blur' && typeof bg.radius === 'number') out.background = { kind: 'blur', radius: bg.radius }
  else if (bg?.kind === 'image' && typeof bg.url === 'string') out.background = { kind: 'image', url: bg.url, name: typeof bg.name === 'string' ? bg.name : 'Custom' }
  for (const key of ['autoFraming', 'lowLight', 'previewBeforeJoin'] as const) {
    if (typeof r[key] === 'boolean') out[key] = r[key] as boolean
  }
  return out
}

async function hydrate(): Promise<void> {
  if (hydrated) return
  hydrated = true
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    if (raw) {
      prefs = { ...prefs, ...sanitize(JSON.parse(raw)) }
      notify()
    }
  } catch {
    // Keep the defaults.
  }
}

void hydrate()

export function getHuddlePrefs(): HuddlePrefs {
  return prefs
}

export function setHuddlePrefs(patch: Partial<HuddlePrefs>): void {
  prefs = { ...prefs, ...patch }
  notify()
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)).catch(() => {
    // The choice then lasts until the app restarts.
  })
}

export function subscribeHuddlePrefs(listener: () => void): () => void {
  listeners.add(listener)
  void hydrate()
  return () => {
    listeners.delete(listener)
  }
}

export function useHuddlePrefs(): HuddlePrefs {
  return useSyncExternalStore(subscribeHuddlePrefs, getHuddlePrefs, getHuddlePrefs)
}

export function _resetHuddlePrefsForTests(): void {
  prefs = DEFAULT_HUDDLE_PREFS
  hydrated = true
  notify()
}
