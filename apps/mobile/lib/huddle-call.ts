// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The huddle you are in, app-wide. At most one at a time: joining another
 * leaves the current one first. The call keeps running while you move around
 * the app; `HuddleDock` shows it outside its conversation.
 */
import { useSyncExternalStore } from 'react'
import { Platform } from 'react-native'
import { getConversationHuddle, setConversationHuddle, tapHuddleEvents } from '../hooks/useHuddles'
import {
  connectHuddleMedia,
  huddleMediaSupported,
  huddleVideoSupported,
  screenShareSupported,
  type HuddleMedia,
  type HuddleVideoTile,
} from './huddle-media'
import { teamChatApi, type ConversationKind, type TeamChatEvent } from './team-chat-api'

export { huddleMediaSupported, huddleVideoSupported, screenShareSupported }
export type { HuddleVideoTile }

/** How long a 1:1 call rings before the caller gives up. */
export const NO_ANSWER_MS = 45_000

export type HuddleCallStatus = 'idle' | 'joining' | 'connected' | 'reconnecting'

export interface HuddleCallState {
  status: HuddleCallStatus
  conversationId: string | null
  workspaceId: string | null
  /** Conversation title, for the dock. */
  label: string | null
  kind: ConversationKind | null
  muted: boolean
  camera: boolean
  screen: boolean
  /** Camera and screen tracks in the call, ours included. */
  video: HuddleVideoTile[]
  /** User ids speaking right now. */
  speaking: string[]
  playbackBlocked: boolean
  error: string | null
}

const IDLE: HuddleCallState = {
  status: 'idle',
  conversationId: null,
  workspaceId: null,
  label: null,
  kind: null,
  muted: false,
  camera: false,
  screen: false,
  video: [],
  speaking: [],
  playbackBlocked: false,
  error: null,
}

let state: HuddleCallState = IDLE
let media: HuddleMedia | null = null
let noAnswerTimer: ReturnType<typeof setTimeout> | null = null
/** Bumped on every join/leave so a slow join that was abandoned can't resurrect itself. */
let generation = 0
const listeners = new Set<() => void>()

function set(patch: Partial<HuddleCallState>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getHuddleCall(): HuddleCallState {
  return state
}

export function useHuddleCall(): HuddleCallState {
  return useSyncExternalStore(subscribe, getHuddleCall, getHuddleCall)
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

function clearNoAnswer() {
  if (noAnswerTimer) clearTimeout(noAnswerTimer)
  noAnswerTimer = null
}

function aloneInCall(): boolean {
  if (!state.conversationId || !state.workspaceId) return false
  const huddle = getConversationHuddle(state.workspaceId, state.conversationId)
  return !huddle || huddle.participants.length <= 1
}

/** The call LiveKit last dropped us from, so a decline that lands just after can still explain it. */
let lastDropped: { conversationId: string; at: number } | null = null

async function teardown(conversationId: string | null, workspaceId: string | null): Promise<void> {
  clearNoAnswer()
  const current = media
  media = null
  await current?.disconnect().catch(() => {})
  if (!conversationId) return
  const huddle = await teamChatApi().leaveHuddle(conversationId).catch(() => undefined)
  if (huddle !== undefined && workspaceId) setConversationHuddle(workspaceId, conversationId, huddle)
}

export async function joinHuddleCall(input: {
  conversationId: string
  workspaceId: string
  label: string
  kind?: ConversationKind | null
}): Promise<void> {
  if (state.conversationId === input.conversationId && state.status !== 'idle') return
  if (!huddleMediaSupported) {
    set({ ...IDLE, error: 'Huddles are available on web and desktop for now' })
    return
  }
  if (state.status !== 'idle') await leaveHuddleCall()

  const gen = ++generation
  set({
    ...IDLE,
    status: 'joining',
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    label: input.label,
    kind: input.kind ?? null,
  })
  try {
    const joined = await teamChatApi().joinHuddle(input.conversationId)
    if (gen !== generation) {
      void teamChatApi().leaveHuddle(input.conversationId).catch(() => {})
      return
    }
    setConversationHuddle(input.workspaceId, input.conversationId, joined.huddle)
    const connected = await connectHuddleMedia(joined.url, joined.token, {
      onSpeakers: (speaking) => gen === generation && set({ speaking }),
      onConnection: (status) => gen === generation && set({ status }),
      onPlaybackBlocked: (playbackBlocked) => gen === generation && set({ playbackBlocked }),
      onVideo: (video) => gen === generation && set({ video }),
      onLocalMedia: ({ camera, screen }) => gen === generation && set({ camera, screen }),
      onDropped: (reason) => {
        if (gen !== generation) return
        generation++
        media = null
        lastDropped = { conversationId: input.conversationId, at: Date.now() }
        void teardown(input.conversationId, input.workspaceId)
        set({ ...IDLE, error: reason })
      },
    })
    if (gen !== generation) {
      await connected.disconnect().catch(() => {})
      return
    }
    media = connected
    set({ status: 'connected' })
    if (input.kind === 'dm' && joined.huddle.participants.length === 1) {
      noAnswerTimer = setTimeout(() => {
        noAnswerTimer = null
        if (gen !== generation || !aloneInCall()) return
        void leaveHuddleCall().then(() => set({ error: 'No answer' }))
      }, NO_ANSWER_MS)
    }
  } catch (err) {
    if (gen !== generation) return
    generation++
    await teardown(input.conversationId, input.workspaceId)
    set({ ...IDLE, error: errorMessage(err, 'Could not join the huddle') })
  }
}

export async function leaveHuddleCall(): Promise<void> {
  if (state.status === 'idle') return
  generation++
  const { conversationId, workspaceId } = state
  set({ ...IDLE })
  await teardown(conversationId, workspaceId)
}

export async function setHuddleMuted(muted: boolean): Promise<void> {
  if (!media) return
  set({ muted })
  try {
    await media.setMuted(muted)
  } catch (err) {
    set({ muted: !muted, error: errorMessage(err, 'Could not change your microphone') })
  }
}

export async function setHuddleCamera(on: boolean): Promise<void> {
  if (!media) return
  set({ camera: on })
  try {
    await media.setCamera(on)
  } catch (err) {
    set({ camera: false, error: errorMessage(err, 'Could not start your camera') })
  }
}

export async function setHuddleScreenShare(on: boolean): Promise<void> {
  if (!media) return
  set({ screen: on })
  try {
    await media.setScreenShare(on)
  } catch (err) {
    set({ screen: false, error: errorMessage(err, 'Could not share your screen') })
  }
}

export function resumeHuddlePlayback(): void {
  void media?.resumePlayback().catch(() => {})
}

export function clearHuddleError(): void {
  if (state.error) set({ error: null })
}

/**
 * The person you rang in a 1:1 DM turned it down: hang up and say so. You
 * can't decline a huddle you're in, so a decline is always someone else's.
 */
export function applyCallEvent(event: TeamChatEvent): void {
  if (event.type !== 'huddle.declined') return
  if (state.status === 'idle') {
    if (lastDropped?.conversationId === event.conversationId && Date.now() - lastDropped.at < 5_000) set({ error: `${event.name} declined` })
    return
  }
  if (state.conversationId !== event.conversationId || state.kind !== 'dm') return
  if (!aloneInCall()) return
  void leaveHuddleCall().then(() => set({ error: `${event.name} declined` }))
}

tapHuddleEvents(applyCallEvent)

if (Platform.OS === 'web' && typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (state.conversationId && state.status !== 'idle') teamChatApi().leaveHuddleOnUnload(state.conversationId)
  })
}
