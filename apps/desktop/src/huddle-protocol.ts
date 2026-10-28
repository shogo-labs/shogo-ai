// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What the app window and the huddle window say to each other.
 *
 * On desktop the LiveKit room lives in the huddle window (video tracks can't
 * cross renderer processes), and the app window mirrors its state and sends
 * it commands. Everything here is plain JSON, validated on arrival: the
 * huddle window loads the full app bundle, so main treats both ends as
 * untrusted input.
 */

export const HUDDLE_WINDOW_ARG = '--shogo-huddle'

/** The huddle window is either the large call panel or the small floating card. */
export type HuddleWindowMode = 'expanded' | 'mini'

export interface HuddleJoinRequest {
  conversationId: string
  workspaceId: string
  label: string
  kind: string | null
  startMuted?: boolean
  startCamera?: boolean
}

export type HuddleCommand =
  | { type: 'leave' }
  | { type: 'mute'; muted: boolean }
  | { type: 'camera'; on: boolean }
  | { type: 'screen'; on: boolean }
  | { type: 'reaction'; emoji: string }
  | { type: 'hand'; raised: boolean }
  | { type: 'view'; view: 'expanded' | 'mini' | 'pill' }
  | { type: 'layout'; layout: 'grid' | 'speaker' }
  | { type: 'pin'; userId: string | null }
  | { type: 'resume-playback' }

const MAX_STRING = 500

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING ? value : null
}

export function parseJoinRequest(raw: unknown): HuddleJoinRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const conversationId = str(r.conversationId)
  const workspaceId = str(r.workspaceId)
  if (!conversationId || !workspaceId) return null
  return {
    conversationId,
    workspaceId,
    label: typeof r.label === 'string' ? r.label.slice(0, MAX_STRING) : '',
    kind: typeof r.kind === 'string' ? r.kind.slice(0, 40) : null,
    ...(typeof r.startMuted === 'boolean' ? { startMuted: r.startMuted } : {}),
    ...(typeof r.startCamera === 'boolean' ? { startCamera: r.startCamera } : {}),
  }
}

export function parseHuddleCommand(raw: unknown): HuddleCommand | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  switch (r.type) {
    case 'leave':
      return { type: 'leave' }
    case 'resume-playback':
      return { type: 'resume-playback' }
    case 'mute':
      return typeof r.muted === 'boolean' ? { type: 'mute', muted: r.muted } : null
    case 'camera':
      return typeof r.on === 'boolean' ? { type: 'camera', on: r.on } : null
    case 'screen':
      return typeof r.on === 'boolean' ? { type: 'screen', on: r.on } : null
    case 'hand':
      return typeof r.raised === 'boolean' ? { type: 'hand', raised: r.raised } : null
    case 'reaction': {
      const emoji = str(r.emoji)
      return emoji && emoji.length <= 16 ? { type: 'reaction', emoji } : null
    }
    case 'view':
      return r.view === 'expanded' || r.view === 'mini' || r.view === 'pill' ? { type: 'view', view: r.view } : null
    case 'layout':
      return r.layout === 'grid' || r.layout === 'speaker' ? { type: 'layout', layout: r.layout } : null
    case 'pin':
      return r.userId === null ? { type: 'pin', userId: null } : str(r.userId) ? { type: 'pin', userId: r.userId as string } : null
    default:
      return null
  }
}

export function parseHuddleMode(raw: unknown): HuddleWindowMode | null {
  return raw === 'expanded' || raw === 'mini' ? raw : null
}

/** A state snapshot is forwarded as-is to the app window, so only its size and shape are checked here. */
export function parseHuddleSnapshot(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  try {
    if (JSON.stringify(raw).length > 256_000) return null
  } catch {
    return null
  }
  return raw as Record<string, unknown>
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const HUDDLE_MINI_SIZE = { width: 340, height: 230 }
export const HUDDLE_EXPANDED_SIZE = { width: 980, height: 680 }
export const HUDDLE_MIN_SIZE = { width: 320, height: 220 }
const MARGIN = 16

/**
 * Where the window goes for a mode. The mini card tucks into the bottom-right
 * corner of the work area unless it was already placed there by the person;
 * the expanded panel is centered. Both stay fully on screen.
 */
export function huddleBounds(mode: HuddleWindowMode, workArea: Rect, previous?: Rect | null): Rect {
  const size = mode === 'mini' ? HUDDLE_MINI_SIZE : HUDDLE_EXPANDED_SIZE
  const width = Math.min(size.width, workArea.width - MARGIN * 2)
  const height = Math.min(size.height, workArea.height - MARGIN * 2)
  if (mode === 'mini') {
    const x = previous ? previous.x + previous.width - width : workArea.x + workArea.width - width - MARGIN
    const y = previous ? previous.y + previous.height - height : workArea.y + workArea.height - height - MARGIN
    return clampToArea({ x, y, width, height }, workArea)
  }
  return clampToArea(
    {
      x: previous ? previous.x + Math.round((previous.width - width) / 2) : workArea.x + Math.round((workArea.width - width) / 2),
      y: previous ? previous.y + Math.round((previous.height - height) / 2) : workArea.y + Math.round((workArea.height - height) / 2),
      width,
      height,
    },
    workArea,
  )
}

export function clampToArea(rect: Rect, area: Rect): Rect {
  return {
    ...rect,
    x: Math.min(Math.max(rect.x, area.x), area.x + area.width - rect.width),
    y: Math.min(Math.max(rect.y, area.y), area.y + area.height - rect.height),
  }
}
