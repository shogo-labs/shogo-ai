// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Hey Shogo" in a huddle: someone says the phrase out loud, and the workspace
 * agent is woken with the last minute of the call so far, then answers in the
 * huddle's chat.
 *
 * The detection lives here, at the one place every transcribed line is stored
 * (`appendStreamFinal` / `appendLiveTranscript`), so it works whichever device
 * or worker produced the line — a person's own browser, a coverer's stream for
 * a phone, the chunk path, or the hidden LiveKit fallback. The fallback's
 * finals reach the API process through `POST /api/internal/huddle-notes/finals`,
 * which is why the hook runs here and not in the job child.
 *
 * A wake is an @mention in everything but how it was typed: a system note in
 * the huddle's chat, then `runAgentReply` as the person who spoke, so the agent
 * acts with their permissions and is billed like their own message.
 */
import { prisma } from '../lib/prisma'
import { liveKitConfig, sendRoomData } from '../lib/livekit'
import { agentMentionToken } from './conversation-mentions'
import { postMessage } from './conversation.service'
import { readTranscript, type TranscriptSegment } from './meeting.service'

const db = prisma as any

/** One wake per speaker inside this window; a repeated sentence doesn't re-run the agent. */
export const WAKE_SPEAKER_COOLDOWN_MS = 30_000
/** One wake per huddle inside this window, across pods, which also absorbs a `c:` + `lk:` duplicate. */
export const WAKE_HUDDLE_COOLDOWN_MS = 10_000
/** A call can wake the agent this many times; after that the strip says so. */
export const WAKE_MAX_PER_HUDDLE = 20
/** How much of the call the agent gets, clamped so a bad env var can't ask for an hour. */
export const WAKE_CONTEXT_DEFAULT_SECONDS = 60
export const WAKE_CONTEXT_MIN_SECONDS = 15
export const WAKE_CONTEXT_MAX_SECONDS = 300
/** Topic the call listens on for the "Shogo is on it" indicator. */
export const HUDDLE_WAKE_TOPIC = 'shogo.huddle'

/** Greetings that may start the phrase. */
const GREETINGS = new Set(['hey', 'hi', 'ok', 'okay'])
/** "shogo" as one word, including what a recognizer tends to write instead. */
const SHOGO_WORDS = new Set(['shogo', 'showgo', 'shogoh'])
/** …and as two, when the recognizer splits it. */
const SHOGO_SPLIT = new Set(['show go', 'sho go'])

/** How much of the call to hand the agent, from `HUDDLE_WAKE_CONTEXT_SECONDS`. */
export function wakeContextSeconds(): number {
  const raw = Number(process.env.HUDDLE_WAKE_CONTEXT_SECONDS)
  if (!Number.isFinite(raw) || raw <= 0) return WAKE_CONTEXT_DEFAULT_SECONDS
  return Math.min(WAKE_CONTEXT_MAX_SECONDS, Math.max(WAKE_CONTEXT_MIN_SECONDS, Math.round(raw)))
}

export interface WakePhraseMatch {
  /** What was said after the phrase; may be empty ("hey Shogo" … pause … "make a card"). */
  request: string
}

interface Word {
  /** Lowercased, punctuation stripped. */
  word: string
  start: number
  end: number
}

function words(text: string): Word[] {
  const out: Word[] = []
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    out.push({ word: match[0].toLowerCase(), start: match.index ?? 0, end: (match.index ?? 0) + match[0].length })
  }
  return out
}

/**
 * Find the wake phrase anywhere in a line: "hey shogo", "Hey, Shogo!", "hey
 * show go", "so hey shogo can you…", "okay shogo". Not "shogo is great" (no
 * greeting), "hey shogun", "they show going" or "hey showgoers" (the word after
 * the greeting isn't the phrase). Returns what follows it, which the caller may
 * have to join with the speaker's next line.
 */
export function matchWakePhrase(text: string): WakePhraseMatch | null {
  const list = words(text)
  for (let i = 0; i < list.length; i++) {
    if (!GREETINGS.has(list[i].word)) continue
    let after: Word | null = null
    const one = list[i + 1]
    if (one && SHOGO_WORDS.has(one.word)) after = one
    if (!after && one && list[i + 2] && SHOGO_SPLIT.has(`${one.word} ${list[i + 2].word}`)) after = list[i + 2]
    if (!after) continue
    return { request: text.slice(after.end).replace(/^[\s,.;:!?—–-]+/, '').trim() }
  }
  return null
}

/** Why a line that said the phrase woke nothing. */
export type WakeSkipReason =
  | 'guest'
  | 'left'
  | 'notes_off'
  | 'no_chat'
  | 'speaker_cooldown'
  | 'huddle_cooldown'
  | 'limit'
  | 'duplicate'

