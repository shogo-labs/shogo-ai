// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// The customisable parts of the Shogo buddy, shared by the API (strict
// validation on save), the app (lenient reads) and, via a parity test, the
// desktop island protocol. Every Shogo shares the gummy block body; a look
// picks the accessories, the body colour and how it is rendered.

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
export const BUDDY_FINISH_IDS = ['classic', 'modern'] as const

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
/** Glossy cartoon (`classic`) or flatter and cleaner (`modern`). */
export type BuddyFinishId = (typeof BUDDY_FINISH_IDS)[number]

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
  /** Body colour as `#RRGGBB`; null follows the app's accent colour. */
  color: string | null
  finish: BuddyFinishId
}

const LOOK_KEYS = ['topper', 'face', 'tail', 'eyewear', 'neck', 'bolts', 'blush', 'color', 'finish'] as const

export const DEFAULT_BUDDY_LOOK: BuddyLook = {
  topper: 'orb',
  face: 'classic',
  tail: 'none',
  eyewear: 'none',
  neck: 'none',
  bolts: false,
  blush: true,
  color: null,
  finish: 'classic',
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
export const isBuddyFinish = oneOf(BUDDY_FINISH_IDS)

/** `#RRGGBB` in upper case, or null if `value` isn't a six-digit hex colour. */
export function normalizeBuddyColor(value: unknown): string | null {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function sameLook(a: BuddyLook, b: BuddyLook): boolean {
  return LOOK_KEYS.every((key) => a[key] === b[key])
}

/**
 * Strict parse for writes: unknown fields and values are rejected, so clients
 * that add an accessory need a server that knows it first. Fields added after
 * the first release (`tail`, `eyewear`, `neck`, `color`, `finish`) may be
 * omitted by older clients and default to none, the accent colour and classic.
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
  const color = value.color == null ? null : normalizeBuddyColor(value.color)
  if (value.color != null && !color) return { ok: false, error: 'color must be a #RRGGBB hex colour or null' }
  const finish = value.finish ?? 'classic'
  if (!isBuddyFinish(finish)) return { ok: false, error: `finish must be one of ${BUDDY_FINISH_IDS.join(', ')}` }
  return {
    ok: true,
    look: {
      topper: value.topper,
      face: value.face,
      tail,
      eyewear,
      neck,
      bolts: value.bolts,
      blush: value.blush,
      color,
      finish,
    },
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
    color: normalizeBuddyColor(value.color),
    finish: isBuddyFinish(value.finish) ? value.finish : d.finish,
  }
}

/** Body colours a generated look picks from; each reads well on both finishes. */
export const SEEDED_BUDDY_COLORS = [
  '#FB8C00',
  '#FB923C',
  '#F87171',
  '#E11D48',
  '#7C3AED',
  '#2563EB',
  '#38BDF8',
  '#0D9488',
  '#34D399',
  '#A3E635',
  '#64748B',
  '#C2410C',
] as const

/** 32-bit FNV-1a. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** Small deterministic PRNG (mulberry32), so one hash yields many independent picks. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (((t ^ (t >>> 14)) >>> 0) % 1_000_000) / 1_000_000
  }
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]
}

/** Picks `none` with probability `noneWeight`, otherwise one of `items`. */
function pickOrNone<T extends string>(random: () => number, items: readonly T[], noneWeight: number): T | 'none' {
  const roll = random()
  const choice = pick(random, items)
  return roll < noneWeight ? 'none' : choice
}

/**
 * A stable look generated from `seed` (an agent's project id), so agents that
 * nobody has customised still look different from each other. The same seed
 * always gives the same look; tails, eyewear and neckwear are left off most of
 * the time so the result stays clean.
 */
export function seededBuddyLook(seed: string): BuddyLook {
  const random = seededRandom(fnv1a(seed))
  const topper = pick(random, BUDDY_TOPPER_IDS.filter((id) => id !== 'none'))
  const faceRoll = random()
  const face: BuddyFace = faceRoll < 0.6 ? 'classic' : faceRoll < 0.8 ? 'visor' : 'screen'
  const tail = pickOrNone(random, BUDDY_TAIL_IDS.filter((id) => id !== 'none'), 0.6)
  const eyewear = pickOrNone(random, BUDDY_EYEWEAR_IDS.filter((id) => id !== 'none'), 0.55)
  const neck = pickOrNone(random, BUDDY_NECK_IDS.filter((id) => id !== 'none'), 0.6)
  const bolts = random() < 0.3
  const blush = random() < 0.6
  const color = pick(random, SEEDED_BUDDY_COLORS)
  return {
    topper,
    face,
    tail,
    // Eyewear and blush only show on the classic face.
    eyewear: face === 'classic' ? eyewear : 'none',
    neck,
    bolts,
    blush: face === 'classic' ? blush : false,
    color,
    finish: 'classic',
  }
}

/**
 * The look an agent shows: the one saved on it, else a look generated from its
 * project id. The workspace agent (no project) keeps the classic Shogo.
 */
export function resolveAgentLook(stored: unknown, projectId: string | null): BuddyLook {
  if (isRecord(stored)) return normalizeBuddyLook(stored)
  return projectId ? seededBuddyLook(projectId) : DEFAULT_BUDDY_LOOK
}
