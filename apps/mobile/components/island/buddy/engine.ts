// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// The Shogo buddy: a jelly blob drawn on a 2D canvas. The keyframe tween
// system and the spherical eye projection follow the approach of coucou's
// BotEngine (MIT, Copyright (c) 2026 Louis Raillé); the character itself is
// Shogo's own.

import { SHOGO_MARK_PATHS, SHOGO_MARK_SIZE } from "../../branding/shogo-mark-paths"
import { Ease, clamp, lerp, type EaseFn } from "../motion/spring"
import {
  DEFAULT_BUDDY_LOOK,
  sameLook,
  type BuddyEyewear,
  type BuddyLook,
  type BuddyNeck,
  type BuddyTail,
  type BuddyTopper,
} from "./look"

export type BuddyState =
  | "idle"
  | "working"
  | "thinking"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "sleeping"
  | "dizzy"

export type BuddyEmote = "love" | "surprised" | "happy" | "annoyed" | "wink" | "proud"

export type RGB = readonly [number, number, number]

type EyeShape =
  | "round"
  | "wide"
  | "happy"
  | "closed"
  | "flat"
  | "line"
  | "spiral"
  | "heart"
  | "star"
  | "dot"
  | "wink"
type MouthShape = "smile" | "grin" | "flat" | "o" | "wavy" | "cat" | "cursor" | "none"
type BadgeKind = "dots" | "bang" | "question"

interface StateConfig {
  color: RGB
  tint: number
  glow: number
  eye: EyeShape
  mouth: MouthShape
  badge: BadgeKind | null
  bounces: boolean
  scans: boolean
  breathes: boolean
  zz: boolean
  jiggle: number
  look: readonly [number, number] | null
  tilt: number
}

type Tweenable =
  | "sx"
  | "sy"
  | "ox"
  | "oy"
  | "tilt"
  | "roll"
  | "open"
  | "es"
  | "blush"
  | "badgeS"
  | "scale"
  | "yaw"
  | "logo"
  | "logoS"
  | "logoDrift"
  | "logoSpin"
  | "logoRing"
  | "logoWave"
  | "logoSheen"

type Keyframe = readonly [target: number, durationMs: number, ease: EaseFn]

interface Tween {
  keys: readonly Keyframe[]
  index: number
  from: number
  startMs: number
  onComplete?: () => void
}

type ParticleKind = "spark" | "heart" | "star" | "z" | "confetti"

interface Particle {
  kind: ParticleKind
  x: number
  y: number
  vx: number
  vy: number
  gravity: number
  age: number
  life: number
  rot: number
  spin: number
  size: number
  color: string
  /** Which logo ray a confetti piece is cut from. */
  ray: number
}

interface Ray {
  path: Path2D
  cx: number
  cy: number
  len: number
  /** Direction the ray points, away from where all rays meet. */
  angle: number
  /** Position around the fan, 0…1 clockwise from straight up. */
  order: number
}

const MARK_HUB = { x: 366.7, y: 194.87 }

const LOGO_PROPS = ["logo", "logoS", "logoDrift", "logoSpin", "logoRing", "logoWave", "logoSheen"] as const

const RAY_SHADE: RGB = [0.3, 0.08, 0.02]

/** Stretches every timing in the logo-to-character unfold. */
const UNFOLD_TIME = 4

/** Long enough for the state colour and glow to finish easing. */
const WAKE_SETTLE_S = 1.5

const bump = (d: number, width: number) => Math.exp(-(d * d) / (width * width))

/** Ways the mark's rays can turn into the character (and back). */
export type LogoStyle = "vortex" | "galaxy" | "tumble" | "flip" | "litFlip" | "mosaic"

interface LogoStyleConfig {
  label: string
  hint: string
  /** How much of the shared `logoSpin` turn to apply. */
  spin: number
  /** Fading copies drawn behind each moving ray. */
  trails: number
  /** Glowing core at the hub while the body forms. */
  core: boolean
  /** Whether the hub slides to the body centre. */
  drift: boolean
  /** Unfold timings in ms before `UNFOLD_TIME`: rays gathering, body popping. */
  gather: number
  pop: number
}

export const LOGO_STYLES: Record<LogoStyle, LogoStyleConfig> = {
  vortex: {
    label: "Vortex",
    hint: "Rays break off and spiral down into the centre",
    spin: 0,
    trails: 0,
    core: true,
    drift: true,
    gather: 340,
    pop: 250,
  },
  galaxy: {
    label: "Galaxy",
    hint: "Twirl: inner rays orbit faster, stretch round the core and leave trails",
    spin: 0,
    trails: 3,
    core: true,
    drift: true,
    gather: 360,
    pop: 270,
  },
  tumble: {
    label: "Tumble",
    hint: "Vortex where every ray flips over and over as it spirals in",
    spin: 0,
    trails: 0,
    core: true,
    drift: true,
    gather: 360,
    pop: 270,
  },
  flip: {
    label: "Card flip",
    hint: "A wave of rays flips edge-on, pale side up, then retracts",
    spin: 0.3,
    trails: 0,
    core: true,
    drift: true,
    gather: 340,
    pop: 250,
  },
  litFlip: {
    label: "Lit flip",
    hint: "Card flip with shading, an edge glint, overshoot and a looser wave",
    spin: 0,
    trails: 0,
    core: true,
    drift: true,
    gather: 360,
    pop: 270,
  },
  mosaic: {
    label: "Mosaic",
    hint: "Each ray's back is a slice of the character; the flip wave assembles it",
    spin: 0,
    trails: 0,
    core: false,
    drift: false,
    gather: 420,
    pop: 330,
  },
}

export const LOGO_STYLE_NAMES = Object.keys(LOGO_STYLES) as LogoStyle[]

interface LogoFrame {
  /** 0 = the full mark, 1 = gathered into the character. */
  g: number
  /** Mark units to px. */
  k: number
  size: number
  /** Body centre. */
  cx: number
  cy: number
  /** Hub, drifting from the mark's hub to the body centre. */
  hx: number
  hy: number
  /** Hub where it sits in the resting mark. */
  hx0: number
  hy0: number
}

/** Where to draw one ray: its centroid, extra spin about the centroid, and
 * scale along and across its own axis. */
interface RayPose {
  x: number
  y: number
  rot: number
  along: number
  across: number
  alpha: number
  /** Blend toward white. */
  heat: number
  /** Blend toward dark, for a face turned away from the light. */
  shade: number
  /** Show the character's slice instead of a flat colour (a ray's back). */
  image: boolean
  /** Widens the slice's window without stretching the picture, so
   * neighbouring slices meet and the character reads whole. */
  widen: number
}

const stagger = (g: number, spread: number, slot: number) => clamp(g * (1 + spread) - slot * spread, 0, 1)

const hash = (i: number) => {
  const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453
  return s - Math.floor(s)
}

const wrapPi = (a: number) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2))

function rayPose(style: LogoStyle, ray: Ray, i: number, f: LogoFrame): RayPose {
  const dx = (ray.cx - MARK_HUB.x) * f.k
  const dy = (ray.cy - MARK_HUB.y) * f.k
  const pose: RayPose = {
    x: f.hx + dx,
    y: f.hy + dy,
    rot: 0,
    along: 1,
    across: 1,
    alpha: 1,
    heat: 0,
    shade: 0,
    image: false,
    widen: 1,
  }

  switch (style) {
    case "vortex": {
      const u = stagger(f.g, 0.45, ray.order)
      const rx = f.hx0 + dx - f.cx
      const ry = f.hy0 + dy - f.cy
      const r0 = Math.hypot(rx, ry)
      const t0 = Math.atan2(ry, rx)
      const e = Ease.in(u)
      const theta = t0 + 3 * Ease.inOut(u)
      const r = r0 * (1 - e)
      pose.x = f.cx + Math.cos(theta) * r
      pose.y = f.cy + Math.sin(theta) * r
      pose.rot = theta - t0
      pose.along = 1 - 0.7 * e
      pose.across = 1 - 0.4 * e
      pose.heat = e * 0.85
      break
    }
    case "flip": {
      const u = stagger(f.g, 0.7, ray.order)
      const p1 = Ease.inOut(clamp(u / 0.55, 0, 1))
      const p2 = Ease.in(clamp((u - 0.55) / 0.45, 0, 1))
      const phi = Math.PI * p1
      const len = 1 - p2
      pose.x = f.hx + dx * len
      pose.y = f.hy + dy * len
      pose.along = len
      pose.across = Math.max(0.06, Math.abs(Math.cos(phi)))
      pose.heat = phi > Math.PI / 2 ? 0.8 : p1 * 0.2
      break
    }
    case "galaxy": {
      spiralIn(pose, ray, f, dx, dy, stagger(f.g, 0.35, ray.order))
      break
    }
    case "tumble": {
      const u = stagger(f.g, 0.45, ray.order)
      spiralIn(pose, ray, f, dx, dy, u)
      const c = Math.cos(Math.PI * 2.5 * u)
      pose.across *= Math.max(0.06, Math.abs(c))
      if (c < 0) pose.heat = Math.max(pose.heat, 0.75)
      pose.shade = (1 - Math.abs(c)) * 0.4
      break
    }
    case "litFlip": {
      const u = stagger(f.g, 0.7, ray.order * 0.85 + hash(i) * 0.15)
      // Ease.back carries each ray past flat, then it settles back.
      const phi = Math.PI * Ease.back(clamp(u / 0.6, 0, 1))
      const len = 1 - Ease.in(clamp((u - 0.6) / 0.4, 0, 1))
      const c = Math.cos(phi)
      const glint = bump(c, 0.18)
      pose.x = f.hx + dx * len
      pose.y = f.hy + dy * len
      pose.along = len
      pose.across = Math.max(0.05, Math.abs(c))
      pose.heat = (c < 0 ? 0.8 : 0) + glint * 0.7
      pose.shade = (1 - Math.abs(c)) * 0.55 * (1 - glint)
      break
    }
    case "mosaic": {
      const u = stagger(f.g, 0.7, ray.order * 0.85 + hash(i) * 0.15)
      const c = Math.cos(Math.PI * Ease.inOut(clamp(u / 0.75, 0, 1)))
      const glint = bump(c, 0.18)
      pose.across = Math.max(0.05, Math.abs(c))
      pose.image = c < 0
      pose.widen = 1 + 1.6 * clamp(-c, 0, 1)
      pose.heat = glint * 0.6
      pose.shade = (1 - Math.abs(c)) * 0.5 * (1 - glint)
      break
    }
  }
  return pose
}

/** Orbit a ray down into the body centre. The closer it gets, the faster it
 * goes round (a twirl), the more it lines up with its orbit, and the more it
 * stretches along it before it is swallowed. */
function spiralIn(pose: RayPose, ray: Ray, f: LogoFrame, dx: number, dy: number, u: number) {
  const rx = f.hx0 + dx - f.cx
  const ry = f.hy0 + dy - f.cy
  const r0 = Math.hypot(rx, ry)
  const t0 = Math.atan2(ry, rx)
  const e = Ease.in(u)
  const theta = t0 + 1.4 * u + 3.6 * e * e
  const r = r0 * (1 - e)
  pose.x = f.cx + Math.cos(theta) * r
  pose.y = f.cy + Math.sin(theta) * r
  // Turn needed to lie along the orbit; a ray reads the same either way round.
  let toTangent = wrapPi(Math.PI / 2 + t0 - ray.angle)
  if (Math.abs(toTangent) > Math.PI / 2) toTangent -= Math.sign(toTangent) * Math.PI
  pose.rot = theta - t0 + toTangent * e
  pose.along = (1 + 1.6 * e * (1 - e)) * (1 - 0.85 * e * e)
  pose.across = 1 - 0.7 * e
  pose.heat = e * 0.9
}

let rayCache: Ray[] | null = null

/** The logo's rays, with each one's centroid and length in mark units. */
function logoRays(): Ray[] {
  if (rayCache) return rayCache
  rayCache = SHOGO_MARK_PATHS.map((d) => {
    const nums = (d.match(/-?\d*\.?\d+/g) ?? []).map(Number)
    let sx = 0
    let sy = 0
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const n = Math.floor(nums.length / 2)
    for (let i = 0; i < n; i++) {
      const px = nums[i * 2]
      const py = nums[i * 2 + 1]
      sx += px
      sy += py
      minX = Math.min(minX, px)
      minY = Math.min(minY, py)
      maxX = Math.max(maxX, px)
      maxY = Math.max(maxY, py)
    }
    const cx = sx / n
    const cy = sy / n
    const angle = Math.atan2(cy - MARK_HUB.y, cx - MARK_HUB.x)
    const turn = (angle + Math.PI / 2) / (Math.PI * 2)
    return {
      path: new Path2D(d),
      cx,
      cy,
      len: Math.hypot(maxX - minX, maxY - minY),
      angle,
      order: turn - Math.floor(turn),
    }
  })
  return rayCache
}

