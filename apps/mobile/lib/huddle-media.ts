// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Huddle media on web and Electron. Native builds use `huddle-media.native.ts`. */
export { connectHuddleRoom as connectHuddleMedia } from './huddle-room'
export type { HuddleMedia, HuddleMediaHandlers, HuddleVideoTile } from './huddle-room'

export const huddleMediaSupported = true
export const huddleVideoSupported = true
export const screenShareSupported =
  typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function'
