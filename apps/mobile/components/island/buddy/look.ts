// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Display names and presets for the Shogo buddy's accessories. The look
// itself (ids, validation, defaults) lives in @shogo/shared-app/buddy-look.

import {
  BUDDY_FACE_IDS,
  BUDDY_TOPPER_IDS,
  DEFAULT_BUDDY_LOOK,
  sameLook,
  type BuddyFace,
  type BuddyLook,
  type BuddyTopper,
} from "@shogo/shared-app/buddy-look"

export {
  DEFAULT_BUDDY_LOOK,
  normalizeBuddyLook,
  sameLook,
  type BuddyFace,
  type BuddyLook,
  type BuddyTopper,
} from "@shogo/shared-app/buddy-look"

export const BUDDY_TOPPERS: Record<BuddyTopper, string> = {
  orb: "Antenna",
  stubby: "Stubby antenna",
  ears: "Cat ears",
  none: "Nothing",
}

export const BUDDY_FACES: Record<BuddyFace, string> = {
  classic: "Classic",
  visor: "Robot visor",
  screen: "Terminal screen",
}

export const BUDDY_TOPPER_NAMES: readonly BuddyTopper[] = BUDDY_TOPPER_IDS
export const BUDDY_FACE_NAMES: readonly BuddyFace[] = BUDDY_FACE_IDS

export interface BuddyPreset {
  id: string
  label: string
  look: BuddyLook
}

/** Ready-made looks to start customising from. */
export const BUDDY_PRESETS: BuddyPreset[] = [
  { id: "classic", label: "Classic", look: DEFAULT_BUDDY_LOOK },
  { id: "kitty", label: "Kitty", look: { topper: "ears", face: "classic", bolts: false, blush: true } },
  { id: "visor-bot", label: "Visor bot", look: { topper: "stubby", face: "visor", bolts: true, blush: false } },
  { id: "terminal", label: "Terminal", look: { topper: "none", face: "screen", bolts: false, blush: false } },
  { id: "hacker-cat", label: "Hacker cat", look: { topper: "ears", face: "screen", bolts: false, blush: false } },
]

/** The preset this look matches exactly, if any. */
export function presetForLook(look: BuddyLook): BuddyPreset | undefined {
  return BUDDY_PRESETS.find((preset) => sameLook(preset.look, look))
}