const rgb = (hex: string): RGB => {
  const v = parseInt(hex.replace("#", ""), 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

/** One warm palette: whites through apricot and orange to red. */
export const BUDDY_PALETTE = {
  cream: "#FFF4EA",
  apricot: "#FDBA74",
  tangerine: "#FB923C",
  orange: "#F97316",
  burnt: "#C2410C",
  coral: "#F87171",
  red: "#DC2626",
  ember: "#9A3412",
  dusk: "#B4836B",
} as const

const COLORS = {
  idle: rgb(BUDDY_PALETTE.cream),
  working: rgb(BUDDY_PALETTE.burnt),
  thinking: rgb(BUDDY_PALETTE.apricot),
  approval: rgb(BUDDY_PALETTE.orange),
  question: rgb(BUDDY_PALETTE.coral),
  error: rgb(BUDDY_PALETTE.red),
  finished: rgb("#FFFFFF"),
  sleeping: rgb(BUDDY_PALETTE.dusk),
  dizzy: rgb(BUDDY_PALETTE.tangerine),
}

const BASE: Omit<StateConfig, "color" | "tint" | "glow" | "eye" | "mouth" | "badge"> = {
  bounces: false,
  scans: false,
  breathes: false,
  zz: false,
  jiggle: 0.004,
  look: null,
  tilt: 0,
}

export const BUDDY_STATES: Record<BuddyState, StateConfig> = {
  idle: { ...BASE, color: COLORS.idle, tint: 0, glow: 0.18, eye: "round", mouth: "smile", badge: null },
  working: {
    ...BASE,
    color: COLORS.working,
    tint: 0.55,
    glow: 0.6,
    eye: "round",
    mouth: "flat",
    badge: "dots",
    jiggle: 0.012,
  },
  thinking: {
    ...BASE,
    color: COLORS.thinking,
    tint: 0.55,
    glow: 0.55,
    eye: "round",
    mouth: "o",
    badge: "dots",
    look: [0.6, 0.55],
  },
  approval: {
    ...BASE,
    color: COLORS.approval,
    tint: 0.6,
    glow: 0.65,
    eye: "wide",
    mouth: "o",
    badge: "bang",
    bounces: true,
  },
  question: {
    ...BASE,
    color: COLORS.question,
    tint: 0.55,
    glow: 0.6,
    eye: "round",
    mouth: "flat",
    badge: "question",
    tilt: 0.18,
  },
  error: { ...BASE, color: COLORS.error, tint: 0.65, glow: 0.65, eye: "flat", mouth: "wavy", badge: null },
  finished: { ...BASE, color: COLORS.finished, tint: 0.35, glow: 0.6, eye: "happy", mouth: "grin", badge: null },
  sleeping: {
    ...BASE,
    color: COLORS.sleeping,
    tint: 0.25,
    glow: 0.12,
    eye: "closed",
    mouth: "none",
    badge: null,
    breathes: true,
    zz: true,
    jiggle: 0.002,
  },
  dizzy: { ...BASE, color: COLORS.dizzy, tint: 0.55, glow: 0.5, eye: "spiral", mouth: "wavy", badge: null, jiggle: 0.03 },
}

export const BUDDY_STATE_NAMES = Object.keys(BUDDY_STATES) as BuddyState[]
export const BUDDY_EMOTE_NAMES: BuddyEmote[] = ["love", "surprised", "happy", "annoyed", "wink", "proud"]

const EMOTE_EYE: Record<BuddyEmote, EyeShape> = {
  love: "heart",
  surprised: "dot",
  happy: "happy",
  annoyed: "line",
  wink: "wink",
  proud: "star",
}

const EMOTE_MOUTH: Partial<Record<BuddyEmote, MouthShape>> = {
  love: "grin",
  surprised: "o",
  happy: "grin",
  annoyed: "flat",
  proud: "grin",
}

const INK = "rgb(24,16,14)"
const CONFETTI = [
  BUDDY_PALETTE.orange,
  BUDDY_PALETTE.red,
  "#FFFFFF",
  BUDDY_PALETTE.apricot,
  BUDDY_PALETTE.burnt,
  BUDDY_PALETTE.cream,
]
const HEART = "#EF4444"
const STAR = BUDDY_PALETTE.apricot
/** Fur highlights: tail tip, ear insides, cheek ruff. */
const CREAM: RGB = [1, 0.97, 0.93]
/** Where an eye sits on the face, foreshortened by how far it has turned. */
interface Lens {
  x: number
  y: number
  sx: number
  sy: number
  sd: number
}

const FONT = `system-ui, -apple-system, "Segoe UI", sans-serif`

/** Canvas height ÷ width: room above the body for the antenna and particles. */
export const BUDDY_ASPECT = 1.4

export interface DesignConfig {
  /** Superellipse exponent: 2 is an ellipse, higher is boxier. */
  exp: number
  rx: number
  ry: number
  /** How much narrower the top is than the base. */
  taper: number
  /** Squashes the lower half; 1 keeps it symmetric. */
  base: number
  /** Scales the jelly wobble; boxy bodies read better a little stiffer. */
  jelly: number
  antenna: "orb" | "short" | null
  ears: "cat" | "fox" | "bunny" | "bear" | null
  /** Hats and other things worn on (or above) the head. */
  headgear: Headgear | null
  tail: Exclude<BuddyTail, "none"> | null
  /** Worn over the eyes; classic face only. */
  eyewear: Exclude<BuddyEyewear, "none"> | null
  neck: Exclude<BuddyNeck, "none"> | null
  /** White fur tufts on the lower cheeks. */
  ruff: boolean
  /** Face drawn on a dark inset screen with glowing eyes. */
  screen: boolean
  /** Face behind a dark glass band. */
  visor: boolean
  /** Ear-pieces on the sides. */
  bolts: boolean
  mouth: boolean
  blush: boolean
  /** Eye height as a pitch angle; positive is higher. */
  eyeY: number
  mouthY: number
}

/** Every Shogo is the gummy block; people dress it up with accessories. */
const GUMMY_BLOCK: DesignConfig = {
  exp: 4.2,
  rx: 1.08,
  ry: 0.9,
  taper: 0,
  base: 1,
  jelly: 0.55,
  antenna: null,
  ears: null,
  headgear: null,
  tail: null,
  eyewear: null,
  neck: null,
  ruff: false,
  screen: false,
  visor: false,
  bolts: false,
  mouth: true,
  blush: true,
  eyeY: -0.08,
  mouthY: 0.34,
}

type Headgear = "horns" | "halo" | "sprout" | "crown" | "party" | "beanie" | "wizard" | "headphones"

const TOPPER_EARS: Partial<Record<BuddyTopper, DesignConfig["ears"]>> = {
  ears: "cat",
  fox: "fox",
  bunny: "bunny",
  bear: "bear",
}

const HEADGEAR: Partial<Record<BuddyTopper, Headgear>> = {
  horns: "horns",
  halo: "halo",
  sprout: "sprout",
  crown: "crown",
  party: "party",
  beanie: "beanie",
  wizard: "wizard",
  headphones: "headphones",
}

/** Eyewear that hides the eyes; emote eyes are drawn on the lenses instead. */
const OPAQUE_EYEWEAR = new Set<BuddyEyewear>(["sunglasses", "stars", "goggles"])

export function designFor(look: BuddyLook): DesignConfig {
  const d: DesignConfig = { ...GUMMY_BLOCK }
  d.antenna = look.topper === "orb" ? "orb" : look.topper === "stubby" ? "short" : null
  d.ears = TOPPER_EARS[look.topper] ?? null
  d.headgear = HEADGEAR[look.topper] ?? null
  d.tail = look.tail === "none" ? null : look.tail
  d.neck = look.neck === "none" ? null : look.neck
  d.bolts = look.bolts
  d.blush = look.blush && look.face === "classic"
  d.eyewear = look.eyewear !== "none" && look.face === "classic" ? look.eyewear : null
  d.ruff = look.topper === "fox" && look.face === "classic"
  if (look.face === "visor") {
    d.visor = true
    d.mouth = false
    d.eyeY = 0.16
  } else if (look.face === "screen") {
    d.screen = true
    d.eyeY = 0.2
    d.mouthY = 0.16
  }
  return d
}

/** Jelly harmonics: mode number, natural period and damping. Low damping is
 * what makes a poke jiggle for a while instead of snapping back. */
const JELLY_MODES = [
  { k: 2, response: 0.42, damping: 0.16 },
  { k: 3, response: 0.3, damping: 0.18 },
  { k: 4, response: 0.22, damping: 0.2 },
] as const

const nowS = () => performance.now() / 1000

const rgba = (c: RGB, a = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`

const luminance = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

/** Glyph colour that stays readable on a state-coloured fill. */
const onColor = (c: RGB) => (luminance(c) > 0.6 ? "#7C2D12" : "#fff")

const mix = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]

export function parseColor(input: string): RGB {
  const trimmed = input.trim()
  if (trimmed.startsWith("#")) return rgb(trimmed)
  const parts = trimmed.match(/[\d.]+/g)?.map(Number) ?? [255, 122, 61]
  return [parts[0] / 255, parts[1] / 255, parts[2] / 255]
}

function roundRect(x: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, R: number) {
  const r = Math.max(0, Math.min(R, W / 2, H / 2))
  x.beginPath()
  x.moveTo(X + r, Y)
  x.arcTo(X + W, Y, X + W, Y + H, r)
  x.arcTo(X + W, Y + H, X, Y + H, r)
  x.arcTo(X, Y + H, X, Y, r)
  x.arcTo(X, Y, X + W, Y, r)
  x.closePath()
}

type Pt = readonly [number, number]

/** Point, unit tangent and unit normal on a quadratic curve. */
function quadAt(p0: Pt, p1: Pt, p2: Pt, t: number) {
  const u = 1 - t
  const tx = 2 * u * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0])
  const ty = 2 * u * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1])
  const len = Math.hypot(tx, ty) || 1
  return {
    x: u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    y: u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    tx: tx / len,
    ty: ty / len,
    nx: -ty / len,
    ny: tx / len,
  }
}

/** A strip `width(t)` wide along a quadratic curve, with a rounded end. */
function ribbon(p0: Pt, p1: Pt, p2: Pt, width: (t: number) => number, n = 20): Path2D {
  const side: Pt[] = []
  const path = new Path2D()
  for (let i = 0; i <= n; i++) {
    const p = quadAt(p0, p1, p2, i / n)
    const w = width(i / n) / 2
    if (i === 0) path.moveTo(p.x + p.nx * w, p.y + p.ny * w)
    else path.lineTo(p.x + p.nx * w, p.y + p.ny * w)
    side.push([p.x - p.nx * w, p.y - p.ny * w])
  }
  const end = quadAt(p0, p1, p2, 1)
  const a = Math.atan2(end.ny, end.nx)
  path.arc(end.x, end.y, width(1) / 2, a, a - Math.PI, true)
  for (let i = n; i >= 0; i--) path.lineTo(side[i][0], side[i][1])
  path.closePath()
  return path
}

function heart(x: CanvasRenderingContext2D, s: number) {
  x.beginPath()
  x.moveTo(0, s * 0.38)
  x.bezierCurveTo(-s * 1.05, -s * 0.15, -s * 0.5, -s * 0.95, 0, -s * 0.38)
  x.bezierCurveTo(s * 0.5, -s * 0.95, s * 1.05, -s * 0.15, 0, s * 0.38)
  x.closePath()
}

function star(x: CanvasRenderingContext2D, ro: number, ri: number) {
  x.beginPath()
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? ri : ro
    const a = -Math.PI / 2 + (i * Math.PI) / 5
    x.lineTo(Math.cos(a) * r, Math.sin(a) * r)
  }
  x.closePath()
}

export class BuddyEngine {
  isMini = false
  /** Swap between the mark and the character instantly and skip decorative
   * effects (sheen, peek ripple, particles). */
  reducedMotion = false
  private lookValue: BuddyLook = DEFAULT_BUDDY_LOOK
  private d: DesignConfig = designFor(DEFAULT_BUDDY_LOOK)
  body: RGB = parseColor("#FF7A3D")
  state: BuddyState = "idle"
  /** Pointer direction in -1…1, relative to the buddy. */
  lookX = 0
  lookY = 0
  onDizzy: (() => void) | null = null
  /** Called when something starts moving, so a sleeping render loop resumes. */
  onWake: (() => void) | null = null
  /** Colour and glow keep easing for a moment after a change. */
  private awakeUntil = 0

  // Animated values
  sx = 1
  sy = 1
  ox = 0
  oy = 0
  tilt = 0
  roll = 0
  open = 1
  es = 1
  blush = 0
  badgeS = 0
  scale = 1
  yaw = 0
  /** How far the Shogo mark's rays reach out of the hub: 1 is the full mark,
   * 0 is fully gathered in (the character's form). */
  logo = 0
  /** Overall size of the mark. */
  logoS = 1
  /** 1 puts the hub where it sits in the mark; 0 moves it to the body centre. */
  logoDrift = 1
  /** Rotation of the whole fan around the hub, in radians. */
  logoSpin = 0
  /** Progress of the ring of rays released when the character pops out. */
  logoRing = 0
  /** Progress of a length ripple around the fan (hover). */
  logoWave = 0
  /** Progress of a highlight sweeping around the fan. */
  logoSheen = 0
  /** How the rays move between the mark and the character. */
  logoStyle: LogoStyle = "vortex"
  /** +1 while unfolding, -1 while folding, so trails fall behind. */
  private logoDir = 1
  /** The character drawn flat, for styles that show it on the rays. */
  private sprite: HTMLCanvasElement | null = null
  /** While a fold or unfold runs, a glowing core bridges the mark and body. */
  private logoCoreUntil = 0
  private nextSheen = nowS() + 3
  pitch = 0
  tint = 0
  glow = 0.18
  antennaBend = 0
  private antennaVel = 0
  /** 0 at rest, toward 1 while hopping; scarves flap with it. */
  private flutter = 0
  private prevOy = 0
  private prevOx = 0
  private prevTilt = 0

  private cfg: StateConfig = BUDDY_STATES.idle
  private col: RGB = COLORS.idle
  private badge: BadgeKind | null = null
  private badgeTarget: BadgeKind | null = null
  private eyeOverride: EyeShape | null = null
  private mouthOverride: MouthShape | null = null
  private overrideUntil = 0
  private tweens = new Map<Tweenable, Tween>()
  private particles: Particle[] = []
  private jelly = JELLY_MODES.map((m) => ({ ...m, amp: 0, vel: 0, phase: Math.random() * Math.PI * 2 }))
  private t0 = nowS() - Math.random() * 5
  private nextBlink = nowS() + 1.2 + Math.random() * 2
  private nextFidget = nowS() + 4 + Math.random() * 4
  private lastAmbient = 0
  private pokes: number[] = []
  private dizzyUntil = 0
  private stateBeforeDizzy: BuddyState = "idle"
  private hoverSince: number | null = null
  private lastLove = 0
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private logoTimers = new Set<ReturnType<typeof setTimeout>>()

  // ── Public API ──

  get look(): BuddyLook {
    return this.lookValue
  }

  set look(next: BuddyLook) {
    if (sameLook(this.lookValue, next)) return
    this.lookValue = next
    this.d = designFor(next)
    this.wake()
  }

  setBodyColor(color: string) {
    this.body = parseColor(color)
    this.wake()
  }

  /** Nothing will change on screen until the next `onWake` or `msUntilWake`.
   * Only the resting mark and a reduced-motion character ever get here; the
   * full character always breathes and blinks. */
  get resting(): boolean {
    const n = nowS()
    if (n < this.awakeUntil || n < this.logoCoreUntil) return false
    if (this.tweens.size || this.particles.length || this.timers.size) return false
    return this.reducedMotion || (this.logo >= 0.999 && this.scale <= 0.001)
  }

  /** While resting, how long until the mark's next sheen. */
  msUntilWake(): number | null {
    if (this.reducedMotion || this.logo < 0.999) return null
    return Math.max(0, (this.nextSheen - nowS()) * 1000)
  }

  wake() {
    this.awakeUntil = nowS() + WAKE_SETTLE_S
    this.onWake?.()
  }

  setState(next: BuddyState, force = false) {
    if (this.dizzyUntil > nowS() && next !== "dizzy") {
      this.stateBeforeDizzy = next
      return
    }
    if (this.state === next && !force) return
    const prev = this.state
    this.state = next
    this.wake()
    this.cfg = BUDDY_STATES[next]
    this.setBadge(this.cfg.badge)

    switch (next) {
      case "finished":
        this.hop(0.32)
        this.anim("roll", [[Math.PI * 2, 900, Ease.inOut]], () => (this.roll = 0))
        this.later(380, () => {
          this.emit("confetti", 16)
          this.emit("spark", 4)
        })
        break
      case "error":
        this.anim("ox", [
          [0.1, 50, Ease.out],
          [-0.1, 70, Ease.inOut],
          [0.07, 70, Ease.inOut],
          [-0.04, 70, Ease.inOut],
          [0, 90, Ease.out],
        ])
        this.jiggle(0.08)
        break
      case "approval":
        this.hop(0.22)
        break
      case "question":
        this.blink()
        this.jiggle(0.04)
        break
      case "dizzy":
        this.anim("roll", [[Math.PI * 4, 1300, Ease.inOut]], () => (this.roll = 0))
        this.jiggle(0.12)
        break
      case "sleeping":
        break
      default:
        if (prev !== next) this.blink()
        this.jiggle(0.03)
    }
  }

  blink() {
    if (this.tweens.has("open")) return
    this.anim("open", [
      [0.05, 70, Ease.inOut],
      [1, 130, Ease.out],
    ])
  }

  /** Squash and stretch anchored at the feet, plus a jelly jiggle. */
  squash(strength = 1) {
    this.anim("sy", [
      [1 - 0.22 * strength, 70, Ease.out],
      [1 + 0.12 * strength, 130, Ease.out],
      [1, 200, Ease.back],
    ])
    this.anim("sx", [
      [1 + 0.18 * strength, 70, Ease.out],
      [1 - 0.06 * strength, 130, Ease.out],
      [1, 200, Ease.back],
    ])
    this.jiggle(0.06 * strength)
  }

  hop(height = 0.25) {
    this.anim("sy", [
      [0.84, 80, Ease.out],
      [1.14, 120, Ease.out],
      [1, 260, Ease.inOut],
      [0.9, 70, Ease.out],
      [1, 180, Ease.back],
    ])
    this.anim("sx", [
      [1.14, 80, Ease.out],
      [0.92, 120, Ease.out],
      [1, 260, Ease.inOut],
      [1.08, 70, Ease.out],
      [1, 180, Ease.back],
    ])
    this.anim("oy", [
      [0, 80, Ease.lin],
      [-height, 190, Ease.out],
      [0, 190, Ease.in],
    ])
    this.later(460, () => this.jiggle(0.05))
  }

  /** Kicks the jelly harmonics; they ring down on their own. */
  jiggle(strength: number) {
    for (const mode of this.jelly) mode.vel += strength * (8 + Math.random() * 6) * (Math.random() < 0.5 ? -1 : 1)
  }

  /** Pop into existence: grow from nothing with overshoot, then say hi. */
  appear() {
    this.scale = 0
    this.anim("scale", [
      [1.18, 260, Ease.out],
      [0.94, 140, Ease.inOut],
      [1, 220, Ease.back],
    ])
    this.later(120, () => this.jiggle(0.1))
    this.later(300, () => this.emit("spark", 5))
    this.later(420, () => this.emote("happy", 1.2))
  }

  /** Rest as the Shogo mark (or as the character) with no animation. */
  showLogo(on: boolean) {
    this.cancelLogoTimers()
    for (const prop of LOGO_PROPS) this.tweens.delete(prop)
    this.tweens.delete("scale")
    this.logo = on ? 1 : 0
    this.logoS = 1
    this.logoDrift = on ? 1 : 0
    this.logoSpin = 0
    this.logoRing = 0
    this.logoWave = 0
    this.logoSheen = 0
    this.scale = on ? 0 : 1
    this.wake()
  }

  /** The mark's rays gather (how depends on `logoStyle`) and the character
   * pops out, eyes shut, with a ring of rays bursting off it. Then it opens
   * its eyes and smiles. */
  fromLogo() {
    if (this.reducedMotion) return this.showLogo(false)
    const ms = (t: number) => t * UNFOLD_TIME
    const style = LOGO_STYLES[this.logoStyle]
    const pop = style.pop
    this.cancelLogoTimers()
    this.logoDir = 1
    this.logoCoreUntil = nowS() + ms(1000) / 1000
    this.logo = Math.max(this.logo, 0.999)
    this.scale = Math.min(this.scale, 0)
    this.anim("logoS", [
      [0.9, ms(90), Ease.out],
      [1, ms(300), Ease.inOut],
    ])
    // Turns like a wheel, picking up speed as the rays drain into the hub.
    this.anim("logoSpin", [
      [0.45, ms(220), Ease.lin],
      [1.5, ms(200), Ease.lin],
      [0, 0, Ease.lin],
    ])
    this.anim("logo", [[0, ms(style.gather), Ease.lin]])
    this.anim("logoDrift", [[0, ms(380), Ease.inOut]])
    this.anim("logoRing", [
      [0, ms(pop + 20), Ease.lin],
      [1, ms(460), Ease.lin],
      [0, 0, Ease.lin],
    ])
    // A mosaic already looks like the character, so it only firms up.
    this.anim(
      "scale",
      style.core
        ? [
            [0, ms(pop), Ease.lin],
            [1.24, ms(190), Ease.out],
            [0.92, ms(140), Ease.inOut],
            [1, ms(230), Ease.back],
          ]
        : [
            [0, ms(pop), Ease.lin],
            [1.06, ms(90), Ease.out],
            [1, ms(160), Ease.back],
          ],
    )
    this.anim("open", [
      [0.05, 0, Ease.lin],
      [0.05, ms(pop + 260), Ease.lin],
      [1, ms(150), Ease.out],
    ])
    this.logoLater(ms(pop + 60), () => this.jiggle(0.14))
    this.logoLater(ms(pop + 130), () => this.emit("spark", 4))
    this.logoLater(ms(pop + 480), () => this.emote("happy", 1))
  }

  /** The character shuts its eyes, squashes and shrinks away, and the rays
   * play their gather in reverse back into the mark. */
  toLogo() {
    if (this.reducedMotion) return this.showLogo(true)
    this.cancelLogoTimers()
    this.logoDir = -1
    this.logoCoreUntil = nowS() + 1
    if (this.logo < 0.001) this.logoDrift = 0
    // Fully gathered rays (a finished mosaic) show behind the shrinking body.
    this.logo = Math.max(this.logo, 0.002)
    this.anim("open", [
      [0.05, 90, Ease.inOut],
      [0.05, 600, Ease.lin],
      [1, 0, Ease.lin],
    ])
    this.anim("sy", [
      [0.8, 110, Ease.out],
      [0.8, 200, Ease.lin],
      [1, 0, Ease.lin],
    ])
    this.anim("sx", [
      [1.16, 110, Ease.out],
      [1.16, 200, Ease.lin],
      [1, 0, Ease.lin],
    ])
    this.anim("scale", [
      [this.scale, 110, Ease.lin],
      [0, 190, Ease.in],
    ])
    this.anim("logo", [
      [this.logo, 200, Ease.lin],
      [1, 440, Ease.lin],
    ])
    this.anim("logoDrift", [
      [this.logoDrift, 200, Ease.lin],
      [1, 380, Ease.inOut],
    ])
    this.anim("logoSpin", [
      [-0.9, 0, Ease.lin],
      [-0.9, 200, Ease.lin],
      [0, 520, Ease.out],
    ])
    this.anim("logoSheen", [
      [0, 640, Ease.lin],
      [1, 620, Ease.inOut],
      [0, 0, Ease.lin],
    ])
    this.nextSheen = nowS() + 6
  }

  /** The resting mark notices the pointer: a ripple runs round the fan and it
   * gives a little turn. */
  logoPeek() {
    if (this.reducedMotion || this.logo < 0.999 || this.tweens.has("logo")) return
    this.anim("logoWave", [
      [1, 560, Ease.lin],
      [0, 0, Ease.lin],
    ])
    this.anim("logoSpin", [
      [0.16, 140, Ease.out],
      [-0.06, 180, Ease.inOut],
      [0, 260, Ease.back],
    ])
  }

  /** A click. Three inside 1.7 s makes it dizzy for 3.3 s. */
  poke() {
    const t = nowS()
    this.pokes = this.pokes.filter((p) => t - p < 1.7)
    this.pokes.push(t)
    this.squash(1.2)
    if (this.state === "dizzy") return
    if (this.pokes.length >= 3) {
      this.pokes = []
      this.stateBeforeDizzy = this.state
      this.setState("dizzy")
      this.dizzyUntil = t + 3.3
      this.onDizzy?.()
      this.later(3300, () => {
        this.dizzyUntil = 0
        this.setState(this.stateBeforeDizzy, true)
        this.emote("happy", 1)
      })
    } else {
      this.emote("annoyed", 0.8)
    }
  }

  hover(on: boolean) {
    if (on && this.hoverSince == null) {
      this.hoverSince = nowS()
      this.blink()
      this.anim("es", [[1.12, 160, Ease.out]])
      this.jiggle(0.025)
    } else if (!on && this.hoverSince != null) {
      this.hoverSince = null
      this.anim("es", [[1, 200, Ease.inOut]])
    }
  }

  emote(emote: BuddyEmote, duration = 1.8) {
    const t = nowS()
    this.eyeOverride = EMOTE_EYE[emote]
    this.mouthOverride = EMOTE_MOUTH[emote] ?? null
    this.overrideUntil = t + duration
    const hold = Math.max(0, duration * 1000 - 600)
    switch (emote) {
      case "love":
        this.anim("blush", [
          [1, 300, Ease.out],
          [1, hold, Ease.lin],
          [0, 300, Ease.inOut],
        ])
        this.emit("heart", 5)
        this.anim("oy", [
          [-0.1, 160, Ease.out],
          [0, 300, Ease.back],
        ])
        this.jiggle(0.04)
        break
      case "surprised":
        this.anim("oy", [
          [-0.3, 140, Ease.out],
          [0, 380, Ease.back],
        ])
        this.anim("es", [
          [1.3, 120, Ease.out],
          [1, 500, Ease.inOut],
        ])
        this.jiggle(0.07)
        break
      case "happy":
        this.anim("blush", [
          [0.7, 200, Ease.out],
          [0, 700, Ease.inOut],
        ])
        this.squash(0.6)
        break
      case "annoyed":
        this.anim("tilt", [
          [-0.1, 90, Ease.out],
          [0, 300, Ease.back],
        ])
        break
      case "wink":
        this.anim("tilt", [
          [0.14, 160, Ease.out],
          [0.14, hold, Ease.lin],
          [0, 240, Ease.inOut],
        ])
        break
      case "proud":
        this.emit("star", 5)
        this.anim("tilt", [
          [-0.14, 220, Ease.out],
          [-0.14, hold, Ease.lin],
          [0, 280, Ease.inOut],
        ])
        this.anim("blush", [
          [0.7, 250, Ease.out],
          [0.7, hold, Ease.lin],
          [0, 300, Ease.inOut],
        ])
        break
    }
  }

  dispose() {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  // ── Internals ──

  private later(ms: number, fn: () => void) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      this.logoTimers.delete(timer)
      fn()
    }, ms)
    this.timers.add(timer)
    return timer
  }

  /** A fold or unfold interrupting another cancels the other's follow-ups. */
  private logoLater(ms: number, fn: () => void) {
    this.logoTimers.add(this.later(ms, fn))
  }

  private cancelLogoTimers() {
    for (const timer of this.logoTimers) {
      clearTimeout(timer)
      this.timers.delete(timer)
    }
    this.logoTimers.clear()
  }

  private setBadge(next: BadgeKind | null) {
    if (next === this.badgeTarget) return
    this.badgeTarget = next
    this.anim("badgeS", [[0, 90, Ease.inOut]], () => {
      this.badge = next
      if (next) this.anim("badgeS", [[1, 320, Ease.back]])
    })
  }

  private anim(prop: Tweenable, keys: readonly Keyframe[], onComplete?: () => void) {
    this.tweens.set(prop, { keys, index: 0, from: this[prop], startMs: performance.now(), onComplete })
    this.wake()
  }

  private emit(kind: ParticleKind, count: number) {
    // Reduced motion steps with dt = 0, so particles would never age out.
    if (this.reducedMotion) return
    this.wake()
    for (let i = 0; i < count; i++) {
      if (kind === "confetti") {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2
        const speed = 2 + Math.random() * 1.6
        this.particles.push({
          kind,
          x: 0,
          y: -0.8,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          gravity: 4.2,
          age: 0,
          life: 1.2 + Math.random() * 0.5,
          rot: a + Math.PI / 2 + (Math.random() - 0.5) * 0.8,
          spin: (Math.random() - 0.5) * 7,
          size: 0.4 + Math.random() * 0.3,
          color: CONFETTI[i % CONFETTI.length],
          ray: Math.floor(Math.random() * SHOGO_MARK_PATHS.length),
        })
        continue
      }
      const isZ = kind === "z"
      this.particles.push({
        kind,
        x: (Math.random() - 0.5) * 0.9 + (isZ ? 0.55 : 0),
        y: -0.75 - Math.random() * 0.2,
        vx: (Math.random() - 0.5) * 0.35 + (isZ ? 0.18 : 0),
        vy: -(0.45 + Math.random() * 0.35),
        gravity: 0,
        age: -i * 0.12,
        life: 1.3 + Math.random() * 0.5,
        rot: Math.random() * Math.PI * 2,
        spin: 2,
        size: 0.15 + Math.random() * 0.08,
        color: "",
        ray: 0,
      })
    }
  }

  update(dt: number) {
    const n = nowS()
    const nowMs = performance.now()
    const t = n - this.t0

    for (const [prop, tw] of [...this.tweens]) {
      const key = tw.keys[tw.index]
      const p = key[1] <= 0 ? 1 : Math.min(1, Math.max(0, (nowMs - tw.startMs) / key[1]))
      this[prop] = tw.from + (key[0] - tw.from) * key[2](p)
      if (p >= 1) {
        tw.from = key[0]
        tw.index += 1
        tw.startMs = nowMs
        if (tw.index >= tw.keys.length) {
          if (this.tweens.get(prop) === tw) this.tweens.delete(prop)
          tw.onComplete?.()
        }
      }
    }
    const locked = (prop: Tweenable) => this.tweens.has(prop)

    if (!this.reducedMotion && this.logo >= 0.999 && n >= this.nextSheen) {
      this.nextSheen = n + 5 + Math.random() * 3
      if (!locked("logoSheen")) {
        this.anim("logoSheen", [
          [1, 760, Ease.inOut],
          [0, 0, Ease.lin],
        ])
      }
    }

    // Gaze
    let ty = this.lookX * 0.6
    let tp = this.lookY * 0.45
    if (this.cfg.look) {
      ty = ty * 0.3 + this.cfg.look[0] * 0.55
      tp = tp * 0.3 + this.cfg.look[1] * 0.5
    }
    if (this.cfg.scans) {
      ty = Math.sin(t * 2.6) * 0.6
      tp = -0.05
    }
    if (this.state === "sleeping") {
      ty = 0
      tp = -0.12
    }
    if (this.state === "dizzy") ty = Math.sin(t * 9) * 0.25
    if (this.isMini) {
      ty = Math.sin(t * 0.7 + this.t0) * 0.5
      tp = Math.sin(t * 0.53) * 0.25
    }
    const kLook = 1 - Math.pow(0.0025, dt)
    const kGen = 1 - Math.pow(0.0008, dt)
    if (!locked("yaw")) this.yaw += (ty - this.yaw) * kLook
    this.pitch += (tp - this.pitch) * kLook
    if (!locked("tilt")) this.tilt += (this.cfg.tilt - this.tilt) * kGen

    // Idle motion: bounce, breathing, gentle float
    const bounce = this.cfg.bounces ? -Math.abs(Math.sin(t * 5.2)) * 0.08 : Math.sin(t * 1.6) * 0.02
    if (!locked("oy")) this.oy += (bounce - this.oy) * kGen
    let tgSy = 1
    let tgSx = 1
    if (this.cfg.breathes) {
      tgSy = 1 + Math.sin(t * 1.8) * 0.04
      tgSx = 1 - Math.sin(t * 1.8) * 0.025
    } else if (this.cfg.bounces) {
      const land = Math.max(0, Math.cos(t * 5.2 * 2)) * 0.05
      tgSy = 1 - land
      tgSx = 1 + land * 0.8
    }
    if (!locked("sy")) this.sy += (tgSy - this.sy) * kGen
    if (!locked("sx")) this.sx += (tgSx - this.sx) * kGen

    // Colour and glow ease toward the state
    this.col = mix(this.col, this.cfg.color, 1 - Math.pow(0.002, dt))
    this.tint += (this.cfg.tint - this.tint) * (1 - Math.pow(0.004, dt))
    const pulse = this.state === "working" || this.state === "thinking" ? Math.sin(t * 3.2) * 0.12 : 0
    this.glow += (this.cfg.glow + pulse - this.glow) * (1 - Math.pow(0.004, dt))

    // Jelly harmonics: damped springs, driven a little by the state
    for (const mode of this.jelly) {
      const omega = (2 * Math.PI) / mode.response
      const drive = this.cfg.jiggle * Math.sin(t * omega * 0.35 + mode.phase) * omega * 0.6
      const steps = Math.max(1, Math.ceil(dt * 240))
      const h = dt / steps
      for (let i = 0; i < steps; i++) {
        const acc = -omega * omega * mode.amp - 2 * mode.damping * omega * mode.vel + drive * omega
        mode.vel += acc * h
        mode.amp += mode.vel * h
      }
      mode.amp = Math.max(-0.14, Math.min(0.14, mode.amp))
    }

    // Antenna lags behind sideways motion and tilt
    const sideways = (this.ox - this.prevOx) / Math.max(dt, 1e-3) + (this.tilt - this.prevTilt) / Math.max(dt, 1e-3)
    this.prevOx = this.ox
    this.prevTilt = this.tilt
    const bendTarget = -sideways * 0.08 + this.lookX * -0.15
    const aOmega = (2 * Math.PI) / 0.45
    this.antennaVel += (aOmega * aOmega * (bendTarget - this.antennaBend) - 2 * 0.22 * aOmega * this.antennaVel) * dt
    this.antennaBend += this.antennaVel * dt
    this.antennaBend = Math.max(-1.2, Math.min(1.2, this.antennaBend))
    const vy = (this.oy - this.prevOy) / Math.max(dt, 1e-3)
    this.prevOy = this.oy
    this.flutter += (Math.min(1, Math.abs(vy) * 0.5) - this.flutter) * (1 - Math.pow(0.03, dt))

    // Blinks, fidgets, ambient particles
    // Idle blinks and fidgets are ambient motion: skip them for the mark and
    // under reduced motion.
    const ambientMotion = this.scale > 0.001 && !this.reducedMotion
    if (n > this.nextBlink) {
      if (ambientMotion && this.state !== "sleeping" && this.state !== "dizzy") {
        this.blink()
        if (Math.random() < 0.22) this.later(230, () => this.blink())
      }
      this.nextBlink = n + 2.2 + Math.random() * 3.2
    }
    if (n > this.nextFidget) {
      if (ambientMotion && this.state === "idle" && !this.isMini) {
        const roll = Math.random()
        if (roll < 0.35) this.hop(0.12)
        else if (roll < 0.7)
          this.anim("yaw", [
            [-0.5, 280, Ease.inOut],
            [0.5, 520, Ease.inOut],
            [0, 320, Ease.inOut],
          ])
        else this.jiggle(0.04)
      }
      this.nextFidget = n + 5 + Math.random() * 5
    }
    if (this.eyeOverride && n > this.overrideUntil) {
      this.eyeOverride = null
      this.mouthOverride = null
    }
    if (this.hoverSince != null && n - this.hoverSince > 1.9 && n - this.lastLove > 6) {
      this.lastLove = n
      this.emote("love")
    }
    if (n - this.lastAmbient > 1.3) {
      this.lastAmbient = n
      if (this.cfg.zz) this.emit("z", 1)
    }

    for (const p of this.particles) {
      p.age += dt
      if (p.age > 0 && p.gravity) {
        p.vy += p.gravity * dt
        p.x += p.vx * dt
        p.y += p.vy * dt
        p.vx *= Math.pow(0.4, dt)
      }
      p.rot += p.spin * dt
    }
    this.particles = this.particles.filter((p) => p.age < p.life)
  }

  // ── Drawing ──

  /** Draws into a W×H canvas in CSS pixels; the caller applies the DPR transform. */
  draw(x: CanvasRenderingContext2D, W: number, H: number) {
    const d = this.d
    const R = W * 0.3
    const rx = R * d.rx
    const ry = R * d.ry
    const cx = W / 2 + this.ox * R
    const feet = H - W * 0.5 + ry
    const cy = H - W * 0.5 + this.oy * R

    this.drawGlow(x, Math.min(R * 2.1, W / 2, H - cy) / 2.1, cx, cy)
    // Behind the body, so the last rays look absorbed into it.
    if (this.logo > 0.001 || nowS() < this.logoCoreUntil) this.drawLogo(x, R, rx, ry, cx, cy)
    if (this.scale > 0.001) this.drawCharacter(x, R, rx, ry, cx, cy, feet, this.scale)

    if (this.logoRing > 0 && this.logoRing < 1) this.drawLogoRing(x, R, cx, cy)
    if (this.badge && this.badgeS > 0.01 && !this.isMini && this.scale > 0.6) this.drawBadge(x, R, cx, cy, ry)
    this.drawParticles(x, R, cx, cy)
  }

  /** Body, face and extras, scaled around the feet so squashes sit on the
   * ground. */
  private drawCharacter(
    x: CanvasRenderingContext2D,
    R: number,
    rx: number,
    ry: number,
    cx: number,
    cy: number,
    feet: number,
    scale: number,
  ) {
    const d = this.d
    x.save()
    x.translate(cx, feet)
    x.scale(scale * this.sx, scale * this.sy)
    x.translate(0, cy - feet)
    if (this.tilt !== 0) x.rotate(this.tilt)
    if (d.tail) this.drawTail(x, R, rx, ry, d.tail)
    if (!this.isMini && d.antenna) this.drawAntenna(x, R, ry, d.antenna === "short" ? 0.55 : 1)
    if (d.ears === "fox") this.drawFoxEars(x, R, rx, ry)
    else if (d.ears === "bunny") this.drawBunnyEars(x, R, rx, ry)
    else if (d.ears === "bear") this.drawBearEars(x, R, rx, ry)
    else if (d.ears) this.drawEars(x, R, rx, ry)
    if (d.headgear) this.drawHeadgearBack(x, R, rx, ry, d.headgear)
    if (d.bolts) this.drawBolts(x, R, rx)
    const body = this.bodyPath(rx, ry)
    this.drawBody(x, body, R, rx, ry)
    this.drawFace(x, body, R, rx, ry)
    if (d.neck) this.drawNeck(x, body, R, rx, ry, d.neck)
    if (d.headgear) this.drawHeadgearFront(x, R, rx, ry, d.headgear)
    x.restore()
  }

  /** The character at full size on a square the width of the body, which is
   * also the mark's box. */
  private characterSprite(R: number, rx: number, ry: number): HTMLCanvasElement | null {
    if (typeof document === "undefined") return null
    const res = 2
    const side = Math.ceil(rx * 2 * res)
    const canvas = this.sprite ?? (this.sprite = document.createElement("canvas"))
    if (canvas.width !== side) {
      canvas.width = side
      canvas.height = side
    }
    const g = canvas.getContext("2d")
    if (!g) return null
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, side, side)
    g.setTransform(res, 0, 0, res, 0, 0)
    this.drawCharacter(g, R, rx, ry, rx, rx, rx + ry, 1)
    return canvas
  }

  /** The Shogo mark, the body's width across, centred on (cx, cy). How each
   * ray moves between the mark and the character depends on `logoStyle`. */
  private drawLogo(x: CanvasRenderingContext2D, R: number, rx: number, ry: number, cx: number, cy: number) {
    const style = LOGO_STYLES[this.logoStyle]
    const size = rx * 2
    const k = (size / SHOGO_MARK_SIZE) * this.logoS
    const mid = SHOGO_MARK_SIZE / 2
    const hx0 = cx + (MARK_HUB.x - mid) * k
    const hy0 = cy + (MARK_HUB.y - mid) * k
    const drift = style.drift ? this.logoDrift : 1
    const hx = cx + (hx0 - cx) * drift
    const hy = cy + (hy0 - cy) * drift
    const frame: LogoFrame = { g: 1 - this.logo, k, size, cx, cy, hx, hy, hx0, hy0 }
    const wave = this.logoWave * 1.5 - 0.25
    const sheen = this.logoSheen * 1.5 - 0.25
    const sprite = this.logoStyle === "mosaic" && frame.g > 0.05 ? this.characterSprite(R, rx, ry) : null
    const rays = logoRays()

    const drawRay = (ray: Ray, pose: RayPose, fade: number) => {
      if (pose.alpha * fade <= 0.01 || pose.along <= 0.01 || pose.across <= 0.005) return
      x.save()
      x.globalAlpha = Math.min(1, pose.alpha) * fade
      x.translate(pose.x, pose.y)
      x.rotate(pose.rot + ray.angle)
      x.scale(pose.along * k, pose.across * k)
      x.rotate(-ray.angle)
      x.translate(-ray.cx, -ray.cy)
      if (pose.image && sprite) {
        // Clip to the widened ray, then undo the widening for the picture.
        x.translate(ray.cx, ray.cy)
        x.rotate(ray.angle)
        x.scale(1, pose.widen)
        x.rotate(-ray.angle)
        x.translate(-ray.cx, -ray.cy)
        x.clip(ray.path)
        x.translate(ray.cx, ray.cy)
        x.rotate(ray.angle)
        x.scale(1, 1 / pose.widen)
        x.rotate(-ray.angle)
        x.translate(-ray.cx, -ray.cy)
        x.drawImage(sprite, 0, 0, SHOGO_MARK_SIZE, SHOGO_MARK_SIZE)
        if (pose.shade > 0.01) {
          x.fillStyle = `rgba(0,0,0,${pose.shade})`
          x.fillRect(0, 0, SHOGO_MARK_SIZE, SHOGO_MARK_SIZE)
        }
      } else {
        const shine = this.logoSheen > 0 ? 0.6 * bump(ray.order - sheen, 0.1) : 0
        let colour = mix(this.body, [1, 1, 1], clamp(pose.heat + shine, 0, 1))
        if (pose.shade > 0) colour = mix(colour, RAY_SHADE, pose.shade)
        x.fillStyle = rgba(colour)
        x.fill(ray.path)
      }
      x.restore()
    }

    x.save()
    // Spin about the mark's centre; the hub sits near its right edge.
    x.translate(cx, cy)
    x.rotate(this.logoSpin * style.spin)
    x.translate(-cx, -cy)
    const moving = frame.g > 0.01 && frame.g < 0.99
    const trails = moving ? style.trails : 0
    for (let t = trails; t >= 0; t--) {
      const at = t === 0 ? frame : { ...frame, g: clamp(frame.g - t * 0.03 * this.logoDir, 0, 1) }
      const fade = t === 0 ? 1 : 0.32 * (1 - t / (trails + 1))
      for (let i = 0; i < rays.length; i++) {
        const pose = rayPose(this.logoStyle, rays[i], i, at)
        if (t === 0 && this.logoWave > 0) pose.along *= 1 + 0.38 * bump(rays[i].order - wave, 0.14)
        drawRay(rays[i], pose, fade)
      }
    }

    // The core charges as rays are absorbed and gives way as the body grows.
    const core = (1 - this.logo) * clamp(1 - this.scale / 0.7, 0, 1)
    if (style.core && nowS() < this.logoCoreUntil && core > 0.01) {
      const r = size * 0.2 * Ease.out(core)
      const glow = x.createRadialGradient(hx, hy, 0, hx, hy, r * 2.2)
      glow.addColorStop(0, rgba([1, 1, 1], core))
      glow.addColorStop(0.35, rgba(mix(this.body, [1, 1, 1], 0.5), core))
      glow.addColorStop(1, rgba(this.body, 0))
      x.fillStyle = glow
      x.beginPath()
      x.arc(hx, hy, r * 2.2, 0, Math.PI * 2)
      x.fill()
    }
    x.restore()
  }

  /** The burst when the character pops out of the mark: a ring of short rays
   * flying off the body and fading. */
  private drawLogoRing(x: CanvasRenderingContext2D, R: number, cx: number, cy: number) {
    const t = this.logoRing
    const e = Ease.out(t)
    const rays = logoRays()
    x.save()
    x.globalAlpha = Math.pow(1 - t, 1.5)
    x.fillStyle = rgba(mix(this.body, [1, 1, 1], 0.35))
    for (let i = 0; i < rays.length; i += 2) {
      const ray = rays[i]
      const r = R * (0.95 + 0.75 * e)
      const s = (R * (0.5 - 0.3 * e)) / ray.len
      x.save()
      x.translate(cx + Math.cos(ray.angle) * r, cy + Math.sin(ray.angle) * r)
      x.scale(s, s)
      x.translate(-ray.cx, -ray.cy)
      x.fill(ray.path)
      x.restore()
    }
    x.restore()
  }

  private bodyPath(rx: number, ry: number): Path2D {
    const path = new Path2D()
    const d = this.d
    const n = 128
    const exp = 2 / d.exp
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      let px = rx * Math.sign(ca) * Math.abs(ca) ** exp
      let py = ry * Math.sign(sa) * Math.abs(sa) ** exp
      if (sa < 0) px *= 1 - d.taper * -sa
      else py *= d.base
      let k = 1
      for (const mode of this.jelly) k += d.jelly * mode.amp * Math.sin(mode.k * a + mode.phase)
      px *= k
      py *= k
      if (i === 0) path.moveTo(px, py)
      else path.lineTo(px, py)
    }
    path.closePath()
    return path
  }

  private drawGlow(x: CanvasRenderingContext2D, R: number, cx: number, cy: number) {
    if (this.glow <= 0.01) return
    const r = R * 2.1 * this.scale
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r)
    g.addColorStop(0, rgba(this.col, this.glow * 0.9))
    g.addColorStop(0.45, rgba(this.col, this.glow * 0.35))
    g.addColorStop(1, rgba(this.col, 0))
    x.fillStyle = g
    x.fillRect(cx - r, cy - r, r * 2, r * 2)
  }

  private drawEars(x: CanvasRenderingContext2D, R: number, rx: number, ry: number) {
    const t = nowS() - this.t0
    const twitch = Math.max(0, Math.sin(t * 0.9) - 0.96) * 12
    const light = mix(this.body, [1, 1, 1], 0.3)
    for (const sd of [-1, 1]) {
      const sway = this.antennaBend * 0.35 + (sd > 0 ? twitch * 0.25 : 0)
      x.save()
      x.translate(sd * rx * 0.55, -ry * 0.72)
      x.rotate(sd * 0.18 + sway)
      const w = R * 0.42
      const h = R * 0.5
      x.beginPath()
      x.moveTo(-w / 2, h * 0.2)
      x.quadraticCurveTo(-w * 0.3, -h * 0.55, -w * 0.02, -h * 0.78)
      x.quadraticCurveTo(w * 0.08, -h * 0.84, w * 0.18, -h * 0.72)
      x.quadraticCurveTo(w * 0.45, -h * 0.35, w / 2, h * 0.2)
      x.closePath()
      x.fillStyle = rgba(sd < 0 ? light : this.body)
      x.fill()
      x.beginPath()
      x.moveTo(-w * 0.26, h * 0.1)
      x.quadraticCurveTo(-w * 0.12, -h * 0.42, w * 0.02, -h * 0.56)
      x.quadraticCurveTo(w * 0.24, -h * 0.26, w * 0.26, h * 0.1)
      x.closePath()
      x.fillStyle = "rgba(255,120,150,0.55)"
      x.fill()
      x.restore()
    }
  }

  /** Tall pointed ears with dark tips and cream insides. */
  private drawFoxEars(x: CanvasRenderingContext2D, R: number, rx: number, ry: number) {
    const t = nowS() - this.t0
    const twitch = Math.max(0, Math.sin(t * 0.7) - 0.97) * 14
    const tip = mix(this.body, [0.12, 0.05, 0.03], 0.7)
    for (const sd of [-1, 1]) {
      const sway = this.antennaBend * 0.3 + (sd < 0 ? twitch * 0.2 : 0)
      x.save()
      x.translate(sd * rx * 0.58, -ry * 0.7)
      x.rotate(sd * 0.22 + sway)
      const w = R * 0.6
      const h = R * 0.92
      const ear = new Path2D()
      ear.moveTo(-w / 2, h * 0.18)
      ear.quadraticCurveTo(-w * 0.34, -h * 0.5, 0, -h * 0.9)
      ear.quadraticCurveTo(w * 0.34, -h * 0.5, w / 2, h * 0.18)
      ear.closePath()
      x.fillStyle = rgba(sd < 0 ? mix(this.body, [1, 1, 1], 0.2) : this.body)
      x.fill(ear)
      x.save()
      x.clip(ear)
      x.fillStyle = rgba(tip)
      x.fillRect(-w, -h, w * 2, h * 0.36)
      x.restore()
      x.beginPath()
      x.moveTo(-w * 0.24, h * 0.12)
      x.quadraticCurveTo(-w * 0.15, -h * 0.32, 0, -h * 0.54)
      x.quadraticCurveTo(w * 0.15, -h * 0.32, w * 0.24, h * 0.12)
      x.closePath()
      x.fillStyle = rgba(CREAM, 0.9)
      x.fill()
      x.restore()
    }
  }

  /** Long bunny ears; the right one flops over halfway up. */
  private drawBunnyEars(x: CanvasRenderingContext2D, R: number, rx: number, ry: number) {
    const t = nowS() - this.t0
    const twitch = Math.max(0, Math.sin(t * 0.8) - 0.96) * 12
    const w = R * 0.3
    const h = R * 1.05
    for (const sd of [-1, 1]) {
      x.save()
      x.translate(sd * rx * 0.36, -ry * 0.72)
      x.rotate(sd * 0.14 + this.antennaBend * 0.45 + (sd < 0 ? twitch * 0.15 : 0))
      const flop = sd > 0
      const p1: Pt = flop ? [0, -h * 0.8] : [0, -h * 0.55]
      const p2: Pt = flop ? [w * 1.6, -h * 0.62 + Math.sin(t * 2.2) * R * 0.03] : [sd * w * 0.15, -h]
      const width = (k: number) => w * (0.62 + 0.5 * Math.sin(Math.PI * k * 0.85))
      x.fillStyle = rgba(sd < 0 ? mix(this.body, [1, 1, 1], 0.2) : this.body)
      x.fill(ribbon([0, 0], p1, p2, width))
      x.fillStyle = "rgba(255,130,160,0.5)"
      x.fill(ribbon([0, -h * 0.05], p1, p2, (k) => width(k) * 0.42 * Math.min(1, (1 - k) * 4)))
      x.restore()
    }
  }

  /** Small round bear ears. */
  private drawBearEars(x: CanvasRenderingContext2D, R: number, rx: number, ry: number) {
    const t = nowS() - this.t0
    const twitch = 1 + Math.max(0, Math.sin(t * 0.9) - 0.97) * 3
    for (const sd of [-1, 1]) {
      const cx = sd * rx * 0.64 + this.antennaBend * R * 0.08
      const cy = -ry * 0.86
      const r = R * 0.23 * (sd > 0 ? twitch : 1)
      x.fillStyle = rgba(sd < 0 ? mix(this.body, [1, 1, 1], 0.2) : this.body)
      x.beginPath()
      x.arc(cx, cy, r, 0, Math.PI * 2)
      x.fill()
      x.fillStyle = rgba(mix(this.body, [0.35, 0.12, 0.06], 0.45))
      x.beginPath()
      x.arc(cx + sd * r * 0.08, cy - r * 0.08, r * 0.55, 0, Math.PI * 2)
      x.fill()
    }
  }

  /** The parts of the headgear that sit behind the body. */
  private drawHeadgearBack(x: CanvasRenderingContext2D, R: number, rx: number, ry: number, kind: Headgear) {
    const t = nowS() - this.t0
    if (kind === "horns") {
      for (const sd of [-1, 1]) {
        x.save()
        x.translate(sd * rx * 0.44, -ry * 0.8)
        x.rotate(sd * 0.1 + this.antennaBend * 0.15)
        const horn = ribbon([0, 0], [sd * R * 0.02, -R * 0.34], [sd * R * 0.24, -R * 0.48], (k) => R * 0.22 * (1 - k))
        const g = x.createLinearGradient(0, 0, 0, -R * 0.48)
        g.addColorStop(0, "#C9A979")
        g.addColorStop(1, "#F6ECD6")
        x.fillStyle = g
        x.fill(horn)
        x.strokeStyle = "rgba(120,85,45,0.45)"
        x.lineWidth = R * 0.02
        x.lineCap = "round"
        for (const k of [0.25, 0.45]) {
          const p = quadAt([0, 0], [sd * R * 0.02, -R * 0.34], [sd * R * 0.24, -R * 0.48], k)
          const hw = R * 0.11 * (1 - k)
          x.beginPath()
          x.moveTo(p.x + p.nx * hw, p.y + p.ny * hw)
          x.lineTo(p.x - p.nx * hw, p.y - p.ny * hw)
          x.stroke()
        }
        x.restore()
      }
    } else if (kind === "sprout") {
      const sway = this.antennaBend * 0.6 + Math.sin(t * 1.3) * 0.06
      const baseY = -ry * 0.82
      const tipX = Math.sin(sway) * R * 0.42
      const tipY = baseY - Math.cos(sway) * R * 0.42
      x.save()
      x.strokeStyle = "#3F8F35"
      x.lineWidth = R * 0.055
      x.lineCap = "round"
      x.beginPath()
      x.moveTo(0, baseY)
      x.quadraticCurveTo(tipX * 0.1, baseY - R * 0.25, tipX, tipY)
      x.stroke()
      if (this.state === "finished") {
        x.fillStyle = "#FF8FB1"
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + t * 0.6
          x.beginPath()
          x.arc(tipX + Math.cos(a) * R * 0.1, tipY + Math.sin(a) * R * 0.1, R * 0.08, 0, Math.PI * 2)
          x.fill()
        }
        x.fillStyle = "#FFD23F"
        x.beginPath()
        x.arc(tipX, tipY, R * 0.065, 0, Math.PI * 2)
        x.fill()
      } else {
        for (const sd of [-1, 1]) {
          x.save()
          x.translate(tipX, tipY)
          x.rotate(sway + sd * (0.75 + Math.sin(t * 1.7 + sd) * 0.08))
          const leaf = new Path2D()
          leaf.moveTo(0, 0)
          leaf.quadraticCurveTo(sd * R * 0.14, -R * 0.12, sd * R * 0.3, 0)
          leaf.quadraticCurveTo(sd * R * 0.14, R * 0.1, 0, 0)
          const g = x.createLinearGradient(0, -R * 0.1, 0, R * 0.1)
          g.addColorStop(0, "#8BDC5F")
          g.addColorStop(1, "#3F9C35")
          x.fillStyle = g
          x.fill(leaf)
          x.strokeStyle = "rgba(30,90,30,0.5)"
          x.lineWidth = R * 0.015
          x.beginPath()
          x.moveTo(sd * R * 0.03, 0)
          x.lineTo(sd * R * 0.24, -R * 0.01)
          x.stroke()
          x.restore()
        }
      }
      x.restore()
    } else if (kind === "headphones") {
      x.save()
      x.lineCap = "round"
      const band = new Path2D()
      band.moveTo(-rx * 1.02, -ry * 0.1)
      band.bezierCurveTo(-rx * 1.06, -ry * 1.5, rx * 1.06, -ry * 1.5, rx * 1.02, -ry * 0.1)
      x.strokeStyle = "#26262C"
      x.lineWidth = R * 0.11
      x.stroke(band)
      x.strokeStyle = "#4A4A55"
      x.lineWidth = R * 0.035
      x.stroke(band)
      x.restore()
    }
  }

  /** The parts of the headgear in front of the body. */
  private drawHeadgearFront(x: CanvasRenderingContext2D, R: number, rx: number, ry: number, kind: Headgear) {
    const t = nowS() - this.t0
    const bend = this.antennaBend
    x.save()
    x.lineJoin = "round"
    x.lineCap = "round"
    if (kind === "halo") {
      const y = -ry - R * 0.42 + Math.sin(t * 2) * R * 0.04
      x.translate(0, y)
      x.rotate(bend * 0.3)
      x.shadowColor = "rgba(255,214,74,0.9)"
      x.shadowBlur = R * 0.25
      x.strokeStyle = "#FFD54A"
      x.lineWidth = R * 0.075
      x.beginPath()
      x.ellipse(0, 0, R * 0.42, R * 0.11, 0, 0, Math.PI * 2)
      x.stroke()
      x.shadowBlur = 0
      x.strokeStyle = "#FFF5C2"
      x.lineWidth = R * 0.025
      x.stroke()
    } else if (kind === "crown") {
      x.translate(rx * 0.1, -ry * 0.86)
      x.rotate(-0.12 + bend * 0.3)
      const w = R * 0.86
      const h = R * 0.46
      const crown = new Path2D()
      crown.moveTo(-w / 2, 0)
      crown.lineTo(-w / 2, -h * 0.72)
      crown.lineTo(-w * 0.25, -h * 0.38)
      crown.lineTo(0, -h)
      crown.lineTo(w * 0.25, -h * 0.38)
      crown.lineTo(w / 2, -h * 0.72)
      crown.lineTo(w / 2, 0)
      crown.closePath()
      const gold = x.createLinearGradient(-w / 2, -h, w / 2, 0)
      gold.addColorStop(0, "#FFE58A")
      gold.addColorStop(0.55, "#F4B400")
      gold.addColorStop(1, "#C98A00")
      x.fillStyle = gold
      x.fill(crown)
      x.strokeStyle = "#A86F00"
      x.lineWidth = R * 0.025
      x.stroke(crown)
      x.fillStyle = "rgba(160,100,0,0.35)"
      x.fillRect(-w / 2, -h * 0.24, w, h * 0.24)
      for (const [px, py] of [[-w / 2, -h * 0.72], [0, -h], [w / 2, -h * 0.72]] as const) {
        x.fillStyle = "#FFF1B8"
        x.beginPath()
        x.arc(px, py, R * 0.055, 0, Math.PI * 2)
        x.fill()
      }
      x.fillStyle = "#E0245E"
      x.beginPath()
      x.arc(0, -h * 0.12, R * 0.065, 0, Math.PI * 2)
      x.fill()
      x.fillStyle = "#3FA9F5"
      for (const sd of [-1, 1]) {
        x.beginPath()
        x.arc(sd * w * 0.3, -h * 0.12, R * 0.045, 0, Math.PI * 2)
        x.fill()
      }
    } else if (kind === "party") {
      x.translate(rx * 0.2, -ry * 0.88)
      x.rotate(0.28 + bend * 0.4)
      const w = R * 0.62
      const h = R * 0.95
      const cone = new Path2D()
      cone.moveTo(-w / 2, 0)
      cone.lineTo(0, -h)
      cone.lineTo(w / 2, 0)
      cone.quadraticCurveTo(0, R * 0.08, -w / 2, 0)
      cone.closePath()
      x.fillStyle = "#7C5CFF"
      x.fill(cone)
      x.save()
      x.clip(cone)
      x.strokeStyle = "#FFD23F"
      x.lineWidth = R * 0.09
      for (let k = -2; k <= 3; k++) {
        x.beginPath()
        x.moveTo(-w, -h * 0.28 * k)
        x.lineTo(w, -h * 0.28 * k - h * 0.35)
        x.stroke()
      }
      x.fillStyle = "rgba(255,255,255,0.18)"
      x.fillRect(-w / 2, -h, w * 0.35, h)
      x.restore()
      x.fillStyle = "#FF5D8F"
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.sin(t * 3) * 0.3
        x.beginPath()
        x.arc(Math.cos(a) * R * 0.07, -h + Math.sin(a) * R * 0.07, R * 0.07, 0, Math.PI * 2)
        x.fill()
      }
    } else if (kind === "beanie") {
      const bottom = this.d.screen ? -ry * 0.7 : -ry * 0.5
      const cuff = ry * 0.3
      x.translate(0, bottom)
      x.rotate(bend * 0.12)
      const dome = new Path2D()
      dome.moveTo(-rx * 1.03, -cuff * 0.5)
      dome.bezierCurveTo(-rx * 1.0, -ry * 1.05, rx * 1.0, -ry * 1.05, rx * 1.03, -cuff * 0.5)
      dome.closePath()
      const knit = x.createLinearGradient(-rx, -ry, rx, 0)
      knit.addColorStop(0, "#3E79B5")
      knit.addColorStop(1, "#22487A")
      x.fillStyle = knit
      x.fill(dome)
      if (!this.isMini) {
        x.save()
        x.clip(dome)
        x.strokeStyle = "rgba(0,0,0,0.14)"
        x.lineWidth = R * 0.025
        for (let k = -4; k <= 4; k++) {
          x.beginPath()
          x.moveTo(k * rx * 0.2, 0)
          x.quadraticCurveTo(k * rx * 0.16, -ry * 0.5, k * rx * 0.08, -ry * 0.85)
          x.stroke()
        }
        x.restore()
      }
      roundRect(x, -rx * 1.08, -cuff, rx * 2.16, cuff, R * 0.1)
      x.fillStyle = "#1D3D66"
      x.fill()
      if (!this.isMini) {
        x.strokeStyle = "rgba(255,255,255,0.12)"
        x.lineWidth = R * 0.03
        for (let k = -9; k <= 9; k++) {
          x.beginPath()
          x.moveTo(k * rx * 0.11, -cuff * 0.82)
          x.lineTo(k * rx * 0.11, -cuff * 0.18)
          x.stroke()
        }
      }
      const pomY = -ry * 0.82 + Math.sin(t * 2.4) * R * 0.015
      x.fillStyle = rgba(CREAM)
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2
        x.beginPath()
        x.arc(Math.cos(a) * R * 0.09, pomY + Math.sin(a) * R * 0.08, R * 0.1, 0, Math.PI * 2)
        x.fill()
      }
    } else if (kind === "wizard") {
      const by = -ry * 0.9
      x.translate(0, by)
      x.rotate(-0.05 + bend * 0.2)
      const brimW = rx * 0.98
      const brimH = R * 0.14
      x.fillStyle = "#2B1E57"
      x.beginPath()
      x.ellipse(0, 0, brimW, brimH, 0, 0, Math.PI * 2)
      x.fill()
      const tipX = R * 0.42 + Math.sin(bend * 1.5 + Math.sin(t * 1.2) * 0.2) * R * 0.25
      const tipY = -R * 1.2
      const cone = new Path2D()
      cone.moveTo(-R * 0.44, 0)
      cone.quadraticCurveTo(-R * 0.18, -R * 0.75, tipX, tipY)
      cone.quadraticCurveTo(R * 0.12, -R * 0.62, R * 0.44, 0)
      cone.closePath()
      const robe = x.createLinearGradient(-R * 0.4, tipY, R * 0.4, 0)
      robe.addColorStop(0, "#6A4BC4")
      robe.addColorStop(1, "#33236B")
      x.fillStyle = robe
      x.fill(cone)
      x.save()
      x.clip(cone)
      x.fillStyle = "#FFD23F"
      x.fillRect(-R * 0.5, -R * 0.16, R, R * 0.09)
      for (const [sx, sy, s] of [[-R * 0.1, -R * 0.45, 0.07], [R * 0.14, -R * 0.75, 0.05], [R * 0.2, -R * 0.33, 0.04]] as const) {
        x.save()
        x.translate(sx, sy)
        x.rotate(t * 0.5)
        star(x, R * s, R * s * 0.45)
        x.fill()
        x.restore()
      }
      x.restore()
      x.fillStyle = "#3A2A73"
      x.beginPath()
      x.ellipse(0, 0, brimW, brimH, 0, 0, Math.PI)
      x.fill()
    } else if (kind === "headphones") {
      const beat = this.state === "working" ? 1 + Math.max(0, Math.sin(t * 9)) * 0.06 : 1
      for (const sd of [-1, 1]) {
        x.save()
        x.translate(sd * rx * 1.0, -ry * 0.08)
        x.scale(beat, beat)
        const w = R * 0.26
        const h = R * 0.46
        const shell = x.createLinearGradient(-w / 2, 0, w / 2, 0)
        shell.addColorStop(0, "#3A3A44")
        shell.addColorStop(1, "#18181D")
        x.fillStyle = shell
        roundRect(x, -w / 2, -h / 2, w, h, w * 0.45)
        x.fill()
        x.fillStyle = rgba(this.state === "idle" || this.state === "sleeping" ? mix(this.body, [1, 1, 1], 0.55) : this.col)
        roundRect(x, sd * w * 0.08 - w * 0.17, -h * 0.3, w * 0.34, h * 0.6, w * 0.17)
        x.fill()
        x.restore()
      }
    }
    x.restore()
  }

  /** Tails wag faster the busier Shogo is. */
  private tailSwing(): number {
    const t = nowS() - this.t0
    const busy = this.state === "working" || this.state === "finished"
    const speed = this.state === "sleeping" ? 0.8 : busy ? 7 : 2
    const amp = this.state === "sleeping" ? 0.04 : busy ? 0.22 : 0.1
    return Math.sin(t * speed) * amp - this.antennaBend * 0.4
  }

  private drawTail(x: CanvasRenderingContext2D, R: number, rx: number, ry: number, kind: Exclude<BuddyTail, "none">) {
    if (kind === "fox") this.drawFoxTail(x, R, rx, ry)
    else if (kind === "cat") this.drawCatTail(x, R, rx, ry)
    else if (kind === "bunny") this.drawBunnyTail(x, R, rx, ry)
    else if (kind === "dragon") this.drawDragonTail(x, R, rx, ry)
    else this.drawCable(x, R, rx, ry)
  }

  /** A bushy fox tail with a cream tip. */
  private drawFoxTail(x: CanvasRenderingContext2D, R: number, rx: number, ry: number) {
    const L = R * 1.45
    const w = R * 0.95
    x.save()
    x.translate(rx * 0.6, ry * 0.55)
    x.rotate(-0.95 + this.tailSwing())
    const tail = new Path2D()
    tail.moveTo(0, -w * 0.18)
    tail.bezierCurveTo(L * 0.35, -w * 0.75, L * 0.9, -w * 0.72, L * 1.02, -w * 0.06)
    tail.bezierCurveTo(L * 1.05, w * 0.32, L * 0.62, w * 0.52, 0, w * 0.22)
    tail.closePath()
    const fur = x.createLinearGradient(0, -w / 2, 0, w / 2)
    fur.addColorStop(0, rgba(mix(this.body, [1, 1, 1], 0.25)))
    fur.addColorStop(1, rgba(mix(this.body, [0, 0, 0], 0.25)))
    x.fillStyle = fur
    x.fill(tail)
    x.save()
    x.clip(tail)
    x.fillStyle = rgba(CREAM)
    x.beginPath()
    x.ellipse(L * 1.02, -w * 0.12, L * 0.3, w * 0.62, -0.3, 0, Math.PI * 2)
    x.fill()
    if (!this.isMini) {
      x.strokeStyle = rgba(mix(this.body, [0, 0, 0], 0.35), 0.35)
      x.lineWidth = R * 0.03
      x.lineCap = "round"
      for (const [s, o] of [[0.3, -0.1], [0.5, 0.12], [0.62, -0.2]] as const) {
        x.beginPath()
        x.moveTo(L * s, w * o)
        x.quadraticCurveTo(L * (s + 0.08), w * (o - 0.08), L * (s + 0.16), w * o)
        x.stroke()
      }
    }
    x.restore()
    x.restore()
  }

  /** A thin tail that stands up and hooks over at the tip. */
  private drawCatTail(x: CanvasRenderingContext2D, R: number, rx: number, ry: number) {
    const t = nowS() - this.t0
    const curl = Math.sin(t * 1.3) * R * 0.08
    x.save()
    x.translate(rx * 0.7, ry * 0.55)
    x.rotate(this.tailSwing() * 1.3)
    const tip: Pt = [R * 0.5, -R * 0.95]
    const w = R * 0.16
    x.fillStyle = rgba(mix(this.body, [0, 0, 0], 0.1))
    x.fill(ribbon([0, 0], [R * 1.0, R * 0.05], tip, () => w))
    x.fill(ribbon(tip, [R * 0.35, -R * 1.2], [R * 0.12 + curl, -R * 1.08], () => w))
    x.restore()
  }

  /** A round cotton puff peeking out behind. */
  private drawBunnyTail(x: CanvasRenderingContext2D, R: number, rx: number, ry: number) {
    const t = nowS() - this.t0
    const wiggle = 1 + Math.sin(t * (this.state === "working" ? 9 : 3)) * 0.04
    const cx = rx * 0.98
    const cy = ry * 0.55
    const r = R * 0.24 * wiggle
    const fluff = x.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 0, cx, cy, r * 1.3)
    fluff.addColorStop(0, "#FFFFFF")
    fluff.addColorStop(1, "#E6DDD3")
    x.fillStyle = fluff
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      x.beginPath()
      x.arc(cx + Math.cos(a) * r * 0.5, cy + Math.sin(a) * r * 0.5, r * 0.6, 0, Math.PI * 2)
      x.fill()
    }
  }

  /** A tapering tail with spikes along the top and a spade on the end. */
  private drawDragonTail(x: CanvasRenderingContext2D, R: number, rx: number, ry: number) {
    x.save()
    x.translate(rx * 0.6, ry * 0.62)
    x.rotate(-0.2 + this.tailSwing() * 0.8)
    const p0: Pt = [0, 0]
    const p1: Pt = [R * 0.85, R * 0.3]
    const p2: Pt = [R * 1.2, -R * 0.38]
    const width = (k: number) => R * 0.4 * (1 - k * 0.8)
    const spike = rgba(mix(this.body, [0.3, 0.02, 0], 0.6))
    x.fillStyle = spike
    for (const k of [0.22, 0.42, 0.6, 0.76]) {
      const p = quadAt(p0, p1, p2, k)
      const hw = width(k) / 2
      const bx = p.x - p.nx * hw * 0.7
      const by = p.y - p.ny * hw * 0.7
      const tall = hw * 0.3 + R * 0.13 * (1 - k * 0.5)
      x.beginPath()
      x.moveTo(bx - p.tx * R * 0.08, by - p.ty * R * 0.08)
      x.lineTo(bx - p.nx * tall + p.tx * R * 0.03, by - p.ny * tall + p.ty * R * 0.03)
      x.lineTo(bx + p.tx * R * 0.08, by + p.ty * R * 0.08)
      x.fill()
    }
    const end = quadAt(p0, p1, p2, 1)
    x.beginPath()
    x.moveTo(end.x - end.tx * R * 0.04, end.y - end.ty * R * 0.04)
    x.lineTo(end.x + end.nx * R * 0.16 + end.tx * R * 0.06, end.y + end.ny * R * 0.16 + end.ty * R * 0.06)
    x.lineTo(end.x + end.tx * R * 0.3, end.y + end.ty * R * 0.3)
    x.lineTo(end.x - end.nx * R * 0.16 + end.tx * R * 0.06, end.y - end.ny * R * 0.16 + end.ty * R * 0.06)
    x.closePath()
    x.fill()
    const scales = x.createLinearGradient(0, -R * 0.4, 0, R * 0.3)
    scales.addColorStop(0, rgba(mix(this.body, [1, 1, 1], 0.12)))
    scales.addColorStop(1, rgba(mix(this.body, [0, 0, 0], 0.28)))
    x.fillStyle = scales
    x.fill(ribbon(p0, p1, p2, width))
    x.restore()
  }

  /** A charging cable trailing on the ground, with a pulse running along it
   * while Shogo works. */
  private drawCable(x: CanvasRenderingContext2D, R: number, rx: number, ry: number) {
    const t = nowS() - this.t0
    const sway = Math.sin(t * 1.4) * R * 0.03 - this.antennaBend * R * 0.1
    const p0: Pt = [rx * 0.8, ry * 0.45]
    const c1: Pt = [rx * 1.42 + sway, ry * 0.35]
    const c2: Pt = [rx * 0.95 + sway, ry * 0.98]
    const p3: Pt = [rx * 1.18, ry * 0.97]
    x.save()
    x.lineCap = "round"
    const cable = new Path2D()
    cable.moveTo(p0[0], p0[1])
    cable.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], p3[0], p3[1])
    x.strokeStyle = "#2B2B31"
    x.lineWidth = R * 0.075
    x.stroke(cable)
    x.strokeStyle = "rgba(255,255,255,0.18)"
    x.lineWidth = R * 0.02
    x.stroke(cable)
    const busy = this.state === "working" || this.state === "thinking"
    if (busy && !this.isMini) {
      const k = 1 - ((t * 0.9) % 1)
      const u = 1 - k
      const px = u * u * u * p0[0] + 3 * u * u * k * c1[0] + 3 * u * k * k * c2[0] + k * k * k * p3[0]
      const py = u * u * u * p0[1] + 3 * u * u * k * c1[1] + 3 * u * k * k * c2[1] + k * k * k * p3[1]
      const glow = x.createRadialGradient(px, py, 0, px, py, R * 0.12)
      glow.addColorStop(0, rgba(mix(this.col, [1, 1, 1], 0.5)))
      glow.addColorStop(1, rgba(this.col, 0))
      x.fillStyle = glow
      x.beginPath()
      x.arc(px, py, R * 0.12, 0, Math.PI * 2)
      x.fill()
    }
    const plugW = R * 0.18
    const plugH = R * 0.15
    x.fillStyle = "#3A3A43"
    roundRect(x, p3[0], p3[1] - plugH / 2, plugW, plugH, R * 0.035)
    x.fill()
    x.fillStyle = "#D6D8DE"
    for (const sd of [-1, 1]) x.fillRect(p3[0] + plugW, p3[1] + sd * R * 0.035 - R * 0.0125, R * 0.07, R * 0.025)
    x.restore()
  }

  /** Glasses over the eyes. Opaque lenses show emote eyes (hearts, stars,
   * spirals) on the glass, so emotes keep working. */
  private drawEyewear(
    x: CanvasRenderingContext2D,
    kind: Exclude<BuddyEyewear, "none">,
    lenses: Lens[],
    R: number,
    rx: number,
    shape: EyeShape,
  ) {
    const mult = this.isMini ? 1.6 : 1
    const showThrough = shape === "heart" || shape === "star" || shape === "spiral"
    x.save()
    x.lineCap = "round"
    x.lineJoin = "round"
    if (kind === "monocle") this.drawMonocle(x, lenses, R, mult)
    else if (kind === "goggles") this.drawGoggles(x, lenses, R, mult, showThrough ? shape : null)
    else {
      const spec = {
        sunglasses: { w: 0.4, h: 0.3, frame: "#0B0B0D", line: 0.05 },
        nerd: { w: 0.4, h: 0.4, frame: "#3A2418", line: 0.055 },
        stars: { w: 0.48, h: 0.48, frame: "#FFD23F", line: 0.035 },
        "3d": { w: 0.4, h: 0.28, frame: "#F4F1EA", line: 0.06 },
      }[kind]
      const lw = R * spec.w * mult
      const lh = R * spec.h * mult
      x.strokeStyle = spec.frame
      x.lineWidth = R * spec.line * mult
      if (lenses.length === 2) {
        const [a, b] = lenses
        x.beginPath()
        x.moveTo(a.x, a.y - lh * 0.15)
        x.quadraticCurveTo((a.x + b.x) / 2, Math.min(a.y, b.y) - lh * 0.4, b.x, b.y - lh * 0.15)
        x.stroke()
      }
      for (const lens of lenses) {
        x.save()
        x.translate(lens.x, lens.y)
        x.scale(lens.sx, lens.sy)
        const path = new Path2D()
        if (kind === "sunglasses") {
          path.moveTo(-lw / 2, -lh / 2)
          path.lineTo(lw / 2, -lh / 2)
          path.quadraticCurveTo(lw / 2, lh * 0.42, lw * 0.08, lh / 2)
          path.lineTo(-lw * 0.08, lh / 2)
          path.quadraticCurveTo(-lw / 2, lh * 0.42, -lw / 2, -lh / 2)
        } else if (kind === "nerd") {
          path.arc(0, 0, lw / 2, 0, Math.PI * 2)
        } else if (kind === "stars") {
          const ro = lw / 2
          for (let i = 0; i < 10; i++) {
            const r = i % 2 ? ro * 0.5 : ro
            const a = -Math.PI / 2 + (i * Math.PI) / 5
            path.lineTo(Math.cos(a) * r, Math.sin(a) * r)
          }
        } else {
          path.rect(-lw / 2, -lh / 2, lw, lh)
        }
        path.closePath()
        if (kind === "sunglasses") {
          const glass = x.createLinearGradient(0, -lh / 2, 0, lh / 2)
          glass.addColorStop(0, "#34343A")
          glass.addColorStop(1, this.state === "idle" || this.state === "sleeping" ? "#060607" : rgba(mix(this.col, [0, 0, 0], 0.7)))
          x.fillStyle = glass
        } else if (kind === "stars") {
          const glass = x.createLinearGradient(0, -lh / 2, 0, lh / 2)
          glass.addColorStop(0, "#FF5FA8")
          glass.addColorStop(1, "#7A1FA2")
          x.fillStyle = glass
        } else if (kind === "3d") {
          x.fillStyle = lens.sd < 0 ? "rgba(235,45,60,0.55)" : "rgba(20,195,235,0.55)"
        } else {
          x.fillStyle = "rgba(255,255,255,0.14)"
        }
        x.fill(path)
        x.stroke(path)
        x.save()
        x.clip(path)
        x.fillStyle = kind === "sunglasses" || kind === "stars" ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.4)"
        x.beginPath()
        x.moveTo(-lw * 0.05, -lh / 2)
        x.lineTo(lw * 0.12, -lh / 2)
        x.lineTo(-lw * 0.18, lh / 2)
        x.lineTo(-lw * 0.35, lh / 2)
        x.fill()
        x.restore()
        if (showThrough && OPAQUE_EYEWEAR.has(kind)) {
          this.drawEye(x, shape, R * 0.16 * mult, R * 0.18 * mult, lens.sd, "#fff", false, false)
        }
        x.restore()
      }
    }
    x.restore()
  }

  /** A gold-rimmed monocle on one eye, without an outside chain. */
  private drawMonocle(x: CanvasRenderingContext2D, lenses: Lens[], R: number, mult: number) {
    const lens = lenses.find((l) => l.sd > 0) ?? lenses[0]
    const r = R * 0.21 * mult
    x.strokeStyle = "#C8961A"
    x.lineWidth = R * 0.018 * mult
    x.save()
    x.translate(lens.x, lens.y)
    x.scale(lens.sx, lens.sy)
    x.fillStyle = "rgba(255,255,255,0.14)"
    x.beginPath()
    x.arc(0, 0, r, 0, Math.PI * 2)
    x.fill()
    x.strokeStyle = "#E8B730"
    x.lineWidth = R * 0.045 * mult
    x.stroke()
    x.strokeStyle = "rgba(255,255,255,0.55)"
    x.lineWidth = R * 0.025 * mult
    x.beginPath()
    x.arc(0, 0, r * 0.68, -2.6, -1.9)
    x.stroke()
    x.restore()
  }

  /** One wide mirrored lens across both eyes. */
  private drawGoggles(
    x: CanvasRenderingContext2D,
    lenses: Lens[],
    R: number,
    mult: number,
    emote: EyeShape | null,
  ) {
    const a = lenses[0]
    const b = lenses[lenses.length - 1]
    const cx = (a.x + b.x) / 2
    const cy = (a.y + b.y) / 2
    const gw = Math.abs(b.x - a.x) + R * 0.5 * mult
    const gh = R * 0.38 * mult
    x.fillStyle = "#1C1C22"
    roundRect(x, cx - gw / 2 - R * 0.05, cy - gh / 2 - R * 0.05, gw + R * 0.1, gh + R * 0.1, gh * 0.55)
    x.fill()
    roundRect(x, cx - gw / 2, cy - gh / 2, gw, gh, gh * 0.45)
    const mirror = x.createLinearGradient(cx - gw / 2, cy - gh / 2, cx + gw / 2, cy + gh / 2)
    mirror.addColorStop(0, "#FFD84A")
    mirror.addColorStop(0.45, "#FF6A3D")
    mirror.addColorStop(1, "#7B3FE4")
    x.fillStyle = mirror
    x.fill()
    x.save()
    x.clip()
    x.fillStyle = "rgba(255,255,255,0.35)"
    x.beginPath()
    x.moveTo(cx - gw * 0.1, cy - gh / 2)
    x.lineTo(cx + gw * 0.02, cy - gh / 2)
    x.lineTo(cx - gw * 0.2, cy + gh / 2)
    x.lineTo(cx - gw * 0.32, cy + gh / 2)
    x.fill()
    x.restore()
    if (emote) {
      for (const lens of lenses) {
        x.save()
        x.translate(lens.x, lens.y)
        x.scale(lens.sx, lens.sy)
        this.drawEye(x, emote, R * 0.16 * mult, R * 0.18 * mult, lens.sd, "#fff", false, false)
        x.restore()
      }
    }
  }

  /** Scarf, bandana or bow tie, low on the body below the mouth. */
  private drawNeck(
    x: CanvasRenderingContext2D,
    body: Path2D,
    R: number,
    rx: number,
    ry: number,
    kind: Exclude<BuddyNeck, "none">,
  ) {
    const t = nowS() - this.t0
    const cx = Math.sin(this.yaw) * rx * 0.68
    // Wraps follow the body's jiggle: clip to a slightly widened body.
    const wrap = (paint: () => void) => {
      x.save()
      x.scale(1.04, 1)
      x.clip(body)
      x.scale(1 / 1.04, 1)
      paint()
      x.restore()
    }
    x.save()
    x.lineCap = "round"
    x.lineJoin = "round"
    if (kind === "scarf") {
      const top = ry * 0.5
      const bottom = ry * 0.76
      const wool = x.createLinearGradient(0, top, 0, bottom)
      wool.addColorStop(0, "#EF5350")
      wool.addColorStop(1, "#B71C2C")
      wrap(() => {
        x.fillStyle = wool
        x.fillRect(-rx * 1.3, top, rx * 2.6, bottom - top)
        if (!this.isMini) {
          x.strokeStyle = "rgba(0,0,0,0.13)"
          x.lineWidth = R * 0.025
          for (let k = -10; k <= 10; k++) {
            x.beginPath()
            x.moveTo(k * R * 0.12 + cx * 0.3, top + R * 0.03)
            x.lineTo(k * R * 0.12 + cx * 0.3, bottom - R * 0.03)
            x.stroke()
          }
        }
        x.fillStyle = "rgba(255,255,255,0.18)"
        x.fillRect(-rx * 1.3, top, rx * 2.6, R * 0.04)
      })
      const knotX = cx - rx * 0.42
      const knotY = (top + bottom) / 2
      const lift = this.flutter
      for (const [i, len] of [[0, R * 0.42], [1, R * 0.34]] as const) {
        const base = 0.15 + i * 0.3 - lift * (0.9 + i * 0.2)
        const wave = Math.sin(t * (3 + lift * 14) + i) * (0.04 + lift * 0.28)
        const dir = Math.PI / 2 + base + wave
        const p2: Pt = [knotX + Math.cos(dir) * len, knotY + Math.sin(dir) * len]
        const p1: Pt = [
          knotX + Math.cos(dir - wave * 2) * len * 0.5,
          knotY + Math.sin(dir - wave * 2) * len * 0.5,
        ]
        x.fillStyle = i === 0 ? "#D32F3C" : "#B71C2C"
        x.fill(ribbon([knotX, knotY], p1, p2, () => R * 0.19))
        if (!this.isMini) {
          const end = quadAt([knotX, knotY], p1, p2, 1)
          x.strokeStyle = "rgba(255,240,230,0.85)"
          x.lineWidth = R * 0.025
          x.beginPath()
          x.moveTo(end.x + end.nx * R * 0.08, end.y + end.ny * R * 0.08)
          x.lineTo(end.x - end.nx * R * 0.08, end.y - end.ny * R * 0.08)
          x.stroke()
        }
      }
      x.fillStyle = "#C62834"
      x.beginPath()
      x.ellipse(knotX, knotY, R * 0.13, R * 0.11, 0, 0, Math.PI * 2)
      x.fill()
    } else if (kind === "bandana") {
      const top = ry * 0.5
      const red = "#D62839"
      wrap(() => {
        x.fillStyle = red
        x.fillRect(-rx * 1.3, top, rx * 2.6, R * 0.12)
        const flap = new Path2D()
        flap.moveTo(cx - rx * 0.55, top + R * 0.02)
        flap.lineTo(cx + rx * 0.55, top + R * 0.02)
        flap.quadraticCurveTo(cx + R * 0.1, ry * 0.95, cx, ry * 1.0)
        flap.quadraticCurveTo(cx - R * 0.1, ry * 0.95, cx - rx * 0.55, top + R * 0.02)
        flap.closePath()
        x.fill(flap)
        x.save()
        x.clip(flap)
        x.fillStyle = "rgba(0,0,0,0.12)"
        x.fillRect(-rx * 1.3, top, rx * 2.6, R * 0.06)
        if (!this.isMini) {
          x.fillStyle = "rgba(255,255,255,0.85)"
          x.strokeStyle = "rgba(255,255,255,0.85)"
          x.lineWidth = R * 0.015
          for (let row = 0; row < 3; row++) {
            for (let col = -3; col <= 3; col++) {
              const px = cx + col * R * 0.2 + (row % 2) * R * 0.1
              const py = top + R * 0.13 + row * R * 0.13
              x.beginPath()
              if ((row + col) % 2) x.arc(px, py, R * 0.022, 0, Math.PI * 2)
              else x.ellipse(px, py, R * 0.04, R * 0.025, 0.6, 0, Math.PI * 2)
              if ((row + col) % 2) x.fill()
              else x.stroke()
            }
          }
        }
        x.restore()
      })
    } else {
      const y = ry * 0.6
      const w = R * 0.25
      const h = R * 0.2
      x.translate(cx, y)
      x.rotate(Math.sin(t * 2.5) * 0.04 + this.flutter * Math.sin(t * 12) * 0.2)
      const silk = x.createLinearGradient(0, -h, 0, h)
      silk.addColorStop(0, "#3A3A48")
      silk.addColorStop(1, "#141418")
      x.fillStyle = silk
      for (const sd of [-1, 1]) {
        x.beginPath()
        x.moveTo(0, 0)
        x.quadraticCurveTo(sd * w * 0.5, -h * 0.75, sd * w, -h * 0.5)
        x.quadraticCurveTo(sd * w * 1.12, 0, sd * w, h * 0.5)
        x.quadraticCurveTo(sd * w * 0.5, h * 0.75, 0, 0)
        x.fill()
      }
      x.fillStyle = "#26262E"
      roundRect(x, -R * 0.055, -R * 0.065, R * 0.11, R * 0.13, R * 0.03)
      x.fill()
      x.fillStyle = "rgba(255,255,255,0.2)"
      x.beginPath()
      x.ellipse(-w * 0.55, -h * 0.2, w * 0.25, h * 0.1, -0.3, 0, Math.PI * 2)
      x.fill()
    }
    x.restore()
  }

  private drawBolts(x: CanvasRenderingContext2D, R: number, rx: number) {
    for (const sd of [-1, 1]) {
      const w = R * 0.18
      const h = R * 0.46
      const px = sd * (rx + w * 0.25)
      const g = x.createLinearGradient(px - w / 2, 0, px + w / 2, 0)
      g.addColorStop(0, rgba(mix(this.body, [0, 0, 0], 0.45)))
      g.addColorStop(0.5, rgba(mix(this.body, [0, 0, 0], 0.2)))
      g.addColorStop(1, rgba(mix(this.body, [0, 0, 0], 0.55)))
      x.fillStyle = g
      roundRect(x, px - w / 2, -h / 2, w, h, w * 0.4)
      x.fill()
      x.fillStyle = rgba(this.state === "idle" ? mix(this.body, [1, 1, 1], 0.75) : this.col, 0.95)
      roundRect(x, px - w * 0.18, -h * 0.28, w * 0.36, h * 0.56, w * 0.18)
      x.fill()
    }
  }

  private drawAntenna(x: CanvasRenderingContext2D, R: number, ry: number, length = 1) {
    const baseY = -ry * 0.86
    const len = R * 0.46 * length
    const bend = this.antennaBend
    const tipX = Math.sin(bend) * len
    const tipY = baseY - Math.cos(bend) * len
    x.save()
    x.strokeStyle = rgba(mix(this.body, [0, 0, 0], 0.25))
    x.lineWidth = R * 0.07
    x.lineCap = "round"
    x.beginPath()
    x.moveTo(0, baseY + R * 0.05)
    x.quadraticCurveTo(tipX * 0.2, baseY - len * 0.6, tipX, tipY)
    x.stroke()

    const t = nowS() - this.t0
    const active = this.state === "working" || this.state === "thinking" || this.state === "approval"
    const orbPulse = active ? 1 + Math.sin(t * 6) * 0.14 : 1
    const orbR = R * 0.12 * orbPulse
    const orbColor = this.state === "idle" ? mix(this.body, [1, 1, 1], 0.35) : this.col
    const halo = x.createRadialGradient(tipX, tipY, 0, tipX, tipY, orbR * 3)
    halo.addColorStop(0, rgba(orbColor, this.state === "sleeping" ? 0.15 : 0.55))
    halo.addColorStop(1, rgba(orbColor, 0))
    x.fillStyle = halo
    x.beginPath()
    x.arc(tipX, tipY, orbR * 3, 0, Math.PI * 2)
    x.fill()
    const orb = x.createRadialGradient(tipX - orbR * 0.35, tipY - orbR * 0.35, 0, tipX, tipY, orbR)
    orb.addColorStop(0, rgba(mix(orbColor, [1, 1, 1], 0.7)))
    orb.addColorStop(1, rgba(orbColor))
    x.fillStyle = orb
    x.beginPath()
    x.arc(tipX, tipY, orbR, 0, Math.PI * 2)
    x.fill()
    x.restore()
  }

  private drawBody(x: CanvasRenderingContext2D, body: Path2D, R: number, rx: number, ry: number) {
    const light = mix(this.body, [1, 1, 1], 0.42)
    const dark = mix(this.body, [0, 0, 0], 0.28)
    const g = x.createLinearGradient(rx * 0.6, -ry, -rx * 0.7, ry)
    g.addColorStop(0, rgba(light))
    g.addColorStop(0.5, rgba(this.body))
    g.addColorStop(1, rgba(dark))
    x.fillStyle = g
    x.fill(body)
    if (this.isMini) return

    if (this.tint > 0.01) {
      const tg = x.createLinearGradient(0, ry, 0, -ry * 0.2)
      tg.addColorStop(0, rgba(this.col, 0.75 * this.tint))
      tg.addColorStop(1, rgba(this.col, 0))
      x.fillStyle = tg
      x.fill(body)
    }

    // Subsurface: a warm core so it reads as jelly rather than plastic.
    const core = x.createRadialGradient(0, ry * 0.25, 0, 0, ry * 0.25, R * 0.9)
    core.addColorStop(0, rgba(mix(this.body, [1, 0.95, 0.85], 0.35), 0.45))
    core.addColorStop(1, rgba(this.body, 0))
    x.fillStyle = core
    x.fill(body)

    const rim = x.createRadialGradient(0, 0, R * 0.5, 0, 0, R * 1.3)
    rim.addColorStop(0, "rgba(0,0,0,0)")
    rim.addColorStop(1, "rgba(0,0,0,0.28)")
    x.fillStyle = rim
    x.fill(body)

    const d = this.d
    if (d.screen) {
      x.fillStyle = "rgba(0,0,0,0.28)"
      for (const sd of [-1, 1]) {
        x.beginPath()
        x.arc(sd * rx * 0.16 + rx * 0.45, ry * 0.68, R * 0.045, 0, Math.PI * 2)
        x.fill()
      }
      x.fillStyle = "rgba(0,0,0,0.22)"
      roundRect(x, -rx * 0.6, ry * 0.62, rx * 0.5, R * 0.05, R * 0.025)
      x.fill()
    }

    x.save()
    x.clip(body)
    x.fillStyle = "rgba(255,255,255,0.55)"
    x.beginPath()
    if (d.exp > 3) x.ellipse(-rx * 0.6, -ry * 0.72, R * 0.22, R * 0.07, -0.25, 0, Math.PI * 2)
    else x.ellipse(-rx * 0.42, -ry * 0.5, R * 0.26, R * 0.12, -0.55, 0, Math.PI * 2)
    x.fill()
    x.fillStyle = "rgba(255,255,255,0.7)"
    x.beginPath()
    x.arc(-rx * 0.12, -ry * 0.7, R * 0.045, 0, Math.PI * 2)
    x.fill()
    x.restore()
  }

  private drawFace(x: CanvasRenderingContext2D, body: Path2D, R: number, rx: number, ry: number) {
    const d = this.d
    x.save()
    x.clip(body)

    const faceShift = Math.sin(this.yaw) * rx * 0.75
    if (d.ruff) {
      // Cream lower face with a tuft pointing in from each cheek.
      x.fillStyle = rgba(CREAM, 0.92)
      x.beginPath()
      x.moveTo(-rx * 1.2, ry * 0.08)
      x.quadraticCurveTo(-rx * 0.72, ry * 0.12, -rx * 0.6, ry * 0.34)
      x.quadraticCurveTo(-rx * 0.38, ry * 0.16, faceShift * 0.9, ry * 0.14)
      x.quadraticCurveTo(rx * 0.38, ry * 0.16, rx * 0.6, ry * 0.34)
      x.quadraticCurveTo(rx * 0.72, ry * 0.12, rx * 1.2, ry * 0.08)
      x.lineTo(rx * 1.2, ry * 1.3)
      x.lineTo(-rx * 1.2, ry * 1.3)
      x.closePath()
      x.fill()
    }
    if (d.blush) {
      const blush = Math.max(this.blush, 0.25)
      x.fillStyle = `rgba(255,90,120,${0.4 * blush})`
      for (const sd of [-1, 1]) {
        x.beginPath()
        x.ellipse(sd * rx * 0.56 + faceShift, ry * 0.22, R * 0.15, R * 0.09, 0, 0, Math.PI * 2)
        x.fill()
      }
    }

    const panel = d.screen
      ? { x: -rx * 0.74, y: -ry * 0.66, w: rx * 1.48, h: ry * 1.06, r: R * 0.2 }
      : d.visor
        ? { x: -rx * 0.84, y: -ry * 0.46, w: rx * 1.68, h: ry * 0.62, r: ry * 0.31 }
        : null
    let ink = INK
    if (panel) {
      // Light, warm screens so the face sits well inside an orange body.
      const cream: RGB = [1, 0.97, 0.93]
      const peach = mix(this.body, [1, 1, 1], 0.72)
      const glass = x.createLinearGradient(0, panel.y, 0, panel.y + panel.h)
      if (d.screen) {
        glass.addColorStop(0, rgba(cream))
        glass.addColorStop(1, rgba(mix(this.body, [1, 1, 1], 0.8)))
      } else {
        glass.addColorStop(0, rgba(mix(peach, [1, 1, 1], 0.55)))
        glass.addColorStop(1, rgba(peach))
      }
      x.fillStyle = glass
      roundRect(x, panel.x, panel.y, panel.w, panel.h, panel.r)
      x.fill()
      x.strokeStyle = rgba(mix(this.body, [0, 0, 0], 0.35), 0.55)
      x.lineWidth = R * 0.035
      x.stroke()
      x.clip()
      const inset = x.createLinearGradient(0, panel.y, 0, panel.y + panel.h * 0.35)
      inset.addColorStop(0, rgba(mix(this.body, [0, 0, 0], 0.3), 0.18))
      inset.addColorStop(1, rgba(this.body, 0))
      x.fillStyle = inset
      x.fillRect(panel.x, panel.y, panel.w, panel.h)
      if (d.screen) {
        x.fillStyle = rgba(this.body, 0.08)
        for (let sy = panel.y; sy < panel.y + panel.h; sy += R * 0.06) x.fillRect(panel.x, sy, panel.w, R * 0.02)
      } else {
        x.fillStyle = "rgba(255,255,255,0.55)"
        x.beginPath()
        x.moveTo(panel.x + panel.w * 0.62, panel.y)
        x.lineTo(panel.x + panel.w * 0.72, panel.y)
        x.lineTo(panel.x + panel.w * 0.6, panel.y + panel.h)
        x.lineTo(panel.x + panel.w * 0.5, panel.y + panel.h)
        x.fill()
      }
      if (this.state !== "idle" && this.state !== "sleeping") {
        ink = rgba(mix(this.col, [0.35, 0.1, 0.03], luminance(this.col) > 0.6 ? 0.75 : 0.2))
        x.shadowColor = rgba(this.col, 0.6)
        x.shadowBlur = R * 0.1
      }
    }

    const shape = this.eyeOverride ?? this.cfg.eye
    const lenses: Lens[] = []
    for (const sd of [-1, 1]) {
      const eyeYaw = sd * 0.36 + this.yaw
      let eyePitch = d.eyeY + this.pitch + this.roll
      eyePitch = ((((eyePitch + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI
      const cp = Math.cos(eyePitch)
      if (Math.cos(eyeYaw) * cp <= 0.04) continue
      const ex = Math.sin(eyeYaw) * cp * rx
      const ey = -Math.sin(eyePitch) * ry
      const mult = this.isMini ? 1.7 : 1
      if (d.eyewear) {
        lenses.push({ x: ex, y: ey, sx: Math.max(0.2, Math.cos(eyeYaw)), sy: Math.max(0.2, cp), sd })
        if (OPAQUE_EYEWEAR.has(d.eyewear)) continue
      }
      const w = R * 0.2 * this.es * mult
      const h = R * 0.27 * this.es * mult
      x.save()
      x.translate(ex, ey)
      x.scale(Math.max(0.2, Math.cos(eyeYaw)), Math.max(0.2, cp))
      this.drawEye(x, shape, w, h, sd, ink, !panel, d.screen)
      x.restore()
    }
    if (d.eyewear && lenses.length) this.drawEyewear(x, d.eyewear, lenses, R, rx, shape)

    if (!this.isMini && d.mouth) {
      let mouth = this.mouthOverride ?? this.cfg.mouth
      if (d.ears && mouth === "smile") mouth = "cat"
      if (d.screen && (mouth === "smile" || mouth === "flat")) mouth = "cursor"
      const mPitch = d.mouthY - this.pitch * 0.6 - this.roll
      if (Math.cos(mPitch) > 0.1) {
        x.save()
        x.translate(faceShift * 0.9, Math.sin(mPitch) * ry)
        x.scale(Math.max(0.3, Math.cos(this.yaw)), 1)
        this.drawMouth(x, mouth, R, ink)
        x.restore()
      }
    }
    x.restore()
  }

  private drawEye(
    x: CanvasRenderingContext2D,
    shape: EyeShape,
    w: number,
    h: number,
    sd: number,
    ink: string,
    gloss: boolean,
    pixel: boolean,
  ) {
    const t = nowS()
    x.fillStyle = ink
    x.strokeStyle = ink
    x.lineCap = "round"
    const glossy = (ew: number, eh: number) => {
      const hh = Math.max(eh * this.open, ew * 0.28)
      if (pixel) {
        roundRect(x, -ew * 0.4, -hh / 2, ew * 0.8, hh, ew * 0.12)
        x.fill()
        return
      }
      x.beginPath()
      x.ellipse(0, 0, ew / 2, hh / 2, 0, 0, Math.PI * 2)
      x.fill()
      if (gloss && this.open > 0.5) {
        x.fillStyle = "rgba(255,255,255,0.92)"
        x.beginPath()
        x.arc(-ew * 0.16 - this.yaw * ew * 0.1, -hh * 0.2, ew * 0.2, 0, Math.PI * 2)
        x.fill()
        x.fillStyle = "rgba(255,255,255,0.6)"
        x.beginPath()
        x.arc(ew * 0.14, hh * 0.2, ew * 0.08, 0, Math.PI * 2)
        x.fill()
        x.fillStyle = ink
      }
    }
    switch (shape) {
      case "round":
        glossy(w, h)
        break
      case "wide":
        glossy(w * 1.22, h * 1.18)
        break
      case "dot":
        x.beginPath()
        x.arc(0, 0, w * 0.32, 0, Math.PI * 2)
        x.fill()
        break
      case "happy":
        x.lineWidth = w * 0.42
        x.beginPath()
        x.arc(0, h * 0.2, w * 0.7, Math.PI * 1.15, Math.PI * 1.85)
        x.stroke()
        break
      case "closed":
        x.lineWidth = w * 0.32
        x.beginPath()
        x.arc(0, -h * 0.1, w * 0.62, Math.PI * 0.18, Math.PI * 0.82)
        x.stroke()
        break
      case "flat":
        roundRect(x, -w * 0.62, -w * 0.16, w * 1.24, w * 0.32, w * 0.16)
        x.fill()
        break
      case "line":
        x.rotate(-sd * 0.3)
        roundRect(x, -w * 0.7, -w * 0.17, w * 1.4, w * 0.34, w * 0.17)
        x.fill()
        break
      case "spiral":
        x.lineWidth = w * 0.18
        x.beginPath()
        for (let a = 0; a < 4.4 * Math.PI; a += 0.2) {
          const r = w * 0.05 + a * w * 0.05
          const aa = a + t * 9 * sd
          if (a === 0) x.moveTo(Math.cos(aa) * r, Math.sin(aa) * r)
          else x.lineTo(Math.cos(aa) * r, Math.sin(aa) * r)
        }
        x.stroke()
        break
      case "heart":
        x.fillStyle = HEART
        x.scale(1 + Math.sin(t * 8) * 0.08, 1 + Math.sin(t * 8) * 0.08)
        heart(x, w * 1.1)
        x.fill()
        break
      case "star":
        x.fillStyle = STAR
        x.rotate(t * 1.5 * sd)
        star(x, w * 0.9, w * 0.4)
        x.fill()
        break
      case "wink":
        if (sd < 0) glossy(w, h)
        else {
          x.lineWidth = w * 0.42
          x.beginPath()
          x.arc(0, h * 0.2, w * 0.7, Math.PI * 1.15, Math.PI * 1.85)
          x.stroke()
        }
        break
    }
  }

  private drawMouth(x: CanvasRenderingContext2D, shape: MouthShape, R: number, ink: string) {
    const w = R * 0.22
    x.strokeStyle = ink
    x.fillStyle = ink
    x.lineWidth = R * 0.05
    x.lineCap = "round"
    switch (shape) {
      case "cat":
        x.beginPath()
        x.arc(-w * 0.22, -w * 0.05, w * 0.22, Math.PI * 0.1, Math.PI * 0.95)
        x.moveTo(w * 0.44, 0)
        x.arc(w * 0.22, -w * 0.05, w * 0.22, Math.PI * 0.05, Math.PI * 0.9)
        x.stroke()
        break
      case "cursor":
        if (Math.floor((nowS() - this.t0) * 2) % 2 === 0) {
          roundRect(x, -w * 0.32, -w * 0.08, w * 0.64, w * 0.2, w * 0.04)
          x.fill()
        }
        break
      case "smile":
        x.beginPath()
        x.arc(0, -w * 0.45, w * 0.6, Math.PI * 0.2, Math.PI * 0.8)
        x.stroke()
        break
      case "grin":
        x.beginPath()
        x.moveTo(-w * 0.62, -w * 0.08)
        x.quadraticCurveTo(0, w * 0.1, w * 0.62, -w * 0.08)
        x.quadraticCurveTo(w * 0.5, w * 0.72, 0, w * 0.72)
        x.quadraticCurveTo(-w * 0.5, w * 0.72, -w * 0.62, -w * 0.08)
        x.fill()
        x.fillStyle = BUDDY_PALETTE.coral
        x.beginPath()
        x.ellipse(0, w * 0.5, w * 0.28, w * 0.16, 0, 0, Math.PI * 2)
        x.fill()
        break
      case "flat":
        x.beginPath()
        x.moveTo(-w * 0.35, 0)
        x.lineTo(w * 0.35, 0)
        x.stroke()
        break
      case "o": {
        const s = 1 + Math.sin((nowS() - this.t0) * 4) * 0.08
        x.beginPath()
        x.ellipse(0, w * 0.05, w * 0.22 * s, w * 0.28 * s, 0, 0, Math.PI * 2)
        x.fill()
        break
      }
      case "wavy":
        x.beginPath()
        for (let i = 0; i <= 12; i++) {
          const px = -w * 0.55 + (i / 12) * w * 1.1
          const py = Math.sin(i * 1.4) * w * 0.12
          if (i === 0) x.moveTo(px, py)
          else x.lineTo(px, py)
        }
        x.stroke()
        break
      case "none":
        break
    }
  }

  private drawBadge(x: CanvasRenderingContext2D, R: number, cx: number, cy: number, ry: number) {
    const badge = this.badge
    if (!badge) return
    const t = nowS()
    const bx = cx + R * 0.95 * this.sx * this.scale
    const by = cy - ry * 0.95 * this.sy * this.scale
    x.save()
    x.translate(bx, by)
    x.scale(this.badgeS, this.badgeS)
    const col = rgba(this.col)
    if (badge === "dots") {
      const pw = R * 0.66
      const ph = R * 0.34
      x.fillStyle = "rgba(10,10,12,0.9)"
      roundRect(x, -pw / 2 - 2, -ph / 2 - 2, pw + 4, ph + 4, ph / 2 + 2)
      x.fill()
      x.fillStyle = col
      roundRect(x, -pw / 2, -ph / 2, pw, ph, ph / 2)
      x.fill()
      for (let i = 0; i < 3; i++) {
        const phase = (((t * 2.4 - i * 0.22) % 1) + 1) % 1
        const lift = Math.max(0, Math.sin(phase * Math.PI * 2))
        x.fillStyle = onColor(this.col)
        x.beginPath()
        x.arc((i - 1) * R * 0.17, -lift * R * 0.05, R * 0.05 * (1 + 0.3 * lift), 0, Math.PI * 2)
        x.fill()
      }
    } else {
      const wob = Math.sin(t * 7) * 0.12
      x.rotate(wob)
      x.fillStyle = "rgba(10,10,12,0.9)"
      x.beginPath()
      x.arc(0, 0, R * 0.29, 0, Math.PI * 2)
      x.fill()
      x.fillStyle = col
      x.beginPath()
      x.arc(0, 0, R * 0.23, 0, Math.PI * 2)
      x.fill()
      x.fillStyle = onColor(this.col)
      x.font = `900 ${R * 0.3}px ${FONT}`
      x.textAlign = "center"
      x.textBaseline = "middle"
      x.fillText(badge === "bang" ? "!" : "?", 0, R * 0.02)
    }
    x.restore()
  }

  private drawParticles(x: CanvasRenderingContext2D, R: number, cx: number, cy: number) {
    for (const p of this.particles) {
      if (p.age <= 0) continue
      const k = p.age / p.life
      const alpha = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85
      const px = p.gravity ? cx + p.x * R : cx + (p.x + p.vx * p.age) * R * 1.3
      const py = p.gravity ? cy + p.y * R : cy + (p.y + p.vy * p.age) * R * 1.3
      const size = R * p.size * (p.gravity ? 1 : 1 + k * 0.4)
      x.save()
      x.translate(px, py)
      x.globalAlpha = Math.max(0, Math.min(1, alpha))
      x.rotate(p.rot)
      switch (p.kind) {
        case "heart":
          x.rotate(-p.rot + Math.sin(p.age * 6) * 0.3)
          x.fillStyle = HEART
          heart(x, size)
          x.fill()
          break
        case "star":
          x.fillStyle = STAR
          star(x, size, size * 0.45)
          x.fill()
          break
        case "spark":
          x.fillStyle = "#fff"
          star(x, size * 0.8, size * 0.18)
          x.fill()
          break
        case "confetti": {
          const ray = logoRays()[p.ray]
          // Rays are slivers, so widen them, and flip them through 3D as they
          // tumble like strips of paper.
          const k = size / ray.len
          x.scale(k, k * 2.6 * (Math.abs(Math.cos(p.rot * 0.9)) * 0.75 + 0.25))
          x.rotate(-ray.angle)
          x.translate(-ray.cx, -ray.cy)
          x.fillStyle = p.color
          x.fill(ray.path)
          break
        }
        case "z":
          x.rotate(-p.rot)
          x.fillStyle = "rgb(255,228,204)"
          x.font = `700 ${size * 1.9}px ${FONT}`
          x.textAlign = "center"
          x.textBaseline = "middle"
          x.fillText("z", 0, 0)
          break
      }
      x.restore()
    }
  }
}