export interface WakeDecisionInput {
  isGuest: boolean
  /** Still has an open `HuddleParticipant` row for this call. */
  inCall: boolean
  notesEnabled: boolean
  /** `getHuddleChat` resolved: they can read and write the call's chat. */
  canChat: boolean
  /** This speaker's last wake, ms since epoch. */
  speakerLastWakeAt: number | null
  /** The huddle's last wake (`Huddle.lastWakeAt`), ms since epoch. */
  huddleLastWakeAt: number | null
  /** Wakes this call has already started. */
  wakeCount: number
  now: number
}

export type WakeDecision = { wake: true } | { wake: false; reason: WakeSkipReason }

/**
 * Every rule from the card, in one pure decision: who may wake, how often, and
 * how many times per call. The huddle-wide cooldown is only *checked* here —
 * the caller claims it with a compare-and-set, which is what makes it hold
 * across two API pods.
 */
export function decideWake(input: WakeDecisionInput): WakeDecision {
  if (input.isGuest) return { wake: false, reason: 'guest' }
  if (!input.inCall) return { wake: false, reason: 'left' }
  if (!input.notesEnabled) return { wake: false, reason: 'notes_off' }
  if (!input.canChat) return { wake: false, reason: 'no_chat' }
  if (input.wakeCount >= WAKE_MAX_PER_HUDDLE) return { wake: false, reason: 'limit' }
  if (input.speakerLastWakeAt !== null && input.now - input.speakerLastWakeAt < WAKE_SPEAKER_COOLDOWN_MS) {
    return { wake: false, reason: 'speaker_cooldown' }
  }
  if (input.huddleLastWakeAt !== null && input.now - input.huddleLastWakeAt < WAKE_HUDDLE_COOLDOWN_MS) {
    return { wake: false, reason: 'huddle_cooldown' }
  }
  return { wake: true }
}

/** One line of the transcript the agent reads. */
export interface WakeContextLine {
  speaker: string
  start: number
  text: string
}

/**
 * The last `seconds` of the call, ending at `until` (call time), with a speaker
 * name on every line. Long lines are trimmed so a three-minute monologue can't
 * crowd out everyone else.
 */
export function wakeContext(
  segments: readonly TranscriptSegment[],
  until: number,
  seconds: number,
  options: { maxChars?: number } = {},
): WakeContextLine[] {
  const from = Math.max(0, until - seconds)
  const maxChars = options.maxChars ?? 8_000
  const lines: WakeContextLine[] = []
  let used = 0
  for (const segment of segments) {
    const end = segment.end ?? segment.start
    if (end < from || segment.start > until) continue
    const text = String(segment.text ?? '').trim()
    if (!text) continue
    const speaker = String(segment.speaker ?? '').trim() || 'Someone'
    if (used + text.length > maxChars) break
    used += text.length
    lines.push({ speaker, start: segment.start, text })
  }
  return lines
}

/** Who was in the call when it was woken, for the note. */
function participantLine(names: string[], guests: number): string {
  const people = [...names]
  if (guests > 0) people.push(guests === 1 ? 'Guest' : `${guests} guests`)
  return people.length ? people.join(', ') : 'nobody else'
}

export interface StoredFinal {
  meetingId: string
  huddleId: string
  itemId: string
  segment: TranscriptSegment
  speakerId?: string | null
  speaker?: string | null
}

/**
 * A speaker's phrase with too few words after it waits for their next line:
 * "hey Shogo" … pause … "make a card for the login bug". Held in memory per
 * speaker; a pod that dies loses one request, which is cheaper than a pending
 * wake nobody can cancel.
 */
const pendingRequests = new Map<string, { speaker: string; request: string; until: number }>()
export const WAKE_REQUEST_JOIN_MS = 4_000

/**
 * Called by the meeting service the moment a final is **stored** — never for a
 * replayed or de-duplicated one, so nothing here can wake twice for one line.
 * Fire-and-forget: a wake must never fail the write that triggered it.
 */
export function onHuddleFinalStored(final: StoredFinal): void {
  void handleStoredFinal(final).catch((err: Error) => {
    console.warn(`[HuddleWake] ${final.huddleId}: ${err.message}`)
  })
}

async function handleStoredFinal(final: StoredFinal): Promise<void> {
  const speakerId = final.speakerId?.trim()
  if (!speakerId) return
  const text = String(final.segment.text ?? '').trim()
  if (!text) return

  const match = matchWakePhrase(text)
  const pendingKey = `${final.huddleId}:${speakerId}`
  const pending = pendingRequests.get(pendingKey)
  if (pending && pending.until >= Date.now()) {
    // This speaker's next line finishes a request that was too short on its own.
    pendingRequests.delete(pendingKey)
    await wake({ final, speakerId, request: [pending.request, match?.request ?? text].filter(Boolean).join(' ') })
    return
  }
  if (!match) return
  const requestWords = match.request.split(/\s+/).filter(Boolean)
  if (requestWords.length < 3) {
    // "hey Shogo" on its own: give them a moment to say what they want.
    pendingRequests.set(pendingKey, { speaker: speakerId, request: match.request, until: Date.now() + WAKE_REQUEST_JOIN_MS })
    return
  }
  await wake({ final, speakerId, request: match.request })
}

