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
  type HuddleDevice,
  type HuddleDeviceKind,
  type HuddleMedia,
  type HuddleParticipantState,
  type HuddleReactionEvent,
  type HuddleVideoTile,
} from './huddle-media'
import {
  getHuddlePrefs,
  setHuddlePrefs,
  type BackgroundEffect,
  type HuddleLayout,
  type HuddleViewMode,
} from './huddle-prefs'
import { getHuddleAppBridge, type DesktopHuddleCommand } from './desktop-huddle'
import { startHuddleNotes, type HuddleNotesEngine, type NotesMode, type NotesPeer } from './huddle-notes'
import { captionsReducer, type CaptionEvent, type CaptionLine } from './huddle-captions'
import type { HuddleWakeNotice } from './huddle-room'
import { toWsBase } from './live-stream'
import { API_URL } from './api'
import { huddleJoinLink } from './team-chat-links'
import { teamChatApi, type ConversationKind, type TeamChatEvent } from './team-chat-api'

export { huddleMediaSupported, huddleVideoSupported, screenShareSupported }
export type { HuddleVideoTile, HuddleParticipantState, HuddleReactionEvent, HuddleDevice, HuddleDeviceKind }

/** How long a reaction floats over the call. */
export const REACTION_LIFETIME_MS = 4_200
/** Reactions kept on screen at once, so a flood can't bury the video. */
const MAX_REACTIONS = 24
/** Least time between your own reactions. */
const REACTION_COOLDOWN_MS = 250

/** A join waiting on the pre-join preview (device check, camera, join muted). */
export interface PendingHuddleJoin {
  conversationId: string
  workspaceId: string
  label: string
  kind: ConversationKind | null
}

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
  /** Everyone in the room with mute, camera, connection quality and raised-hand state. */
  participants: HuddleParticipantState[]
  /** Reactions floating over the call right now, oldest first. */
  reactions: HuddleReactionEvent[]
  handRaised: boolean
  /** Which surface the call is in: full panel, floating mini card, or pill. */
  view: HuddleViewMode
  layout: HuddleLayout
  /** The person (user id) spotlighted on the stage, or null to follow the speaker. */
  pinned: string | null
  /** The pre-join preview is open for this huddle. */
  pending: PendingHuddleJoin | null
  /** A soft failure (a camera effect, a device switch) that doesn't end the call. */
  notice: string | null
  /** Set when you're in as an outside guest let in through a huddle link. */
  guest: { requestId: string; name: string } | null
  /**
   * Notes (transcript + summary): the call-wide toggle, and what this device is
   * doing about it. `mode` is `unsupported` on a phone, which a web or desktop
   * participant covers.
   */
  notes: { enabled: boolean; mode: NotesMode; message: string | null; covering: string[] }
  /**
   * Live captions: the notes transcript as it is being written, from whoever
   * transcribed each speaker. Oldest first; the strip shows the newest.
   */
  captions: CaptionLine[]
  /**
   * The workspace agent, woken by "hey Shogo": who said it and what it is doing.
   * Cleared a few seconds after it answers, or when the call ends.
   */
  wake: HuddleWakeNotice | null
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
  participants: [],
  reactions: [],
  handRaised: false,
  view: 'mini',
  layout: 'grid',
  pinned: null,
  pending: null,
  notice: null,
  guest: null,
  notes: { enabled: true, mode: 'off', message: null, covering: [] },
  captions: [],
  wake: null,
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

