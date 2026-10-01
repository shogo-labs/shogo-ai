// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// The customisable parts of the Shogo buddy, shared by the API (strict
// validation on save), the app (lenient reads) and, via a parity test, the
// desktop island protocol. Every Shogo shares the gummy block body; a look
// only picks the accessories.

export const BUDDY_TOPPER_IDS = [
  'orb',
  'stubby',
  'ears',
  'fox',
  'bunny',
  'bear',
  'horns',
  'halo',
  'sprout',
  'crown',
  'party',
  'beanie',
  'wizard',
  'headphones',
  'none',
] as const
export const BUDDY_FACE_IDS = ['classic', 'visor', 'screen'] as const
export const BUDDY_TAIL_IDS = ['none', 'fox', 'cat', 'bunny', 'dragon', 'cable'] as const
export const BUDDY_EYEWEAR_IDS = ['none', 'sunglasses', 'nerd', 'monocle', 'stars', '3d', 'goggles'] as const
export const BUDDY_NECK_IDS = ['none', 'scarf', 'bandana', 'bowtie'] as const

/** What sits on top of the head. */
export type BuddyTopper = (typeof BUDDY_TOPPER_IDS)[number]
/** How the face is drawn. */
export type BuddyFace = (typeof BUDDY_FACE_IDS)[number]
/** What sticks out behind the body. */
export type BuddyTail = (typeof BUDDY_TAIL_IDS)[number]
/** Worn over the eyes; only shows on the classic face. */
export type BuddyEyewear = (typeof BUDDY_EYEWEAR_IDS)[number]
/** Worn round the lower body. */
export type BuddyNeck = (typeof BUDDY_NECK_IDS)[number]

export interface BuddyLook {
  topper: BuddyTopper
  face: BuddyFace
  tail: BuddyTail
  eyewear: BuddyEyewear
  neck: BuddyNeck
  /** Ear-pieces on the sides. */
  bolts: boolean
  /** Rosy cheeks; only shows on the classic face. */
  blush: boolean
}

const LOOK_KEYS = ['topper', 'face', 'tail', 'eyewear', 'neck', 'bolts', 'blush'] as const

export const DEFAULT_BUDDY_LOOK: BuddyLook = {
  topper: 'orb',
  face: 'classic',
  tail: 'none',
  eyewear: 'none',
  neck: 'none',
  bolts: false,
  blush: true,
}

const oneOf =
  <T extends string>(ids: readonly T[]) =>
  (value: unknown): value is T =>
    (ids as readonly unknown[]).includes(value)

export const isBuddyTopper = oneOf(BUDDY_TOPPER_IDS)
export const isBuddyFace = oneOf(BUDDY_FACE_IDS)
export const isBuddyTail = oneOf(BUDDY_TAIL_IDS)
export const isBuddyEyewear = oneOf(BUDDY_EYEWEAR_IDS)
export const isBuddyNeck = oneOf(BUDDY_NECK_IDS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function sameLook(a: BuddyLook, b: BuddyLook): boolean {
  return LOOK_KEYS.every((key) => a[key] === b[key])
}

/**
 * Strict parse for writes: unknown fields and values are rejected, so clients
 * that add an accessory need a server that knows it first. Fields added after
 * the first release (`tail`, `eyewear`, `neck`) may be omitted by older clients and
 * default to none.
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
  const tail = value.tail ?? 'none'
  if (!isBuddyTail(tail)) return { ok: false, error: `tail must be one of ${BUDDY_TAIL_IDS.join(', ')}` }
  const eyewear = value.eyewear ?? 'none'
  if (!isBuddyEyewear(eyewear)) {
    return { ok: false, error: `eyewear must be one of ${BUDDY_EYEWEAR_IDS.join(', ')}` }
  }
  const neck = value.neck ?? 'none'
  if (!isBuddyNeck(neck)) return { ok: false, error: `neck must be one of ${BUDDY_NECK_IDS.join(', ')}` }
  if (typeof value.bolts !== 'boolean' || typeof value.blush !== 'boolean') {
    return { ok: false, error: 'bolts and blush must be booleans' }
  }
  return {
    ok: true,
    look: { topper: value.topper, face: value.face, tail, eyewear, neck, bolts: value.bolts, blush: value.blush },
  }
}

/**
 * Lenient read of a stored or received look. Each field falls back to the
 * default on its own, so a value saved by a newer client (say, a topper this
 * build doesn't know) still keeps the parts this build understands.
 */
export function normalizeBuddyLook(value: unknown): BuddyLook {
  if (!isRecord(value)) return DEFAULT_BUDDY_LOOK
  const d = DEFAULT_BUDDY_LOOK
  return {
    topper: isBuddyTopper(value.topper) ? value.topper : d.topper,
    face: isBuddyFace(value.face) ? value.face : d.face,
    tail: isBuddyTail(value.tail) ? value.tail : d.tail,
    eyewear: isBuddyEyewear(value.eyewear) ? value.eyewear : d.eyewear,
    neck: isBuddyNeck(value.neck) ? value.neck : d.neck,
    bolts: typeof value.bolts === 'boolean' ? value.bolts : d.bolts,
    blush: typeof value.blush === 'boolean' ? value.blush : d.blush,
  }
}
