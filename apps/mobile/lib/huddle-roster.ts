// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Who is on the call surface and how to lay them out. Merges what the room
 * knows (mute, camera, hand, connection quality) with what the server knows
 * (names, rung-in people who haven't joined yet), so a tile exists for every
 * person: video when they have a camera, an avatar when they don't.
 *
 * Pure functions, so the ordering and layout rules are easy to test.
 */
import type { HuddleLayout } from './huddle-prefs'
import type { ConnectionQualityLevel, HuddleParticipantState, HuddleVideoTile } from './huddle-room'
import type { Huddle } from './team-chat-api'

export type RosterStatus = 'in-call' | 'ringing' | 'declined' | 'missed'

export interface RosterEntry {
  userId: string
  name: string
  image: string | null
  isLocal: boolean
  status: RosterStatus
  speaking: boolean
  muted: boolean
  cameraOn: boolean
  screenOn: boolean
  quality: ConnectionQualityLevel
  handRaisedAt: number | null
  guest: boolean
  camera: HuddleVideoTile | null
  screen: HuddleVideoTile | null
}

export interface RosterInput {
  /** Live room state (empty before the room connects). */
  participants: HuddleParticipantState[]
  /** The server's view of the huddle: names for people the room hasn't reported, and who is ringing. */
  huddle: Pick<Huddle, 'participants' | 'invited'> | null
  video: HuddleVideoTile[]
  speaking: string[]
  me: string | null
}

/**
 * Everyone involved in the call, in the order they should appear: raised
 * hands first (earliest hand first), then people in the call (you included),
 * then the people still being rung.
 */
export function buildRoster({ participants, huddle, video, speaking, me }: RosterInput): RosterEntry[] {
  const speakingSet = new Set(speaking)
  const entries = new Map<string, RosterEntry>()

  const tilesFor = (userId: string) => ({
    camera: video.find((t) => t.userId === userId && t.source === 'camera') ?? null,
    screen: video.find((t) => t.userId === userId && t.source === 'screen') ?? null,
  })

  for (const p of participants) {
    entries.set(p.userId, {
      userId: p.userId,
      name: p.name,
      image: p.image,
      isLocal: p.isLocal,
      status: 'in-call',
      speaking: p.speaking || speakingSet.has(p.userId),
      muted: p.muted,
      cameraOn: p.cameraOn,
      screenOn: p.screenOn,
      quality: p.quality,
      handRaisedAt: p.handRaisedAt,
      guest: p.guest,
      ...tilesFor(p.userId),
    })
  }

  // Joined on the server but not (yet) visible in the room: still show them.
  for (const p of huddle?.participants ?? []) {
    if (entries.has(p.userId)) continue
    entries.set(p.userId, {
      userId: p.userId,
      name: p.name,
      image: p.image,
      isLocal: p.userId === me,
      status: 'in-call',
      speaking: speakingSet.has(p.userId),
      muted: false,
      cameraOn: false,
      screenOn: false,
      quality: 'unknown',
      handRaisedAt: null,
      guest: !!p.guest,
      ...tilesFor(p.userId),
    })
  }

  const inCall = [...entries.values()]
  const hands = inCall.filter((e) => e.handRaisedAt).sort((a, b) => (a.handRaisedAt ?? 0) - (b.handRaisedAt ?? 0))
  const rest = inCall.filter((e) => !e.handRaisedAt)

  const invited: RosterEntry[] = []
  for (const i of huddle?.invited ?? []) {
    if (entries.has(i.userId)) continue
    invited.push({
      userId: i.userId,
      name: i.name,
      image: i.image,
      isLocal: false,
      status: i.status === 'ringing' ? 'ringing' : i.status === 'declined' ? 'declined' : 'missed',
      speaking: false,
      muted: false,
      cameraOn: false,
      screenOn: false,
      quality: 'unknown',
      handRaisedAt: null,
      guest: false,
      camera: null,
      screen: null,
    })
  }

  return [...hands, ...rest, ...invited]
}

export interface StageModel {
  /** A shared screen takes the stage when there is one. */
  screen: HuddleVideoTile | null
  /** Who is spotlighted (speaker layout, or pinned). Null in grid layout. */
  spotlight: RosterEntry | null
  /** Everyone else, shown as a rail beside or under the main area (or the whole grid when nothing is spotlighted). */
  rail: RosterEntry[]
}

/**
 * Decide what the main area shows. A shared screen wins; otherwise a pinned
 * person, otherwise (speaker layout) the loudest speaker, otherwise a grid.
 */
export function pickStage(roster: RosterEntry[], layout: HuddleLayout, pinned: string | null, speaking: string[]): StageModel {
  const live = roster.filter((e) => e.status === 'in-call')
  const sharer = live.find((e) => e.screen && !e.isLocal) ?? live.find((e) => e.screen)
  if (sharer?.screen) return { screen: sharer.screen, spotlight: null, rail: roster }

  const pinnedEntry = pinned ? live.find((e) => e.userId === pinned) : undefined
  if (pinnedEntry) return { screen: null, spotlight: pinnedEntry, rail: roster.filter((e) => e !== pinnedEntry) }

  if (layout === 'speaker') {
    const loudest = speaking.map((id) => live.find((e) => e.userId === id && !e.isLocal)).find(Boolean)
    const spotlight = loudest ?? live.find((e) => !e.isLocal) ?? live[0] ?? null
    return { screen: null, spotlight, rail: roster.filter((e) => e !== spotlight) }
  }
  return { screen: null, spotlight: null, rail: roster }
}

/** The one person the mini card features: whoever is speaking, else the first other person, else you. */
export function miniFeature(roster: RosterEntry[], speaking: string[], pinned: string | null): RosterEntry | null {
  const live = roster.filter((e) => e.status === 'in-call')
  if (pinned) {
    const p = live.find((e) => e.userId === pinned)
    if (p) return p
  }
  const loudest = speaking.map((id) => live.find((e) => e.userId === id && !e.isLocal)).find(Boolean)
  return loudest ?? live.find((e) => !e.isLocal) ?? live[0] ?? null
}

/** The shared screen the mini card and picture-in-picture show: someone else's first, else your own. */
export function miniScreen(roster: RosterEntry[]): HuddleVideoTile | null {
  const live = roster.filter((e) => e.status === 'in-call')
  return (live.find((e) => e.screen && !e.isLocal) ?? live.find((e) => e.screen))?.screen ?? null
}

/**
 * Your own camera as a small self-view over the mini card, so you see yourself
 * as well as the speaker. Not shown when you're the one featured.
 */
export function miniSelfView(roster: RosterEntry[], feature: RosterEntry | null): HuddleVideoTile | null {
  const me = roster.find((e) => e.isLocal && e.status === 'in-call')
  if (!me || !me.cameraOn || !me.camera || me === feature) return null
  return me.camera
}

/** How many columns a grid of `count` tiles uses so tiles stay near 16:9 and fill the panel. */
export function gridColumns(count: number): number {
  if (count <= 1) return 1
  if (count <= 4) return 2
  if (count <= 9) return 3
  return 4
}

export function qualityIsWeak(q: ConnectionQualityLevel): boolean {
  return q === 'poor' || q === 'lost'
}

/** "Ana, Ben and 2 more" for a short list of names. */
export function summarizeNames(names: string[], max = 2): string {
  if (names.length <= max) return names.length === 2 ? `${names[0]} and ${names[1]}` : names.join(', ')
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`
}
