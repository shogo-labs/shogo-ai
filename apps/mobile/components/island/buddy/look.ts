// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// The customisable parts of the Shogo buddy. Every Shogo shares the gummy
// block body; a look only picks the accessories.

/** What sits on top of the head. */
export type BuddyTopper = "orb" | "stubby" | "ears" | "none"
/** How the face is drawn. */
export type BuddyFace = "classic" | "visor" | "screen"

export interface BuddyLook {
  topper: BuddyTopper
  face: BuddyFace
  /** Ear-pieces on the sides. */
  bolts: boolean
  /** Rosy cheeks; only shows on the classic face. */
  blush: boolean
}

export const DEFAULT_BUDDY_LOOK: BuddyLook = { topper: "orb", face: "classic", bolts: false, blush: true }

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

export const BUDDY_TOPPER_NAMES = Object.keys(BUDDY_TOPPERS) as BuddyTopper[]
export const BUDDY_FACE_NAMES = Object.keys(BUDDY_FACES) as BuddyFace[]

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

export function sameLook(a: BuddyLook, b: BuddyLook): boolean {
  return a.topper === b.topper && a.face === b.face && a.bolts === b.bolts && a.blush === b.blush
}

/** The preset this look matches exactly, if any. */
export function presetForLook(look: BuddyLook): BuddyPreset | undefined {
  return BUDDY_PRESETS.find((preset) => sameLook(preset.look, look))
}

/**
 * Lenient read of a stored or received look. Each field falls back to the
 * default on its own, so a value saved by a newer client (say, a topper this
 * build doesn't know) still keeps the parts this build understands.
 */
export function normalizeBuddyLook(value: unknown): BuddyLook {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_BUDDY_LOOK
  const v = value as Record<string, unknown>
  return {
    topper: BUDDY_TOPPER_NAMES.includes(v.topper as BuddyTopper) ? (v.topper as BuddyTopper) : DEFAULT_BUDDY_LOOK.topper,
    face: BUDDY_FACE_NAMES.includes(v.face as BuddyFace) ? (v.face as BuddyFace) : DEFAULT_BUDDY_LOOK.face,
    bolts: typeof v.bolts === "boolean" ? v.bolts : DEFAULT_BUDDY_LOOK.bolts,
    blush: typeof v.blush === "boolean" ? v.blush : DEFAULT_BUDDY_LOOK.blush,
  }
}
