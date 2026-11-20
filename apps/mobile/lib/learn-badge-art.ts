// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo Learn badge art as an SVG string for `SvgXml`. Same drawing as
 * learn.shogo.ai (src/lib/badges.ts in the learn site); colours use comma
 * hsl() so react-native-svg can parse them.
 */

export interface LearnBadgeSummary {
  id: string
  name: string
  description: string
  icon: string
  hue: number
  earnedAt: string
}

export interface LearnProfileSummary {
  xp: number
  /** Shogo Certified level held (0 = none yet) and its title. */
  certifiedLevel: number
  certifiedTitle: string | null
  /** XP rank: for momentum only, never a certified level. */
  rank: { index: number; name: string; min: number; next: { name: string; min: number } | null }
  streak: { current: number; longest: number }
  lessonsCompleted: number
  coursesCompleted: number
  badgeCount: number
  badgeTotal: number
  badges: LearnBadgeSummary[]
  url: string
}

const ICONS: Record<string, string> = {
  footprints:
    '<path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4M4 13h4"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  crown: '<path d="M11.56 3.27a.5.5 0 0 1 .88 0l2.95 5.6a1 1 0 0 0 1.52.29l4.27-3.66a.5.5 0 0 1 .82.5l-2.83 10.24a1 1 0 0 1-.96.73H5.81a1 1 0 0 1-.96-.73L2.02 6a.5.5 0 0 1 .82-.5l4.27 3.66a1 1 0 0 0 1.52-.29z"/><path d="M5 21h14"/>',
  calendar: '<path d="M8 2v4M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>',
  graduation: '<path d="M21.42 10.92a1 1 0 0 0-.02-1.84L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>',
  award: '<path d="m15.48 12.89 1.52 9.11-5-3-5 3 1.52-9.11"/><circle cx="12" cy="8" r="6"/>',
  blocks: '<rect width="7" height="7" x="14" y="3" rx="1"/><path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3"/>',
  sparkles:
    '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/><path d="M20 3v4M22 5h-4M4 17v2M5 18H3"/>',
}

const hsl = (h: number, s: number, l: number) => `hsl(${((h % 360) + 360) % 360}, ${s}%, ${l}%)`

export function learnBadgeSvg(b: { icon: string; hue: number }, uid: string): string {
  const id = uid.replace(/[^a-zA-Z0-9]/g, '')
  const h = b.hue
  const [c1, c2, c3] = [hsl(h, 85, 70), hsl(h + 25, 75, 52), hsl(h + 40, 70, 40)]
  const icon = ICONS[b.icon] ?? ICONS.sparkles
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 132">
  <defs>
    <linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
    <linearGradient id="r${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c2}"/><stop offset="1" stop-color="${c3}"/></linearGradient>
  </defs>
  <path d="M38 92 L28 128 L44 120 L52 132 L60 96 Z" fill="url(#r${id})"/>
  <path d="M82 92 L92 128 L76 120 L68 132 L60 96 Z" fill="url(#r${id})"/>
  <path d="M60 4 L106 30 L106 82 L60 108 L14 82 L14 30 Z" fill="url(#g${id})"/>
  <path d="M60 14 L97 35 L97 77 L60 98 L23 77 L23 35 Z" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="2"/>
  <path d="M60 4 L106 30 L60 56 L14 30 Z" fill="#ffffff" fill-opacity="0.14"/>
  <g transform="translate(36 32) scale(2)" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icon}</g>
</svg>`
}