async function wake(input: { final: StoredFinal; speakerId: string; request: string }): Promise<void> {
  const { final, speakerId, request } = input
  const now = Date.now()
  const row = await db.huddle.findUnique({ where: { id: final.huddleId } })
  if (!row || row.endedAt) return

  const guest = speakerId.startsWith('guest_')
  if (guest) {
    // A guest's words are captioned and transcribed like anyone's; they just
    // can't start an agent run.
    console.log(`[HuddleWake] wake_ignored reason=guest huddle=${final.huddleId}`)
    return
  }

  const [participant, participantRows, wakes] = await Promise.all([
    db.huddleParticipant.findFirst({ where: { huddleId: final.huddleId, userId: speakerId, leftAt: null }, select: { id: true } }),
    db.huddleParticipant.findMany({ where: { huddleId: final.huddleId, leftAt: null }, select: { userId: true } }),
    db.huddleWake.findMany({ where: { huddleId: final.huddleId }, select: { speakerId: true, createdAt: true } }),
  ])
  const speakerWakes = wakes.filter((w: any) => w.speakerId === speakerId)
  const speakerLastWakeAt = speakerWakes.length
    ? Math.max(...speakerWakes.map((w: any) => new Date(w.createdAt).getTime()))
    : null

  // The chat check is the permissions check: exactly the people who may read and
  // write the call's chat may wake the agent from it.
  let canChat = false
  try {
    const { getHuddleChat } = await import('./huddle.service')
    canChat = (await getHuddleChat(row.conversationId, speakerId)) !== null
  } catch {
    canChat = false
  }

  const decision = decideWake({
    isGuest: guest,
    inCall: !!participant,
    notesEnabled: row.notesEnabled !== false,
    canChat,
    speakerLastWakeAt,
    huddleLastWakeAt: row.lastWakeAt ? new Date(row.lastWakeAt).getTime() : null,
    wakeCount: wakes.length,
    now,
  })
  if (!decision.wake) {
    console.log(`[HuddleWake] wake_ignored reason=${decision.reason} huddle=${final.huddleId}`)
    // The phrase that reaches the cap is the one that tells the call, so "hey
    // Shogo" going quiet does not look like a broken agent. Later ones say nothing.
    if (decision.reason === 'limit' && wakes.length === WAKE_MAX_PER_HUDDLE) {
      void sendWakeStatus(row, { by: String(final.speaker ?? '').trim() || 'someone', status: 'limit' })
    }
    return
  }

  // Claim the huddle cooldown across pods: whoever moves `lastWakeAt` owns this
  // wake. A `c:` + `lk:` duplicate of one utterance lands here too, and loses.
  const cutoff = new Date(now - WAKE_HUDDLE_COOLDOWN_MS)
  const claimed = await db.huddle.updateMany({
    where: { id: final.huddleId, endedAt: null, OR: [{ lastWakeAt: null }, { lastWakeAt: { lt: cutoff } }] },
    data: { lastWakeAt: new Date(now) },
  })
  if (!claimed.count) {
    console.log(`[HuddleWake] wake_ignored reason=huddle_cooldown huddle=${final.huddleId}`)
    return
  }

  // One row per (huddle, transcript item): a replayed final can never be a
  // second wake, whatever else happens.
  let wakeRow: any = null
  try {
    wakeRow = await db.huddleWake.create({
      data: { huddleId: final.huddleId, speakerId, itemId: final.itemId, status: 'running' },
    })
  } catch {
    console.log(`[HuddleWake] wake_ignored reason=duplicate huddle=${final.huddleId}`)
    return
  }

  const speakerName = String(final.speaker ?? '').trim() || 'someone'
  const seconds = wakeContextSeconds()
  const until = final.segment.end ?? final.segment.start
  const meeting = await db.meeting.findUnique({ where: { id: final.meetingId }, select: { transcript: true } })
  const transcript = readTranscript(meeting?.transcript) ?? { text: '', segments: [] }
  const context = wakeContext(transcript.segments, until, seconds)
  const others = participantRows.map((p: any) => p.userId).filter((id: string) => id !== speakerId)
  const guestCount = others.filter((id: string) => id.startsWith('guest_')).length
  const people = await personNames(row.workspaceId, others.filter((id: string) => !id.startsWith('guest_')))
  const roomLine = participantLine(people, guestCount)

  const transcriptText = context.length
    ? context.map((line) => `**${line.speaker}:** ${line.text}`).join('\n')
    : `(nothing was transcribed in the last ${seconds} seconds)`
  const text = [
    `${agentMentionToken(null)} ${speakerName} woke Shogo in the huddle: "${request.slice(0, 500)}"`,
    '',
    `Last ${seconds} s of the call:`,
    transcriptText,
    '',
    `In the call: ${roomLine}`,
  ].join('\n')

  const target = { projectId: null }
  let posted: any = null
  try {
    const { chat, members } = await resolveWakeChat(row, speakerId)
    if (!chat) throw new Error('no chat for this huddle')
    posted = await postMessage({
      conversationId: chat.conversationId,
      threadRootId: chat.threadRootId,
      authorType: 'system',
      text,
      blocks: {
        huddleWake: {
          huddleId: final.huddleId,
          meetingId: final.meetingId,
          speakerId,
          speakerName,
          request,
          contextSeconds: seconds,
          participants: members,
          transcript: context.map((line) => ({ speaker: line.speaker, start: line.start, text: line.text })),
        },
      },
    })
  } catch (err) {
    await db.huddleWake.update({ where: { id: wakeRow.id }, data: { status: 'failed', reason: 'no_chat' } }).catch(() => {})
    console.warn(`[HuddleWake] could not post the wake note: ${(err as Error).message}`)
    return
  }

  await db.huddleWake.update({ where: { id: wakeRow.id }, data: { messageId: posted.row.id } }).catch(() => {})
  void sendWakeStatus(row, { by: speakerName, messageId: posted.row.id, status: 'running' })

  const { runAgentReply } = await import('./conversation-agent-dispatcher')
  void runAgentReply({
    conversation: posted.conversation,
    trigger: posted.row,
    target,
    userId: speakerId,
    // A DM or group DM huddle shows top-level messages in the call's chat panel,
    // so the answer must not be nested under this note.
    threadRootId: posted.row.threadRootId ?? null,
  })
    .then(async () => {
      await db.huddleWake.update({ where: { id: wakeRow.id }, data: { status: 'replied' } }).catch(() => {})
      void sendWakeStatus(row, { by: speakerName, messageId: posted.row.id, status: 'replied' })
    })
    .catch(async (err: Error) => {
      await db.huddleWake.update({ where: { id: wakeRow.id }, data: { status: 'failed', reason: err.message.slice(0, 300) } }).catch(() => {})
      void sendWakeStatus(row, { by: speakerName, messageId: posted.row.id, status: 'failed', reason: err.message.slice(0, 140) })
    })
  console.log(`[HuddleWake] woke the workspace agent for ${speakerId} in ${final.huddleId}`)
}