/** For code outside React (the native call screen) that reacts to every change of the call. */
export function subscribeHuddleCall(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// ─── Desktop: the call lives in the huddle window ───────────────────────────

/**
 * On desktop the room runs in its own always-on-top window. Here, the app
 * window only mirrors the call's state and sends it commands; `video` stays
 * empty because tracks can't cross windows.
 */
function remote() {
  return getHuddleAppBridge()
}

/** Whether this window shows a call that a separate huddle window is running. */
export function isHuddleHostedElsewhere(): boolean {
  return remote() !== null
}

function sendRemote(command: DesktopHuddleCommand): boolean {
  const bridge = remote()
  if (!bridge) return false
  bridge.command(command)
  return true
}

function applyRemoteSnapshot(snapshot: Record<string, unknown>): void {
  const { ended: _ended, video: _video, pending: _pending, ...rest } = snapshot as Partial<HuddleCallState> & { ended?: boolean }
  if (rest.status === 'idle') {
    set({ ...IDLE, view: state.view, layout: state.layout, error: rest.error ?? null, pending: state.pending })
    return
  }
  set({ ...rest, video: [] })
}

let remoteSubscribed = false
function subscribeRemote(): void {
  const bridge = remote()
  if (!bridge || remoteSubscribed) return
  remoteSubscribed = true
  bridge.onState(applyRemoteSnapshot)
}
subscribeRemote()

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

// ─── Notes: every participant's audio goes through the meeting pipeline ─────

/** What this device is streaming notes through, or null when notes are off. */
let notesEngine: HuddleNotesEngine | null = null

/** Which client this is: a phone can't tap PCM, so it tells the room it needs covering. */
function notesClientKind(): 'web' | 'native' {
  return Platform.OS === 'web' ? 'web' : 'native'
}

/** What the coverer decision sees: who is here, who streams, who needs covering. */
function notesPeers(): NotesPeer[] {
  return state.participants.map((p) => ({
    userId: p.userId,
    present: true,
    self: p.notesSelf,
    needsCover: p.notesNeedsCover,
  }))
}

/**
 * Start this device's notes stream, once the room has told us who we are and
 * the call's toggle is on. Every participant runs this; the engine decides
 * whether this one streams its own audio, covers a phone, or does nothing.
 */
function ensureNotesEngine(): void {
  if (notesEngine || state.status === 'idle' || !state.conversationId) return
  if (!state.notes.enabled) return
  const selfId = state.participants.find((p) => p.isLocal)?.userId
  // The first roster event carries our own id; until then there is nobody to stream.
  if (!selfId) return
  const conversationId = state.conversationId
  const guest = state.guest
  const gen = generation
  const engine = startHuddleNotes({
    selfId,
    wsBase: toWsBase(API_URL),
    ticket: async (forUserId) =>
      guest
        ? teamChatApi().guestHuddleNotesTicket(guest.requestId)
        : teamChatApi().huddleNotesTicket(conversationId, { forUserId, client: notesClientKind() }),
    postChunk: async (forUserId, chunk) => {
      if (guest) return teamChatApi().guestHuddleNotesChunk(guest.requestId, chunk)
      return teamChatApi().postHuddleNotesChunk(conversationId, chunk, { forUserId, client: notesClientKind() })
    },
    getLocalStream: () => media?.localMicStream?.() ?? null,
    getRemoteStreams: () => media?.remoteAudioStreams?.() ?? [],
    getPeers: notesPeers,
    isMuted: (forUserId) => media?.micMuted?.(forUserId ?? selfId) === true,
    publishCaption: (line) => publishCaption(line),
    setSource: async (source) => {
      await media?.setNotesSource?.(source)
    },
    onStatus: (notes) => {
      if (gen !== generation || notesEngine !== engine) return
      set({ notes: { ...state.notes, ...notes } })
    },
  })
  notesEngine = engine
  engine.sync()
}

/** Recompute the streams after the roster, the mic or the toggle changed. */
function syncNotes(): void {
  if (!state.notes.enabled) {
    void stopNotes()
    return
  }
  ensureNotesEngine()
  notesEngine?.sync()
}

async function stopNotes(): Promise<void> {
  const engine = notesEngine
  notesEngine = null
  // Nothing is transcribed any more, so nothing is captioned either.
  clearCaptions()
  await engine?.stop({ discard: true }).catch(() => {})
}

/**
 * Turn notes on or off for the rest of the call. Any participant may: everyone
 * is told who did it, and the streams stop within a second or two.
 */
export async function setHuddleNotesEnabled(enabled: boolean): Promise<void> {
  const { conversationId, workspaceId } = state
  if (!conversationId) return
  if (state.notes.enabled === enabled) return
  set({ notes: { ...state.notes, enabled } })
  if (!enabled) void stopNotes()
  try {
    const huddle = await teamChatApi().setHuddleNotes(conversationId, enabled)
    if (huddle && workspaceId) setConversationHuddle(workspaceId, conversationId, huddle)
    if (enabled) syncNotes()
  } catch (err) {
    set({ notes: { ...state.notes, enabled: !enabled }, notice: errorMessage(err, 'Could not change notes') })
    if (!enabled) syncNotes()
  }
}

/** Follow the toggle when it comes from the server (someone else flipped it). */
function applyNotesState(enabled: boolean): void {
  if (state.notes.enabled === enabled) return
  set({ notes: { ...state.notes, enabled } })
  if (enabled) syncNotes()
  else void stopNotes()
}

/** Someone turned notes on or off: say who, so nobody is transcribed without knowing. */
export function applyHuddleNotesEvent(event: { conversationId: string; enabled: boolean; name: string }): void {
  if (!state.conversationId || event.conversationId !== state.conversationId) return
  const mine = event.name === state.participants.find((p) => p.isLocal)?.name
  if (!mine) {
    set({ notice: event.enabled ? `Notes on (${event.name})` : `Notes off (${event.name}): nothing is being written down` })
  }
  applyNotesState(event.enabled)
}

// ─── Captions: the notes transcript, live ───────────────────────────────────

/** Recent lines the store keeps; each surface shows as many as fit on it. */
const CAPTION_STORE_LINES = 12

/** While any line is up, one tick a second drops the ones already read. */
let captionTimer: ReturnType<typeof setInterval> | null = null

function clearCaptionTimer(): void {
  if (captionTimer) clearInterval(captionTimer)
  captionTimer = null
}

function reduceCaptions(event: CaptionEvent): void {
  const next = captionsReducer({ lines: state.captions }, event, { window: CAPTION_STORE_LINES })
  if (next.lines === state.captions) return
  set({ captions: next.lines })
  if (!next.lines.length) clearCaptionTimer()
  else if (!captionTimer) captionTimer = setInterval(() => reduceCaptions({ type: 'expire', now: Date.now() }), 1_000)
}

/** A caption arrived from the room, or this device published one. */
function pushCaption(line: CaptionLine): void {
  reduceCaptions({ type: line.final ? 'final' : 'partial', itemId: line.itemId, speakerId: line.speakerId, text: line.text, at: line.at, start: line.start })
}

/** Hand one line to the room, for a speaker this device transcribes. */
function publishCaption(line: { itemId: string; speakerId: string; text: string; final: boolean; start?: number }): void {
  if (!state.notes.enabled) return
  void media?.publishCaption?.(line).catch(() => {})
}

/** Notes are off (or the call is over): the strip goes with them. */
function clearCaptions(): void {
  clearCaptionTimer()
  if (state.captions.length) set({ captions: [] })
}

/** How long "Shogo replied in chat" stays up once the agent is done. */
const WAKE_NOTICE_LINGER_MS = 5_000
let wakeNoticeTimer: ReturnType<typeof setTimeout> | null = null

function clearWakeNoticeTimer(): void {
  if (wakeNoticeTimer) clearTimeout(wakeNoticeTimer)
  wakeNoticeTimer = null
}

/** The server said what the agent is doing: running, answered, couldn't — or the call is out of wakes. */
function applyHuddleWake(notice: HuddleWakeNotice): void {
  clearWakeNoticeTimer()
  set({ wake: notice })
  // Hitting the cap is a fact about the rest of the call, not a passing status, so it stays.
  if (notice.status === 'running' || notice.status === 'limit') return
  wakeNoticeTimer = setTimeout(() => {
    wakeNoticeTimer = null
    set({ wake: null })
  }, WAKE_NOTICE_LINGER_MS)
}

async function teardown(conversationId: string | null, workspaceId: string | null, guest: HuddleCallState['guest'] = null): Promise<void> {
  clearNoAnswer()
  clearCaptionTimer()
  clearWakeNoticeTimer()
  await stopNotes()
  const current = media
  media = null
  await current?.disconnect().catch(() => {})
  if (guest) {
    await teamChatApi().leaveHuddleAsGuest(guest.requestId).catch(() => {})
    return
  }
  if (!conversationId) return
  const huddle = await teamChatApi().leaveHuddle(conversationId).catch(() => undefined)
  if (huddle !== undefined && workspaceId) setConversationHuddle(workspaceId, conversationId, huddle)
}

export interface JoinHuddleInput {
  conversationId: string
  workspaceId: string
  label: string
  kind?: ConversationKind | null
  /** From the pre-join preview: come in muted, or with the camera on. */
  startMuted?: boolean
  startCamera?: boolean
}

/**
 * Start a join from a button. Opens the pre-join preview first (device check,
 * camera, join muted) for channel huddles when the person hasn't turned that
 * off; a 1:1 call or an answered ring is always one tap, so those call
 * `joinHuddleCall` directly.
 */
export function requestHuddleJoin(input: JoinHuddleInput): Promise<void> {
  const wantsPreview = huddleVideoSupported && getHuddlePrefs().previewBeforeJoin && input.kind !== 'dm'
  const joined = state.conversationId === input.conversationId && state.status !== 'idle'
  if (!wantsPreview || joined) return joinHuddleCall(input)
  set({
    pending: { conversationId: input.conversationId, workspaceId: input.workspaceId, label: input.label, kind: input.kind ?? null },
  })
  return Promise.resolve()
}

export function cancelPendingHuddleJoin(): void {
  if (state.pending) set({ pending: null })
}

function resetFor(patch: Partial<HuddleCallState>): HuddleCallState {
  const prefs = getHuddlePrefs()
  return { ...IDLE, view: prefs.view, layout: prefs.layout, ...patch }
}

/** The room's callbacks, ignored once the call they belong to has ended. */
function callHandlers(gen: number) {
  return {
    onSpeakers: (speaking: string[]) => gen === generation && set({ speaking }),
    onConnection: (status: HuddleCallStatus) => gen === generation && set({ status }),
    onPlaybackBlocked: (playbackBlocked: boolean) => gen === generation && set({ playbackBlocked }),
    onVideo: (video: HuddleVideoTile[]) => gen === generation && set({ video }),
    onLocalMedia: ({ camera, screen, muted }: { camera: boolean; screen: boolean; muted?: boolean }) => {
      if (gen !== generation) return
      set({ camera, screen, ...(muted === undefined ? {} : { muted }) })
      // The mic just published (or went away): that is when notes can start.
      syncNotes()
    },
    onParticipants: (participants: HuddleParticipantState[]) => {
      if (gen !== generation) return
      const me = participants.find((p) => p.isLocal)
      set({ participants, handRaised: !!me?.handRaisedAt })
      // Roster changes decide who streams and who covers a phone.
      syncNotes()
    },
    onReaction: (reaction: HuddleReactionEvent) => gen === generation && addReaction(reaction),
    onCaption: (line: CaptionLine) => {
      if (gen !== generation) return
      pushCaption(line)
    },
    onHuddleWake: (notice: HuddleWakeNotice) => {
      if (gen !== generation) return
      applyHuddleWake(notice)
    },
    onDevicesChanged: () => gen === generation && deviceListeners.forEach((l) => l()),
    onError: (message: string) => gen === generation && set({ notice: message }),
  }
}

export async function joinHuddleCall(input: JoinHuddleInput): Promise<void> {
  if (state.conversationId === input.conversationId && state.status !== 'idle') return
  const bridge = remote()
  if (bridge) {
    subscribeRemote()
    set(resetFor({ status: 'joining', conversationId: input.conversationId, workspaceId: input.workspaceId, label: input.label, kind: input.kind ?? null, muted: !!input.startMuted }))
    const opened = await bridge.open({
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      label: input.label,
      kind: input.kind ?? null,
      startMuted: input.startMuted,
      startCamera: input.startCamera,
    })
    if (!opened.ok) set({ ...IDLE, error: opened.error ?? 'Could not open the huddle window' })
    return
  }
  if (!huddleMediaSupported) {
    set({ ...IDLE, error: 'Huddles are available on web and desktop for now' })
    return
  }
  if (state.status !== 'idle') await leaveHuddleCall()

  const gen = ++generation
  const prefs = getHuddlePrefs()
  set(
    resetFor({
      status: 'joining',
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      label: input.label,
      kind: input.kind ?? null,
      muted: !!input.startMuted,
    }),
  )
  try {
    const joined = await teamChatApi().joinHuddle(input.conversationId)
    if (gen !== generation) {
      void teamChatApi().leaveHuddle(input.conversationId).catch(() => {})
      return
    }
    setConversationHuddle(input.workspaceId, input.conversationId, joined.huddle)
    const connected = await connectHuddleMedia(joined.url, joined.token, {
      ...callHandlers(gen),
      onDropped: (reason) => {
        if (gen !== generation) return
        generation++
        media = null
        lastDropped = { conversationId: input.conversationId, at: Date.now() }
        void teardown(input.conversationId, input.workspaceId)
        set({ ...IDLE, error: reason })
      },
    }, {
      startMuted: input.startMuted,
      startCamera: input.startCamera,
      micId: prefs.micId,
      cameraId: prefs.cameraId,
      speakerId: prefs.speakerId,
      effects: { background: prefs.background, autoFraming: prefs.autoFraming, lowLight: prefs.lowLight },
    })
    if (gen !== generation) {
      await connected.disconnect().catch(() => {})
      return
    }
    media = connected
    set({
      status: 'connected',
      notes: {
        ...state.notes,
        enabled: joined.huddle.notes?.enabled !== false,
        message: joined.huddle.notes?.unavailableReason ?? null,
      },
    })
    syncNotes()
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

export interface GuestHuddleInput {
  /** The LiveKit token and server the host's admission handed over. */
  token: string
  url: string
  requestId: string
  name: string
}

/**
 * Enter a huddle as an outside guest, with the token the host's admission
 * produced. A guest is in the call and nothing else: no conversation, no roster
 * of invited people, no chat. Web only, since it runs in the browser tab that
 * the link opened.
 */
export async function joinHuddleAsGuest(input: GuestHuddleInput & { startMuted?: boolean; startCamera?: boolean }): Promise<void> {
  if (!huddleMediaSupported || remote()) {
    set({ ...IDLE, error: 'Open this link in your browser to join as a guest' })
    return
  }
  if (state.status !== 'idle') await leaveHuddleCall()
  const gen = ++generation
  const prefs = getHuddlePrefs()
  const guest = { requestId: input.requestId, name: input.name }
  set(resetFor({ status: 'joining', label: 'Huddle', view: 'expanded', muted: !!input.startMuted, guest }))
  try {
    const connected = await connectHuddleMedia(input.url, input.token, {
      ...callHandlers(gen),
      onDropped: (reason) => {
        if (gen !== generation) return
        generation++
        media = null
        void teardown(null, null, guest)
        set({ ...IDLE, error: reason })
      },
    }, {
      startMuted: input.startMuted,
      startCamera: input.startCamera,
      micId: prefs.micId,
      cameraId: prefs.cameraId,
      speakerId: prefs.speakerId,
      effects: { background: prefs.background, autoFraming: prefs.autoFraming, lowLight: prefs.lowLight },
    })
    if (gen !== generation) {
      await connected.disconnect().catch(() => {})
      return
    }
    media = connected
    set({ status: 'connected' })
    syncNotes()
  } catch (err) {
    if (gen !== generation) return
    generation++
    await teardown(null, null, guest)
    set({ ...IDLE, error: errorMessage(err, 'Could not join the huddle') })
  }
}

export async function leaveHuddleCall(): Promise<void> {
  if (state.status === 'idle') return
  if (sendRemote({ type: 'leave' })) {
    set({ ...IDLE, view: state.view, layout: state.layout })
    return
  }
  generation++
  const { conversationId, workspaceId, guest } = state
  set({ ...IDLE })
  await teardown(conversationId, workspaceId, guest)
}

export async function setHuddleMuted(muted: boolean): Promise<void> {
  if (sendRemote({ type: 'mute', muted })) return set({ muted })
  if (!media) return
  set({ muted })
  try {
    await media.setMuted(muted)
  } catch (err) {
    set({ muted: !muted, error: errorMessage(err, 'Could not change your microphone') })
  }
}

export async function setHuddleCamera(on: boolean): Promise<void> {
  if (sendRemote({ type: 'camera', on })) return set({ camera: on })
  if (!media) return
  set({ camera: on })
  try {
    await media.setCamera(on)
  } catch (err) {
    set({ camera: false, error: errorMessage(err, 'Could not start your camera') })
  }
}

export async function setHuddleScreenShare(on: boolean): Promise<void> {
  if (sendRemote({ type: 'screen', on })) return set({ screen: on })
  if (!media) return
  set({ screen: on })
  try {
    await media.setScreenShare(on)
  } catch (err) {
    set({ screen: false, error: errorMessage(err, 'Could not share your screen') })
  }
}

// ─── Reactions and raised hands ──────────────────────────────────────────────

const reactionTimers = new Map<string, ReturnType<typeof setTimeout>>()
let lastReactionAt = 0

function addReaction(reaction: HuddleReactionEvent): void {
  const next = [...state.reactions, reaction].slice(-MAX_REACTIONS)
  set({ reactions: next })
  reactionTimers.set(
    reaction.id,
    setTimeout(() => {
      reactionTimers.delete(reaction.id)
      set({ reactions: state.reactions.filter((r) => r.id !== reaction.id) })
    }, REACTION_LIFETIME_MS),
  )
}

/** Send an emoji to everyone in the call. Quick repeats are dropped so holding a key can't flood the room. */
export async function sendHuddleReaction(emoji: string): Promise<void> {
  const now = Date.now()
  if (now - lastReactionAt < REACTION_COOLDOWN_MS) return
  if (state.status === 'idle') return
  if (remote()) {
    lastReactionAt = now
    sendRemote({ type: 'reaction', emoji })
    return
  }
  if (!media?.sendReaction) return
  lastReactionAt = now
  try {
    await media.sendReaction(emoji)
  } catch {
    set({ notice: 'Could not send your reaction' })
  }
}

export async function setHuddleHand(raised: boolean): Promise<void> {
  if (sendRemote({ type: 'hand', raised })) return set({ handRaised: raised })
  if (!media?.setHandRaised) return
  set({ handRaised: raised })
  try {
    await media.setHandRaised(raised)
  } catch {
    set({ handRaised: !raised, notice: 'Could not change your hand' })
  }
}

// ─── View, layout, pinning ───────────────────────────────────────────────────

/** Move the call between the full panel, the floating card, and the pill. Remembered on this device. */
export function setHuddleView(view: HuddleViewMode): void {
  if (state.view !== view) set({ view })
  if (sendRemote({ type: 'view', view })) return
  setHuddlePrefs({ view })
}

export function setHuddleLayout(layout: HuddleLayout): void {
  if (state.layout !== layout) set({ layout })
  if (sendRemote({ type: 'layout', layout })) return
  setHuddlePrefs({ layout })
}

/** Spotlight a person on the stage; pass null (or the same person again) to follow whoever speaks. */
export function pinHuddleParticipant(userId: string | null): void {
  const next = state.pinned === userId ? null : userId
  set({ pinned: next })
  sendRemote({ type: 'pin', userId: next })
}

export function clearHuddleNotice(): void {
  if (state.notice) set({ notice: null })
}

// ─── Inviting people ─────────────────────────────────────────────────────────

/** Ring more people into this call. They join the huddle, not the conversation it is in. */
export async function inviteToHuddleCall(userIds: string[]): Promise<void> {
  const { conversationId, workspaceId } = state
  if (!conversationId || !workspaceId || state.status === 'idle') throw new Error('Join the huddle first')
  const huddle = await teamChatApi().inviteToHuddle(conversationId, userIds)
  setConversationHuddle(workspaceId, conversationId, huddle)
}

export async function cancelHuddleCallInvite(userId: string): Promise<void> {
  const { conversationId, workspaceId } = state
  if (!conversationId || !workspaceId || state.status === 'idle') return
  const huddle = await teamChatApi().cancelHuddleInvite(conversationId, userId)
  if (huddle !== undefined) setConversationHuddle(workspaceId, conversationId, huddle)
}

// ─── Devices and camera effects ──────────────────────────────────────────────

const deviceListeners = new Set<() => void>()

/** Hear about mics, cameras and speakers being plugged in or removed during the call. */
export function onHuddleDevicesChanged(listener: () => void): () => void {
  deviceListeners.add(listener)
  return () => {
    deviceListeners.delete(listener)
  }
}

export async function listHuddleDevices(kind: HuddleDeviceKind): Promise<HuddleDevice[]> {
  return (await media?.listDevices?.(kind)) ?? []
}

export function activeHuddleDevice(kind: HuddleDeviceKind): string | undefined {
  return media?.getActiveDevice?.(kind)
}

/** Switch mic, camera or speaker now and remember the choice for next time. */
export async function switchHuddleDevice(kind: HuddleDeviceKind, id: string): Promise<void> {
  const key = kind === 'audioinput' ? 'micId' : kind === 'videoinput' ? 'cameraId' : 'speakerId'
  setHuddlePrefs({ [key]: id })
  if (!media?.switchDevice) return
  try {
    await media.switchDevice(kind, id)
  } catch (err) {
    set({ notice: errorMessage(err, 'Could not switch devices') })
  }
}

function applyEffectsNow(): void {
  const prefs = getHuddlePrefs()
  void media?.setCameraEffects?.({ background: prefs.background, autoFraming: prefs.autoFraming, lowLight: prefs.lowLight })
}

/** Blur or replace your background. Remembered, and reapplied whenever the camera turns on. */
export function setHuddleBackground(background: BackgroundEffect): void {
  setHuddlePrefs({ background })
  applyEffectsNow()
}

export function setHuddleAutoFraming(on: boolean): void {
  setHuddlePrefs({ autoFraming: on })
  applyEffectsNow()
}

export function setHuddleLowLight(on: boolean): void {
  setHuddlePrefs({ lowLight: on })
  applyEffectsNow()
}

// ─── Moderation ──────────────────────────────────────────────────────────────

/** Mute someone else's mic (they can unmute themselves). Allowed for whoever started the huddle and workspace admins. */
export async function muteHuddleParticipant(userId: string): Promise<void> {
  const { conversationId } = state
  if (!conversationId) return
  try {
    await teamChatApi().muteHuddleParticipant(conversationId, userId)
  } catch (err) {
    set({ notice: errorMessage(err, 'Could not mute them') })
  }
}

export async function removeHuddleParticipant(userId: string): Promise<void> {
  const { conversationId } = state
  if (!conversationId) return
  try {
    await teamChatApi().removeHuddleParticipant(conversationId, userId)
  } catch (err) {
    set({ notice: errorMessage(err, 'Could not remove them') })
  }
}

/** Let someone who knocked into the call. */
export async function admitHuddleRequest(requestId: string): Promise<void> {
  const { conversationId } = state
  if (!conversationId) return
  try {
    await teamChatApi().admitHuddleRequest(conversationId, requestId)
  } catch (err) {
    set({ notice: errorMessage(err, 'Could not let them in') })
  }
}

export async function denyHuddleRequest(requestId: string): Promise<void> {
  const { conversationId } = state
  if (!conversationId) return
  try {
    await teamChatApi().denyHuddleRequest(conversationId, requestId)
  } catch (err) {
    set({ notice: errorMessage(err, 'Could not decline their request') })
  }
}

/** The full shareable link for this huddle, or null when it can't be made. */
export async function getHuddleShareLink(): Promise<string | null> {
  const { conversationId } = state
  if (!conversationId) return null
  try {
    const { token } = await teamChatApi().huddleLink(conversationId)
    return huddleJoinLink(token)
  } catch (err) {
    set({ notice: errorMessage(err, 'Could not make a link') })
    return null
  }
}

export function resumeHuddlePlayback(): void {
  if (sendRemote({ type: 'resume-playback' })) return
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
  // The huddle window sees the same events and handles the hang-up itself.
  if (remote()) return
  // Someone turned notes on or off: stop our streams at once, or start them again.
  if (event.type === 'huddle.notes') {
    applyHuddleNotesEvent(event)
    return
  }
  if (event.type === 'huddle.updated') {
    if (!state.conversationId || event.conversationId !== state.conversationId) return
    applyNotesState(event.huddle?.notes?.enabled !== false)
    return
  }
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
    // A call hosted in the huddle window outlives the app window that started it.
    if (remote()) return
    if (state.guest && state.status !== 'idle') teamChatApi().leaveHuddleAsGuestOnUnload(state.guest.requestId)
    else if (state.conversationId && state.status !== 'idle') teamChatApi().leaveHuddleOnUnload(state.conversationId)
  })
}


// ─── Huddle window (desktop host) ────────────────────────────────────────────

/** Everything the app window mirrors: the whole call state except live video tracks, which can't leave this window. */
export function snapshotForApp(): Omit<HuddleCallState, 'video'> {
  const { video: _video, ...rest } = state
  return rest
}

/** Run a command sent by the app window. Called only in the huddle window. */
export function runRemoteCommand(command: DesktopHuddleCommand): void {
  switch (command.type) {
    case 'leave':
      void leaveHuddleCall()
      break
    case 'mute':
      void setHuddleMuted(command.muted)
      break
    case 'camera':
      void setHuddleCamera(command.on)
      break
    case 'screen':
      void setHuddleScreenShare(command.on)
      break
    case 'reaction':
      void sendHuddleReaction(command.emoji)
      break
    case 'hand':
      void setHuddleHand(command.raised)
      break
    case 'view':
      setHuddleView(command.view)
      break
    case 'layout':
      setHuddleLayout(command.layout)
      break
    case 'pin':
      set({ pinned: command.userId })
      break
    case 'resume-playback':
      resumeHuddlePlayback()
      break
  }
}
