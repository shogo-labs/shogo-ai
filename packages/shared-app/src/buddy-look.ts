// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// The customisable parts of the Shogo buddy, shared by the API (strict
// validation on save), the app (lenient reads) and, via a parity test, the
// desktop island protocol. Every Shogo shares the gummy block body; a look
// only picks the accessories.

export const BUDDY_TOPPER_IDS = ['orb', 'stubby', 'ears', 'none'] as const
export const BUDDY_FACE_IDS = ['classic', 'visor', 'screen'] as const

/** What sits on top of the head. */
export type BuddyTopper = (typeof BUDDY_TOPPER_IDS)[number]
/** How the face is drawn. */
export type BuddyFace = (typeof BUDDY_FACE_IDS)[number]

export interface BuddyLook {
  topper: BuddyTopper
  face: BuddyFace
  /** Ear-pieces on the sides. */
  bolts: boolean
  /** Rosy cheeks; only shows on the classic face. */
  blush: boolean
}

const LOOK_KEYS = ['topper', 'face', 'bolts', 'blush'] as const

export const DEFAULT_BUDDY_LOOK: BuddyLook = { topper: 'orb', face: 'classic', bolts: false, blush: true }

export function isBuddyTopper(value: unknown): value is BuddyTopper {
  return (BUDDY_TOPPER_IDS as readonly unknown[]).includes(value)
}

export function isBuddyFace(value: unknown): value is BuddyFace {
  return (BUDDY_FACE_IDS as readonly unknown[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function sameLook(a: BuddyLook, b: BuddyLook): boolean {
  return a.topper === b.topper && a.face === b.face && a.bolts === b.bolts && a.blush === b.blush
}

/**
 * Strict parse for writes: every field is required and unknown fields are
 * rejected. Clients that add an accessory need a server that knows it first.
 */
export function parseBuddyLook(value: unknown): { ok: true; look: BuddyLook } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'look must be an object' }
  const extra = Object.keys(value).find((key) => !(LOOK_KEYS as readonly string[]).includes(key))
  if (extra) return { ok: false, error: `unknown field "${extra}"` }
  if (!isBuddyTopper(value.topper)) {
    return { ok: false, error: `topper must be one of ${BUDDY_TOPPER_IDS.join(', ')}` }
  }
  if (!isBuddyFace(value.face)) {
    return { ok: false, error: `face must be one of ${BUDDY_FACE_IDS.join(', ')}` }
  }
  if (typeof value.bolts !== 'boolean' || typeof value.blush !== 'boolean') {
    return { ok: false, error: 'bolts and blush must be booleans' }
  }
  return { ok: true, look: { topper: value.topper, face: value.face, bolts: value.bolts, blush: value.blush } }
}

/**
 * Lenient read of a stored or received look. Each field falls back to the
 * default on its own, so a value saved by a newer client (say, a topper this
 * build doesn't know) still keeps the parts this build understands.
 */
export function normalizeBuddyLook(value: unknown): BuddyLook {
  if (!isRecord(value)) return DEFAULT_BUDDY_LOOK
  return {
    topper: isBuddyTopper(value.topper) ? value.topper : DEFAULT_BUDDY_LOOK.topper,
    face: isBuddyFace(value.face) ? value.face : DEFAULT_BUDDY_LOOK.face,
    bolts: typeof value.bolts === 'boolean' ? value.bolts : DEFAULT_BUDDY_LOOK.bolts,
    blush: typeof value.blush === 'boolean' ? value.blush : DEFAULT_BUDDY_LOOK.blush,
  }
}