/**
 * Where the wake note goes: the same place the call's chat panel reads. Reuses
 * the huddle's own chat resolution, so a channel keeps its thread and a DM or
 * group DM posts at the top level.
 */
async function resolveWakeChat(row: any, speakerId: string): Promise<{ chat: { conversationId: string; threadRootId: string | null } | null; members: string[] }> {
  const { getHuddleChat } = await import('./huddle.service')
  const chat = await getHuddleChat(row.conversationId, speakerId)
  if (!chat) return { chat: null, members: [] }
  const participants: { userId: string }[] = await db.huddleParticipant.findMany({
    where: { huddleId: row.id, leftAt: null },
    select: { userId: true },
  })
  // A DM or group DM has no thread for the call's panel to show; a channel keeps
  // the huddle's own thread under its start message.
  const direct = chat.kind === 'dm' || chat.kind === 'group_dm'
  return {
    chat: { conversationId: chat.conversationId, threadRootId: direct ? null : chat.threadRootId },
    members: participants.map((p) => p.userId),
  }
}

async function personNames(workspaceId: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return []
  const rows: { userId: string; user?: { name?: string | null; email?: string | null } | null }[] = await db.member.findMany({
    where: { workspaceId, projectId: null, userId: { in: ids } },
    select: { userId: true, user: { select: { name: true, email: true } } },
  })
  const byId = new Map(rows.map((row) => [row.userId, row.user?.name || row.user?.email || 'Someone']))
  return ids.map((id) => byId.get(id) ?? 'Someone')
}

/** Tell the call what the agent is doing; guests and phones get this without the chat bus. */
async function sendWakeStatus(
  row: any,
  payload: { by: string; status: 'running' | 'replied' | 'failed' | 'limit'; messageId?: string; reason?: string },
): Promise<void> {
  const config = liveKitConfig()
  if (!config || !row?.roomName) return
  await sendRoomData(config, row.roomName, HUDDLE_WAKE_TOPIC, { type: 'wake', ...payload })
}

export function _resetHuddleWakeForTests(): void {
  pendingRequests.clear()
}
