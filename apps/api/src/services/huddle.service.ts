// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Huddles: live audio calls in a channel or DM. LiveKit carries the media;
 * this module owns who may join, the roster, and the lifecycle, and announces
 * changes as `huddle.updated` events on the conversation bus.
 *
 * The roster is driven by explicit join/leave calls, corrected by LiveKit
 * webhooks (crashed tabs, lost networks) and by asking LiveKit who is really
 * connected before handing out a room. A huddle ends when its last person
 * leaves.
 *
 * Starting one in a DM rings the other people (`huddle.ring`, plus a push when
 * they're away); they can join or decline.
 */

import { randomUUID } from 'crypto'
import { prisma } from '../lib/prisma'
import { publishConversationEvent } from '../lib/conversation-bus'
import { routeToHomeRegion } from '../lib/home-region-route'
import { deleteRoom, liveKitConfig, listRoomIdentities, mintJoinToken, receiveWebhook } from '../lib/livekit'
import { sendPushToUser } from '../lib/push-notifications'
import { getSettingsRows, isSilenced } from './chat-settings'
import { getPresence } from './conversation-presence'
import {
  ConversationError,
  conversationAudience,
  loadAccess,
  postMessage,
  requirePost,
  updateMessageInternal,
} from './conversation.service'

const db = prisma as any

/** People who joined this recently may still be connecting, so LiveKit not listing them yet is expected. */
const CONNECT_GRACE_MS = 60_000
const RECONCILE_INTERVAL_MS = 30_000
/** How long a DM huddle keeps ringing the people who haven't joined. Clients use the same window. */
const RING_WINDOW_MS = 45_000

type PushSender = (userId: string, payload: Parameters<typeof sendPushToUser>[1]) => Promise<void>
let sendPush: PushSender = sendPushToUser

function isDirect(kind: string): boolean {
  return kind === 'dm' || kind === 'group_dm'
}

export interface HuddleParticipantView {
  userId: string
  name: string
  image: string | null
  joinedAt: string
}

export interface HuddleView {
  id: string
  conversationId: string
  workspaceId: string
  startedById: string
  startedAt: string
  participants: HuddleParticipantView[]
}

export interface HuddleJoin {
  huddle: HuddleView
  token: string
  url: string
}

export type LiveKitEventName = 'participant_joined' | 'participant_left' | 'participant_connection_aborted' | 'room_finished'

export interface HuddleLiveKitEvent {
  event: LiveKitEventName
  roomName: string
  identity?: string | null
}

export function huddleRoomName(workspaceId: string, huddleId: string): string {
  return `hd_${workspaceId}_${huddleId}`
}

/** The workspace a huddle room belongs to, so webhooks can be routed to its home region. */
export function workspaceIdFromRoomName(roomName: string): string | null {
  return /^hd_([^_]+)_[^_]+$/.exec(roomName)?.[1] ?? null
}

const OPEN_PARTICIPANTS = { where: { leftAt: null }, orderBy: { joinedAt: 'asc' } } as const

function activeHuddleRow(conversationId: string) {
  return db.huddle.findUnique({ where: { activeKey: conversationId }, include: { participants: OPEN_PARTICIPANTS } })
}

async function serialize(row: any): Promise<HuddleView> {
  const byUser = new Map<string, any>()
  for (const p of row.participants ?? []) if (!byUser.has(p.userId)) byUser.set(p.userId, p)
  const users = byUser.size
    ? await db.user.findMany({ where: { id: { in: [...byUser.keys()] } }, select: { id: true, name: true, email: true, image: true } })
    : []
  const userById = new Map<string, any>(users.map((u: any) => [u.id, u]))
  return {
    id: row.id,
    conversationId: row.conversationId,
    workspaceId: row.workspaceId,
    startedById: row.startedById,
    startedAt: new Date(row.startedAt).toISOString(),
    participants: [...byUser.values()].map((p) => {
      const user = userById.get(p.userId)
      return {
        userId: p.userId,
        name: user?.name || user?.email || 'Someone',
        image: user?.image ?? null,
        joinedAt: new Date(p.joinedAt).toISOString(),
      }
    }),
  }
}

async function announce(conversationId: string): Promise<HuddleView | null> {
  const conversation = await db.conversation.findUnique({ where: { id: conversationId } })
  if (!conversation) return null
  const row = await activeHuddleRow(conversationId)
  const huddle = row ? await serialize(row) : null
  const audience = await conversationAudience(conversation)
  publishConversationEvent(conversation.workspaceId, { type: 'huddle.updated', conversationId, huddle }, audience)
  return huddle
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'less than a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

async function postStartMessage(huddle: any): Promise<void> {
  try {
    const result = await postMessage({
      conversationId: huddle.conversationId,
      authorType: 'system',
      text: `<@u:${huddle.startedById}> started a huddle`,
      blocks: { huddle: { id: huddle.id, status: 'live', startedById: huddle.startedById } },
    })
    await db.huddle.update({ where: { id: huddle.id }, data: { messageId: result.row.id } })
  } catch (err) {
    console.error('[Huddles] start message failed:', (err as Error).message)
  }
}

async function finishStartMessage(huddle: any, endedAt: Date): Promise<void> {
  if (!huddle.messageId) return
  const stays = await db.huddleParticipant.findMany({ where: { huddleId: huddle.id }, select: { userId: true } })
  const participantIds = [...new Set<string>(stays.map((s: any) => s.userId))]
  const durationMs = endedAt.getTime() - new Date(huddle.startedAt).getTime()
  const conversation = await db.conversation.findUnique({ where: { id: huddle.conversationId }, select: { kind: true } })
  const missed = !!conversation && isDirect(conversation.kind) && participantIds.every((id) => id === huddle.startedById)
  try {
    await updateMessageInternal(huddle.messageId, missed
      ? {
          text: `Missed huddle from <@u:${huddle.startedById}>`,
          blocks: { huddle: { id: huddle.id, status: 'missed', startedById: huddle.startedById, durationMs, participantIds } },
        }
      : {
          text: `<@u:${huddle.startedById}> started a huddle · lasted ${formatDuration(durationMs)}`,
          blocks: { huddle: { id: huddle.id, status: 'ended', startedById: huddle.startedById, durationMs, participantIds } },
        })
  } catch (err) {
    console.error('[Huddles] end message failed:', (err as Error).message)
  }
}

/** End a huddle. Safe to call more than once; only the first call does anything. */
async function endHuddle(huddleId: string): Promise<boolean> {
  const endedAt = new Date()
  const { count } = await db.huddle.updateMany({ where: { id: huddleId, endedAt: null }, data: { endedAt, activeKey: null } })
  if (!count) return false
  await db.huddleParticipant.updateMany({ where: { huddleId, leftAt: null }, data: { leftAt: endedAt } })
  const huddle = await db.huddle.findUnique({ where: { id: huddleId } })
  if (huddle) {
    const config = liveKitConfig()
    if (config) void deleteRoom(config, huddle.roomName)
    await finishStartMessage(huddle, endedAt)
    await announce(huddle.conversationId)
  }
  return true
}

/**
 * Ring the other people in a DM when a huddle starts there: an incoming-call
 * prompt on every open app, and a push for anyone not active right now.
 * Muted conversations and Do Not Disturb don't ring.
 */
async function ringMembers(huddle: any, conversation: any, callerId: string): Promise<void> {
  if (!isDirect(conversation.kind)) return
  try {
    const members = await db.conversationMember.findMany({
      where: { conversationId: conversation.id, memberType: 'user', userId: { not: callerId } },
      select: { userId: true, muted: true },
    })
    const candidates: string[] = members.filter((m: any) => m.userId && !m.muted).map((m: any) => m.userId as string)
    if (!candidates.length) return
    const settings = await getSettingsRows(conversation.workspaceId, candidates)
    const now = new Date()
    const targets = candidates.filter((id) => !isSilenced(settings.get(id), now))
    if (!targets.length) return

    const caller = await db.user.findUnique({ where: { id: callerId }, select: { name: true, email: true, image: true } })
    const from = { userId: callerId, name: caller?.name || caller?.email || 'Someone', image: caller?.image ?? null }
    publishConversationEvent(
      conversation.workspaceId,
      { type: 'huddle.ring', conversationId: conversation.id, conversationKind: conversation.kind, huddleId: huddle.id, from },
      targets,
    )

    const presence = await getPresence(conversation.workspaceId, targets)
    const body = conversation.kind === 'dm' ? 'is calling you' : 'started a huddle with you'
    for (const userId of targets) {
      if (presence[userId] === 'active') continue
      void sendPush(userId, {
        title: from.name,
        body,
        type: 'huddle-ring',
        channelId: 'messages',
        audience: 'chat',
        data: { conversationId: conversation.id, workspaceId: conversation.workspaceId, huddleId: huddle.id },
      })
    }
  } catch (err) {
    console.error('[Huddles] ring failed:', (err as Error).message)
  }
}

async function endIfEmpty(huddleId: string): Promise<boolean> {
  const open = await db.huddleParticipant.count({ where: { huddleId, leftAt: null } })
  return open === 0 ? endHuddle(huddleId) : false
}

async function closeStays(huddleId: string, userId: string): Promise<number> {
  const { count } = await db.huddleParticipant.updateMany({ where: { huddleId, userId, leftAt: null }, data: { leftAt: new Date() } })
  return count
}

const lastReconciled = new Map<string, number>()

/**
 * Drop roster entries LiveKit no longer has (closed tabs, dead networks whose
 * webhook was missed) and end the huddle if nobody is left. Throttled per huddle.
 */
async function reconcile(row: any): Promise<void> {
  const config = liveKitConfig()
  if (!config) return
  const now = Date.now()
  if (now - (lastReconciled.get(row.id) ?? 0) < RECONCILE_INTERVAL_MS) return
  lastReconciled.set(row.id, now)
  if (lastReconciled.size > 1000) lastReconciled.clear()

  const live = await listRoomIdentities(config, row.roomName)
  if (!live) return
  const stale = (row.participants ?? []).filter(
    (p: any) => !live.has(p.userId) && now - new Date(p.joinedAt).getTime() > CONNECT_GRACE_MS,
  )
  if (!stale.length) return
  await db.huddleParticipant.updateMany({
    where: { id: { in: stale.map((p: any) => p.id) }, leftAt: null },
    data: { leftAt: new Date() },
  })
  if (!(await endIfEmpty(row.id))) await announce(row.conversationId)
}

function assertHuddleable(conversation: any, userMemberCount: number): void {
  if (conversation.kind === 'activity') throw new ConversationError(400, 'huddle_unavailable', 'Huddles are not available in #activity')
  if (conversation.provider && conversation.provider !== 'shogo') {
    throw new ConversationError(400, 'huddle_unavailable', 'Huddles are not available in mirrored channels')
  }
  if ((conversation.kind === 'dm' || conversation.kind === 'group_dm') && userMemberCount < 2) {
    throw new ConversationError(400, 'huddle_unavailable', 'Huddles need at least one other person')
  }
}

export async function getHuddle(conversationId: string, userId: string): Promise<HuddleView | null> {
  await loadAccess(conversationId, userId)
  let row = await activeHuddleRow(conversationId)
  if (!row) return null
  await reconcile(row)
  row = await activeHuddleRow(conversationId)
  return row ? serialize(row) : null
}

export interface ActiveHuddleView extends HuddleView {
  conversationKind: string
  /** A DM huddle that started moments ago without you: still ringing, for apps that missed the ring event. */
  ringing: boolean
}

/** Live huddles in conversations this person can see, for sidebar indicators and catching up on rings. */
export async function listActiveHuddles(workspaceId: string, userId: string): Promise<ActiveHuddleView[]> {
  const rows = await db.huddle.findMany({
    where: {
      workspaceId,
      activeKey: { not: null },
      conversation: {
        OR: [{ kind: { in: ['public', 'activity'] } }, { members: { some: { userId } } }],
      },
    },
    include: { participants: OPEN_PARTICIPANTS, conversation: { select: { kind: true } } },
    orderBy: { startedAt: 'asc' },
    take: 200,
  })
  const now = Date.now()
  return Promise.all(rows.map(async (row: any) => {
    const view = await serialize(row)
    const ringing =
      isDirect(row.conversation.kind) &&
      row.startedById !== userId &&
      now - new Date(row.startedAt).getTime() < RING_WINDOW_MS &&
      !view.participants.some((p) => p.userId === userId) &&
      view.participants.some((p) => p.userId === row.startedById)
    return { ...view, conversationKind: row.conversation.kind, ringing }
  }))
}

/** Join (starting one if none is live) and get a LiveKit token for the room. */
export async function joinHuddle(conversationId: string, userId: string): Promise<HuddleJoin> {
  const config = liveKitConfig()
  if (!config) throw new ConversationError(400, 'huddles_disabled', 'Huddles are not set up on this server')
  const access = await requirePost(conversationId, userId)
  const conversation = access.conversation
  const userMembers = await db.conversationMember.count({ where: { conversationId, memberType: 'user' } })
  assertHuddleable(conversation, userMembers)

  // The last person can leave between our read and our insert, ending the
  // huddle under us; go round again and start a fresh one.
  for (let attempt = 0; attempt < 3; attempt++) {
    let row = await activeHuddleRow(conversationId)
    let started = false
    if (row) {
      await reconcile(row)
      row = await activeHuddleRow(conversationId)
    }
    if (!row) {
      const id = randomUUID()
      try {
        await db.huddle.create({
          data: {
            id,
            workspaceId: conversation.workspaceId,
            conversationId,
            activeKey: conversationId,
            roomName: huddleRoomName(conversation.workspaceId, id),
            startedById: userId,
          },
        })
        started = true
      } catch (err: any) {
        if (err?.code !== 'P2002') throw err
      }
      row = await activeHuddleRow(conversationId)
      if (!row) continue
    }

    const open = await db.huddleParticipant.findFirst({ where: { huddleId: row.id, userId, leftAt: null } })
    if (!open) await db.huddleParticipant.create({ data: { huddleId: row.id, userId } })
    const current = await db.huddle.findUnique({ where: { id: row.id }, select: { endedAt: true } })
    if (current?.endedAt) continue

    if (started) {
      await postStartMessage(row)
      await ringMembers(row, conversation, userId)
    }
    const user = await db.user.findUnique({ where: { id: userId }, select: { name: true, email: true, image: true } })
    const token = await mintJoinToken(config, {
      roomName: row.roomName,
      userId,
      name: user?.name || user?.email || 'Someone',
      image: user?.image ?? null,
    })
    const huddle = (await announce(conversationId)) ?? (await serialize(await activeHuddleRow(conversationId)))
    return { huddle, token, url: config.url }
  }
  throw new ConversationError(409, 'huddle_busy', 'The huddle changed while joining. Try again.')
}

export async function leaveHuddle(conversationId: string, userId: string): Promise<HuddleView | null> {
  await loadAccess(conversationId, userId)
  const row = await activeHuddleRow(conversationId)
  if (!row) return null
  if (!(await closeStays(row.id, userId))) return serialize(row)
  if (await endIfEmpty(row.id)) return null
  return announce(conversationId)
}

/**
 * Turn down a huddle someone rang you into. Your other devices stop ringing
 * and the caller hears about it; in a 1:1 DM that nobody else joined, the
 * call ends.
 */
export async function declineHuddle(conversationId: string, userId: string): Promise<HuddleView | null> {
  const { conversation } = await loadAccess(conversationId, userId)
  const row = await activeHuddleRow(conversationId)
  if (!row) return null
  if (row.participants.some((p: any) => p.userId === userId)) return serialize(row)

  const user = await db.user.findUnique({ where: { id: userId }, select: { name: true, email: true } })
  const audience = await conversationAudience(conversation)
  publishConversationEvent(
    conversation.workspaceId,
    { type: 'huddle.declined', conversationId, huddleId: row.id, userId, name: user?.name || user?.email || 'Someone' },
    audience,
  )
  const callerAlone = row.participants.every((p: any) => p.userId === row.startedById)
  if (conversation.kind === 'dm' && callerAlone) {
    await endHuddle(row.id)
    return null
  }
  return serialize(row)
}

/** Apply a verified LiveKit webhook in the workspace's home region. */
export async function applyLiveKitEvent(input: HuddleLiveKitEvent): Promise<void> {
  const row = await db.huddle.findUnique({ where: { roomName: input.roomName }, include: { participants: OPEN_PARTICIPANTS } })
  if (!row || row.endedAt) return

  if (input.event === 'room_finished') {
    await endHuddle(row.id)
    return
  }
  const identity = input.identity
  if (!identity) return

  if (input.event === 'participant_joined') {
    if (row.participants.some((p: any) => p.userId === identity)) return
    await db.huddleParticipant.create({ data: { huddleId: row.id, userId: identity } })
    await announce(row.conversationId)
    return
  }

  // A second device with the same identity replaces the first, which LiveKit
  // reports as a leave; only drop the person if they are really gone.
  const config = liveKitConfig()
  const live = config ? await listRoomIdentities(config, row.roomName) : null
  if (live?.has(identity)) return
  if (!(await closeStays(row.id, identity))) return
  if (!(await endIfEmpty(row.id))) await announce(row.conversationId)
}

export const HUDDLE_FORWARD_PATH = '/api/internal/huddles/livekit'

const HANDLED_EVENTS = new Set<string>(['participant_joined', 'participant_left', 'participant_connection_aborted', 'room_finished'])

/**
 * Entry point for `POST /api/webhooks/livekit`. Verifies LiveKit's signature,
 * then applies the event in the workspace's home region (the room name carries
 * the workspace id). A 503 asks LiveKit to retry when that region is down.
 */
export async function handleLiveKitWebhook(input: {
  rawBody: string
  authorization: string | undefined
}): Promise<{ status: 200 | 401 | 503; body: Record<string, unknown> }> {
  const config = liveKitConfig()
  if (!config) return { status: 503, body: { error: 'huddles_not_configured' } }
  let event: Awaited<ReturnType<typeof receiveWebhook>>
  try {
    event = await receiveWebhook(config, input.rawBody, input.authorization)
  } catch {
    return { status: 401, body: { error: 'invalid_signature' } }
  }
  const roomName = event.room?.name ?? ''
  const workspaceId = workspaceIdFromRoomName(roomName)
  if (!HANDLED_EVENTS.has(event.event) || !workspaceId) return { status: 200, body: { ok: true, ignored: true } }

  const payload: HuddleLiveKitEvent = {
    event: event.event as LiveKitEventName,
    roomName,
    identity: event.participant?.identity ?? null,
  }
  const { outcome } = await routeToHomeRegion(workspaceId, HUDDLE_FORWARD_PATH, payload)
  if (outcome === 'unavailable') return { status: 503, body: { error: 'home_region_unavailable' } }
  if (outcome === 'local') await applyLiveKitEvent(payload)
  return { status: 200, body: { ok: true } }
}

export function _resetHuddlesForTests(): void {
  lastReconciled.clear()
}

export function _setHuddlePushSenderForTests(sender: PushSender | null): void {
  sendPush = sender ?? sendPushToUser
}
