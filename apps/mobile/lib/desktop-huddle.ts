// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The bridge between the app and Shogo Desktop's huddle window.
 *
 * On desktop the LiveKit room lives in a separate always-on-top window (so it
 * can render video outside the app). Two sides of one protocol:
 *
 * - The **app window** opens the call, mirrors its state, and sends commands
 *   (`window.shogoDesktop.huddle`).
 * - The **huddle window** runs the room, reports state, and takes commands
 *   (`window.shogoHuddleHost`).
 *
 * Types mirror `apps/desktop/src/huddle-protocol.ts`.
 */

export interface DesktopHuddleJoinRequest {
  conversationId: string
  workspaceId: string
  label: string
  kind: string | null
  startMuted?: boolean
  startCamera?: boolean
}

export type DesktopHuddleCommand =
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

/** What the app window sees of the call: everything except the video tracks, which stay in the huddle window. */
export type DesktopHuddleSnapshot = Record<string, unknown>

export interface DesktopHuddleAppBridge {
  open(request: DesktopHuddleJoinRequest): Promise<{ ok: boolean; error?: string }>
  command(command: DesktopHuddleCommand): void
  focus(mode?: 'expanded' | 'mini'): void
  onState(callback: (snapshot: DesktopHuddleSnapshot) => void): () => void
}

export interface DesktopHuddleHostBridge {
  onJoin(callback: (request: DesktopHuddleJoinRequest) => void): () => void
  onCommand(callback: (command: DesktopHuddleCommand) => void): () => void
  requestJoin(): void
  sendState(snapshot: DesktopHuddleSnapshot): void
  setMode(mode: 'expanded' | 'mini'): void
  close(): void
  showApp(path?: string): void
}

type Win = Window & {
  shogoDesktop?: { huddle?: DesktopHuddleAppBridge }
  shogoHuddleHost?: DesktopHuddleHostBridge
}

function win(): Win | null {
  return typeof window === 'undefined' ? null : (window as Win)
}

/** Present in the huddle window itself. */
export function getHuddleHostBridge(): DesktopHuddleHostBridge | null {
  return win()?.shogoHuddleHost ?? null
}

/**
 * Present in app windows on desktop, where the call is hosted by the huddle
 * window. Never present in the huddle window (which hosts the room directly).
 */
export function getHuddleAppBridge(): DesktopHuddleAppBridge | null {
  const w = win()
  if (!w || w.shogoHuddleHost) return null
  return w.shogoDesktop?.huddle ?? null
}
