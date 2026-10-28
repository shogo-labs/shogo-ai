// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Huddle media on web and Electron. Native builds use `huddle-media.native.ts`. */
import type { HuddleMedia, HuddleMediaHandlers, HuddleMediaOptions } from './huddle-room'

export type {
  ConnectionQualityLevel,
  HuddleDevice,
  HuddleDeviceKind,
  HuddleMedia,
  HuddleMediaHandlers,
  HuddleMediaOptions,
  HuddleParticipantState,
  HuddleReactionEvent,
  HuddleVideoTile,
} from './huddle-room'

export async function connectHuddleMedia(
  url: string,
  token: string,
  handlers: HuddleMediaHandlers,
  options?: HuddleMediaOptions,
): Promise<HuddleMedia> {
  const { connectHuddleRoom } = await import('./huddle-room')
  return connectHuddleRoom(url, token, handlers, options)
}

export const huddleMediaSupported = true
export const huddleVideoSupported = true
export const screenShareSupported =
  typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function'
