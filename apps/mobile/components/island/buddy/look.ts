// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Display names, colours and presets for the Shogo buddy. The look itself
// (ids, validation, defaults) lives in @shogo/shared-app/buddy-look.

import {
  BUDDY_EYEWEAR_IDS,
  BUDDY_FACE_IDS,
  BUDDY_FINISH_IDS,
  BUDDY_NECK_IDS,
  BUDDY_TAIL_IDS,
  BUDDY_TOPPER_IDS,
  DEFAULT_BUDDY_LOOK,
  sameLook,
  type BuddyEyewear,
  type BuddyFace,
  type BuddyFinishId,
  type BuddyLook,
  type BuddyNeck,
  type BuddyTail,
  type BuddyTopper,
} from "@shogo/shared-app/buddy-look"

export {
  DEFAULT_BUDDY_LOOK,
  normalizeBuddyColor,
  normalizeBuddyLook,
  sameLook,
  type BuddyEyewear,
  type BuddyFace,
  type BuddyFinishId,
  type BuddyLook,
  type BuddyNeck,
  type BuddyTail,
  type BuddyTopper,
} from "@shogo/shared-app/buddy-look"

export const BUDDY_TOPPERS: Record<BuddyTopper, string> = {
  orb: "Antenna",
  stubby: "Stubby antenna",
  ears: "Cat ears",
  fox: "Fox ears",
  bunny: "Bunny ears",
  bear: "Bear ears",
  horns: "Horns",
  halo: "Halo",
  sprout: "Sprout",
  crown: "Crown",
  party: "Party hat",
  beanie: "Beanie",
  wizard: "Wizard hat",
  headphones: "Headphones",
  none: "Nothing",
}

export const BUDDY_FACES: Record<BuddyFace, string> = {
  classic: "Classic",
  visor: "Robot visor",
  screen: "Terminal screen",
}

export const BUDDY_TAILS: Record<BuddyTail, string> = {
  none: "None",
  fox: "Bushy tail",
  cat: "Cat tail",
  bunny: "Bunny puff",
  dragon: "Dragon tail",
  cable: "Robot cable",
}

export const BUDDY_EYEWEAR: Record<BuddyEyewear, string> = {
  none: "None",
  sunglasses: "Sunglasses",
  nerd: "Round glasses",
  monocle: "Monocle",
  stars: "Star shades",
  "3d": "3D glasses",
  goggles: "Ski goggles",
}

export const BUDDY_NECKS: Record<BuddyNeck, string> = {
  none: "None",
  scarf: "Scarf",
  bandana: "Bandana",
  bowtie: "Bow tie",
}

export const BUDDY_TOPPER_NAMES: readonly BuddyTopper[] = BUDDY_TOPPER_IDS
export const BUDDY_FACE_NAMES: readonly BuddyFace[] = BUDDY_FACE_IDS
export const BUDDY_TAIL_NAMES: readonly BuddyTail[] = BUDDY_TAIL_IDS
export const BUDDY_EYEWEAR_NAMES: readonly BuddyEyewear[] = BUDDY_EYEWEAR_IDS
export const BUDDY_NECK_NAMES: readonly BuddyNeck[] = BUDDY_NECK_IDS

export const BUDDY_FINISH_LABELS: Record<BuddyFinishId, { label: string; hint: string }> = {
  classic: { label: "Classic", hint: "Glossy jelly" },
  modern: { label: "Modern", hint: "Flat and clean" },
}
export const BUDDY_FINISH_NAMES: readonly BuddyFinishId[] = BUDDY_FINISH_IDS

/** Body colours offered as swatches; any `#RRGGBB` is valid on the look. */
export const BUDDY_COLORS: { label: string; color: string }[] = [
  { label: "Cream", color: "#FFF4EA" },
  { label: "Apricot", color: "#FDBA74" },
  { label: "Tangerine", color: "#FB923C" },
  { label: "Shogo orange", color: "#FB8C00" },
  { label: "Burnt orange", color: "#C2410C" },
  { label: "Coral", color: "#F87171" },
  { label: "Red", color: "#DC2626" },
  { label: "Rose", color: "#E11D48" },
  { label: "Purple", color: "#7C3AED" },
  { label: "Blue", color: "#2563EB" },
  { label: "Sky", color: "#38BDF8" },
  { label: "Teal", color: "#0D9488" },
  { label: "Mint", color: "#34D399" },
  { label: "Lime", color: "#A3E635" },
  { label: "Slate", color: "#64748B" },
  { label: "Graphite", color: "#3F3F46" },
]

export interface BuddyPreset {
  id: string
  label: string
  look: BuddyLook
}

const dressed = (parts: Partial<BuddyLook>): BuddyLook => ({ ...DEFAULT_BUDDY_LOOK, ...parts })

/** Ready-made looks to start customising from. */
export const BUDDY_PRESETS: BuddyPreset[] = [
  { id: "classic", label: "Classic", look: DEFAULT_BUDDY_LOOK },
  { id: "kitty", label: "Kitty", look: dressed({ topper: "ears" }) },
  { id: "fox", label: "Fox", look: dressed({ topper: "fox", tail: "fox" }) },
  { id: "cool", label: "Cool", look: dressed({ eyewear: "sunglasses", blush: false }) },
  { id: "bunny", label: "Bunny", look: dressed({ topper: "bunny", tail: "bunny" }) },
  { id: "dragon", label: "Dragon", look: dressed({ topper: "horns", tail: "dragon", blush: false }) },
  { id: "wizard", label: "Wizard", look: dressed({ topper: "wizard", eyewear: "nerd" }) },
  { id: "dapper", label: "Dapper", look: dressed({ topper: "crown", eyewear: "monocle", neck: "bowtie", blush: false }) },
  { id: "party", label: "Party", look: dressed({ topper: "party", eyewear: "stars", neck: "bowtie" }) },
  { id: "snow-day", label: "Snow day", look: dressed({ topper: "beanie", eyewear: "goggles", neck: "scarf" }) },
  { id: "dj", label: "DJ", look: dressed({ topper: "headphones", eyewear: "sunglasses", blush: false }) },
  { id: "visor-bot", label: "Visor bot", look: dressed({ topper: "stubby", face: "visor", bolts: true, blush: false }) },
  { id: "terminal", label: "Terminal", look: dressed({ topper: "none", face: "screen", blush: false }) },
  { id: "hacker-cat", label: "Hacker cat", look: dressed({ topper: "ears", face: "screen", blush: false }) },
  { id: "robot-pet", label: "Robot pet", look: dressed({ topper: "stubby", face: "screen", tail: "cable", bolts: true, blush: false }) },
]

/** A preset's accessories with this look's colour and finish kept. */
export function withPreset(look: BuddyLook, preset: BuddyPreset): BuddyLook {
  return { ...preset.look, color: look.color, finish: look.finish }
}

/** The preset whose accessories this look wears exactly, if any. */
export function presetForLook(look: BuddyLook): BuddyPreset | undefined {
  return BUDDY_PRESETS.find((preset) => sameLook(withPreset(look, preset), look))
}
