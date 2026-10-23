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

import { randomBytes, randomUUID } from 'crypto'
import { prisma } from '../lib/prisma'
import { publishConversationEvent } from '../lib/conversation-bus'
import { routeToHomeRegion } from '../lib/home-region-route'
import { deleteRoom, liveKitConfig, listRoomIdentities, mintJoinToken, muteParticipantMicrophone, receiveWebhook, removeRoomParticipant } from '../lib/livekit'
import { sendVoipPush, type VoipPayload, type VoipSendResult } from '../lib/apns'
import { sendPushToUser } from '../lib/push-notifications'
import { getSettingsRows, isSilenced } from './chat-settings'
import { HUDDLE_MAX_PARTICIPANTS } from '../lib/chat-limits'
import { getPresence } from './conversation-presence'
import {
  ConversationError,
  MAX_GROUP_DM_PARTICIPANTS,
  conversationAudience,
  getWorkspaceRole,
  loadAccess,
  openDirectConversation,
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
/** People one invite request may ring. */
const MAX_INVITES_PER_REQUEST = 20
/** How long someone who knocked waits for an answer before the request lapses. */
const KNOCK_WINDOW_MS = 2 * 60_000
/** People who may be waiting at the door of one huddle at once. */
const MAX_WAITING_REQUESTS = 20
const MAX_GUEST_NAME = 40

/** Android channel and iOS category for incoming huddle calls (registered on the phone). */
export const HUDDLE_CALLS_CHANNEL = 'huddle-calls'
export const HUDDLE_CALL_CATEGORY = 'huddle-call'

function huddleSoundOff(row: { huddleSound?: string } | undefined): boolean {
  return row?.huddleSound === 'off'
}

type PushPayload = Parameters<typeof sendPushToUser>[1]
type PushSender = (userId: string, payload: PushPayload) => Promise<void>
let sendPush: PushSender = sendPushToUser

type VoipSender = (voipToken: string, payload: VoipPayload) => Promise<VoipSendResult>
let sendVoip: VoipSender = (voipToken, payload) => sendVoipPush(voipToken, payload)

/** One registered device of a person being rung. */
export interface RingDevice {
  pushToken: string
  platform: string
  voipToken: string | null
}

function isDirect(kind: string): boolean {
  return kind === 'dm' || kind === 'group_dm'
}

export interface HuddleParticipantView {
  userId: string
  name: string
  image: string | null
  joinedAt: string
  /** An outside guest let in through the huddle link. */
  guest?: boolean
}

export type HuddleInviteStatus = 'ringing' | 'declined' | 'missed'

/** Someone rung into the huddle who hasn't joined: shown as a "Ringing…" tile. */
export interface HuddleInviteView {
  userId: string
  name: string
  image: string | null
  status: HuddleInviteStatus
  invitedById: string
}

/** Someone waiting to be let in through the huddle link ("X wants to join"). */
export interface HuddleRequestView {
  id: string
  /** Set for a workspace member without access to the conversation; null for an outside guest. */
  userId: string | null
  name: string
  image: string | null
  guest: boolean
  createdAt: string
}

export interface HuddleView {
  id: string
  conversationId: string
  workspaceId: string
  startedById: string
  startedAt: string
  /** The "started a huddle" message; chat during the call is posted as replies to it. */
  messageId: string | null
  participants: HuddleParticipantView[]
  invited: HuddleInviteView[]
  /**
   * Who the call's chat is shared with: everyone who has been in the call or
   * was invited (plus the members of a DM it started in). It only grows. When
   * it changes, clients ask for their chat again (`getHuddleChat`).
   */
  chatMembers: string[]
  /** People knocking to be let in. Everyone in the call sees these with Admit and Deny. */
  requests: HuddleRequestView[]
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

/** Guests have no account; their roster id starts with this and they never touch the conversation. */
export const GUEST_ID_PREFIX = 'guest_'
export function isGuestId(id: string): boolean {
  return id.startsWith(GUEST_ID_PREFIX)
}

/** Invites that still let the person into the huddle (declined and cancelled ones don't). */
const JOINABLE_INVITE = ['ringing', 'joined', 'missed']

function activeHuddleRow(conversationId: string) {
  return db.huddle.findUnique({ where: { activeKey: conversationId }, include: { participants: OPEN_PARTICIPANTS } })
}

/** A ring nobody answered within the window reads as missed, even before the timer writes it. */
function effectiveInviteStatus(invite: { status: string; createdAt: Date | string; updatedAt?: Date | string }, now = Date.now()): string {
  if (invite.status !== 'ringing') return invite.status
  const since = new Date(invite.updatedAt ?? invite.createdAt).getTime()
  return now - since >= RING_WINDOW_MS ? 'missed' : 'ringing'
}

async function serialize(row: any): Promise<HuddleView> {
  const byUser = new Map<string, any>()
  for (const p of row.participants ?? []) if (!byUser.has(p.userId)) byUser.set(p.userId, p)
  const invites: any[] = await db.huddleInvite.findMany({
    where: { huddleId: row.id, status: { in: ['ringing', 'declined', 'missed'] } },
    orderBy: { createdAt: 'asc' },
  })
  const pending = invites.filter((i) => !byUser.has(i.userId))
  const waiting: any[] = await db.huddleJoinRequest.findMany({
    where: { huddleId: row.id, status: 'waiting', createdAt: { gt: new Date(Date.now() - KNOCK_WINDOW_MS) } },
    orderBy: { createdAt: 'asc' },
  })
  const guestIds = [...byUser.keys()].filter(isGuestId)
  const userIds = [
    ...new Set([...byUser.keys(), ...pending.map((i) => i.userId), ...waiting.map((r) => r.userId).filter(Boolean)]),
  ].filter((id) => !isGuestId(id))
  const users = userIds.length
    ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true, image: true } })
    : []
  const userById = new Map<string, any>(users.map((u: any) => [u.id, u]))
  const guests: any[] = guestIds.length
    ? await db.huddleJoinRequest.findMany({ where: { huddleId: row.id, guestId: { in: guestIds } }, select: { guestId: true, guestName: true } })
    : []
  const guestName = new Map<string, string>(guests.map((g) => [g.guestId, g.guestName || 'Guest']))
  const now = Date.now()
  const chatMembers = await chatMembersOf(row)
  return {
    id: row.id,
    conversationId: row.conversationId,
    workspaceId: row.workspaceId,
    startedById: row.startedById,
    startedAt: new Date(row.startedAt).toISOString(),
    messageId: row.messageId ?? null,
    participants: [...byUser.values()].map((p) => {
      if (isGuestId(p.userId)) {
        return { userId: p.userId, name: guestName.get(p.userId) ?? 'Guest', image: null, joinedAt: new Date(p.joinedAt).toISOString(), guest: true }
      }
      const user = userById.get(p.userId)
      return {
        userId: p.userId,
        name: user?.name || user?.email || 'Someone',
        image: user?.image ?? null,
        joinedAt: new Date(p.joinedAt).toISOString(),
      }
    }),
    chatMembers,
    invited: pending.map((i) => {
      const user = userById.get(i.userId)
      return {
        userId: i.userId,
        name: user?.name || user?.email || 'Someone',
        image: user?.image ?? null,
        status: effectiveInviteStatus(i, now) as HuddleInviteStatus,
        invitedById: i.invitedById,
      }
    }),
    requests: waiting.map((r) => {
      const user = r.userId ? userById.get(r.userId) : null
      return {
        id: r.id,
        userId: r.userId ?? null,
        name: r.userId ? user?.name || user?.email || 'Someone' : r.guestName || 'Guest',
        image: user?.image ?? null,
        guest: !r.userId,
        createdAt: new Date(r.createdAt).toISOString(),
      }
    }),
  }
}

/**
 * The people a huddle's chat belongs to, sorted: everyone who has been in the
 * call (even if they left), everyone invited who may still join, and, for a
 * call in a DM or group DM, the people in that conversation. Guests are left
 * out: they have no account to hold a chat.
 */
async function chatMembersOf(row: { id: string; conversationId: string }): Promise<string[]> {
  const [stays, invites, conversation] = await Promise.all([
    db.huddleParticipant.findMany({ where: { huddleId: row.id }, select: { userId: true } }),
    db.huddleInvite.findMany({ where: { huddleId: row.id, status: { in: JOINABLE_INVITE } }, select: { userId: true } }),
    db.conversation.findUnique({ where: { id: row.conversationId }, select: { kind: true } }),
  ])
  const ids = new Set<string>([...stays, ...invites].map((r: any) => r.userId as string))
  if (conversation && isDirect(conversation.kind)) {
    const members = await db.conversationMember.findMany({ where: { conversationId: row.conversationId, memberType: 'user' }, select: { userId: true } })
    for (const m of members) if (m.userId) ids.add(m.userId)
  }
  return [...ids].filter((id) => !isGuestId(id)).sort()
}

export interface HuddleChatTarget {
  /** Where this person reads and writes the call's chat. */
  conversationId: string
  kind: string
  /** The huddle's start message when the chat is a thread under it; null for a plain group conversation. */
  threadRootId: string | null
  /** The people this chat is shared with. */
  members: string[]
  /** True when this is not the conversation the call started in (a person added to the call moved the chat). */
  moved: boolean
}

/**
 * Where a person in the call chats. Two people use their DM and three or more
 * use the group DM with exactly those people, found or created. Anyone added
 * to the call changes the set, so the next lookup lands in the right group and
 * everyone in the call has access to what is said. In a channel, members keep
 * the channel's huddle thread, and people who aren't channel members use the
 * group. When the group is too big (or alone), falls back to the call's own
 * conversation for people who can see it.
 */
export async function getHuddleChat(conversationId: string, userId: string): Promise<HuddleChatTarget | null> {
  const row = await db.huddle.findUnique({ where: { activeKey: conversationId } })
  if (!row) throw new ConversationError(409, 'huddle_ended', 'This huddle has ended')
  const conversation = await db.conversation.findUnique({ where: { id: conversationId } })
  if (!conversation) throw new ConversationError(404, 'not_found', 'Conversation not found')

  let member = false
  try {
    await requirePost(conversationId, userId)
    member = true
  } catch (err) {
    if (!(err instanceof ConversationError) || (err.status !== 404 && err.status !== 403)) throw err
  }
  const members = await chatMembersOf(row)
  if (!member && !members.includes(userId)) throw new ConversationError(403, 'forbidden', 'Join the huddle first')

  const own = (): HuddleChatTarget | null =>
    member ? { conversationId, kind: conversation.kind, threadRootId: row.messageId ?? null, members, moved: false } : null

  if (!isDirect(conversation.kind) && member) return own()
  if (members.length < 2) return own()
  if (members.length > MAX_GROUP_DM_PARTICIPANTS) {
    const fallback = own()
    if (fallback) return fallback
    throw new ConversationError(400, 'too_many', `Group chat is limited to ${MAX_GROUP_DM_PARTICIPANTS} people`)
  }
  const chat = await openDirectConversation(conversation.workspaceId, userId, members.filter((id) => id !== userId))
  const same = chat.id === conversationId
  return {
    conversationId: chat.id,
    kind: chat.kind,
    threadRootId: same ? row.messageId ?? null : null,
    members,
    moved: !same,
  }
}

/**
 * Who hears about a huddle: everyone who can see the conversation, plus the
 * people rung in or let in who can't (invited non-members), so their call
 * screens stay current.
 */
async function huddleAudience(conversation: any, huddleId: string | null, ended = false): Promise<string[] | null> {
  const base = await conversationAudience(conversation)
  if (base === null || !huddleId) return base
  const [invites, stays] = await Promise.all([
    db.huddleInvite.findMany({ where: { huddleId, status: { in: JOINABLE_INVITE } }, select: { userId: true } }),
    // Once it has ended, everyone who was in it hears so, including people already gone.
    db.huddleParticipant.findMany({ where: ended ? { huddleId } : { huddleId, leftAt: null }, select: { userId: true } }),
  ])
  const extra = [...invites, ...stays].map((r: any) => r.userId as string).filter((id) => !isGuestId(id))
  return [...new Set([...base, ...extra])]
}

async function announce(conversationId: string, endedHuddleId?: string): Promise<HuddleView | null> {
  const conversation = await db.conversation.findUnique({ where: { id: conversationId } })
  if (!conversation) return null
  const row = await activeHuddleRow(conversationId)
  const huddle = row ? await serialize(row) : null
  const audience = await huddleAudience(conversation, row?.id ?? endedHuddleId ?? null, !row)
  publishConversationEvent(conversation.workspaceId, { type: 'huddle.updated', conversationId, huddle }, audience)
  return huddle
}

/**
 * Who in this workspace is in a live huddle right now.
 *
 * Answers "is this person on a call", not "which call" — the roster and which
 * conversation it belongs to stay in `huddle.updated`. Used both by the
 * `/presence` batch and by the change notifications below.
 */
export async function huddleUserIds(workspaceId: string, userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set()
  const rows = await db.huddleParticipant.findMany({
    where: { userId: { in: userIds }, leftAt: null, huddle: { workspaceId, endedAt: null } },
    select: { userId: true },
  })
  return new Set<string>(rows.map((r: any) => r.userId))
}

/**
 * Tell the workspace these people's huddle badge may have changed.
 *
 * Published workspace-wide, exactly like `presence`: the badge has to appear
 * wherever their name does, including conversations the viewer is not in.
 * Re-reads the state after the caller's mutation instead of assuming, so
 * `inHuddle: false` is only ever sent for someone who really is in no huddle
 * (they may be in a second one elsewhere).
 */
async function publishHuddlePresence(workspaceId: string, userIds: string[]): Promise<void> {
  const ids = [...new Set(userIds.filter((id) => id && !isGuestId(id)))]
  if (!ids.length) return
  const inHuddle = await huddleUserIds(workspaceId, ids)
  for (const userId of ids) {
    publishConversationEvent(workspaceId, { type: 'huddle.presence', userId, inHuddle: inHuddle.has(userId) })
  }
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
  const open = await db.huddleParticipant.findMany({ where: { huddleId, leftAt: null }, select: { userId: true } })
  const { count } = await db.huddle.updateMany({ where: { id: huddleId, endedAt: null }, data: { endedAt, activeKey: null } })
  if (!count) return false
  await cancelRing(huddleId)
  cancelInviteRings(huddleId)
  await db.huddleParticipant.updateMany({ where: { huddleId, leftAt: null }, data: { leftAt: endedAt } })
  await db.huddleJoinRequest.updateMany({ where: { huddleId, status: 'waiting' }, data: { status: 'expired', resolvedAt: endedAt } })
  const huddle = await db.huddle.findUnique({ where: { id: huddleId } })
  if (huddle) {
    const config = liveKitConfig()
    if (config) void deleteRoom(config, huddle.roomName)
    await finishStartMessage(huddle, endedAt)
    await announce(huddle.conversationId, huddleId)
    await publishHuddlePresence(huddle.workspaceId, open.map((p: any) => p.userId))
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
    await ringUsers(huddle, conversation, callerId, candidates, { invite: false })
  } catch (err) {
    console.error('[Huddles] ring failed:', (err as Error).message)
  }
}

/**
 * Ring specific people into a live huddle: an incoming-call prompt on their
 * open apps, and a push for anyone not active right now. `invite` marks a
 * deliberate invitation (mid-call or in a channel) rather than the call
 * starting in a DM; those are tracked per person so one person answering
 * doesn't stop the others' rings.
 */
async function ringUsers(huddle: any, conversation: any, callerId: string, candidates: string[], opts: { invite: boolean }): Promise<void> {
  try {
    if (!candidates.length) return
    const settings = await getSettingsRows(conversation.workspaceId, candidates)
    const now = new Date()
    const targets = candidates.filter((id) => !isSilenced(settings.get(id), now))
    if (!targets.length) return

    const caller = await db.user.findUnique({ where: { id: callerId }, select: { name: true, email: true, image: true } })
    const from = { userId: callerId, name: caller?.name || caller?.email || 'Someone', image: caller?.image ?? null }
    const conversationName: string | null = isDirect(conversation.kind) ? null : conversation.name ?? null
    publishConversationEvent(
      conversation.workspaceId,
      {
        type: 'huddle.ring',
        conversationId: conversation.id,
        conversationKind: conversation.kind,
        huddleId: huddle.id,
        from,
        ...(opts.invite ? { invite: true, conversationName } : {}),
      },
      targets,
    )

    const presence = await getPresence(conversation.workspaceId, targets)
    const away = targets.filter((id) => presence[id] !== 'active')
    if (opts.invite) for (const id of targets) registerInviteRing(huddle.id, id, conversation)
    if (!away.length) return

    const oneToOne = !opts.invite && conversation.kind === 'dm'
    const body = opts.invite
      ? conversationName ? `invited you to a huddle in #${conversationName}` : 'invited you to a huddle'
      : oneToOne ? 'is calling you' : 'started a huddle with you'
    const data = { conversationId: conversation.id, workspaceId: conversation.workspaceId, huddleId: huddle.id }
    const devices: Array<RingDevice & { userId: string }> = await db.mobilePushSubscription.findMany({
      where: { userId: { in: away } },
      select: { userId: true, pushToken: true, platform: true, voipToken: true },
    })
    const byUser = new Map<string, RingDevice[]>()
    for (const device of devices) byUser.set(device.userId, [...(byUser.get(device.userId) ?? []), device])

    for (const userId of away) {
      const silent = huddleSoundOff(settings.get(userId))
      const alert: PushPayload = {
        title: from.name,
        body,
        type: 'huddle-ring',
        // A ring has its own channel (on Android: maximum importance, ringtone sound),
        // separate from ordinary messages. The sound follows the person's huddle sound setting.
        // Group calls use the ordinary messages channel.
        channelId: oneToOne ? HUDDLE_CALLS_CHANNEL : 'messages',
        ...(oneToOne ? { categoryId: HUDDLE_CALL_CATEGORY } : {}),
        priority: 'high',
        sound: silent ? null : 'default',
        audience: 'chat',
        data,
      }
      const userDevices = byUser.get(userId)
      // No device records (e.g. a web-only user): one push to the user, which reaches nobody.
      if (!userDevices?.length) {
        void sendPush(userId, alert)
        continue
      }

      const routed = routeRingDevices(userDevices, { oneToOne, silent })
      const voipPayload: VoipPayload = {
        huddleId: huddle.id,
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId,
        kind: conversation.kind,
        from,
      }
      for (const device of routed.voip) void ringByVoip(userId, device, voipPayload, alert)
      if (routed.data.length) {
        void sendPush(userId, {
          type: 'huddle-ring',
          dataOnly: true,
          priority: 'high',
          audience: 'chat',
          pushTokens: routed.data.map((d) => d.pushToken),
          data: { ...data, callerName: from.name },
        })
      }
      if (routed.alert.length) void sendPush(userId, { ...alert, pushTokens: routed.alert.map((d) => d.pushToken) })
    }

    if (!opts.invite) registerRing(huddle.id, { workspaceId: conversation.workspaceId, conversationId: conversation.id, userIds: away })
  } catch (err) {
    console.error('[Huddles] ring failed:', (err as Error).message)
  }
}

/**
 * Which push reaches each device of someone being rung. A DM on an iPhone with
 * a VoIP token gets a PushKit call (iOS must show the call screen at once); a
 * DM on an Android phone gets a data-only push the app turns into a call; every
 * other device gets the sounding alert. Silent huddles and group calls only
 * use the alert.
 */
export function routeRingDevices<T extends RingDevice>(devices: T[], opts: { oneToOne: boolean; silent: boolean }): { voip: T[]; data: T[]; alert: T[] } {
  const routed = { voip: [] as T[], data: [] as T[], alert: [] as T[] }
  for (const device of devices) {
    if (opts.oneToOne && !opts.silent && device.platform === 'ios' && device.voipToken) routed.voip.push(device)
    else if (opts.oneToOne && !opts.silent && device.platform === 'android') routed.data.push(device)
    else routed.alert.push(device)
  }
  return routed
}

/**
 * Sends the PushKit call. If APNs refuses it, the device still gets the normal
 * alert, so a call is never lost; a dead token is dropped from the device record.
 */
async function ringByVoip(userId: string, device: RingDevice, payload: VoipPayload, alert: PushPayload): Promise<void> {
  const token = device.voipToken as string
  const result = await sendVoip(token, payload).catch((): VoipSendResult => ({ sent: false, dead: false, status: 0 }))
  if (result.dead) {
    await db.mobilePushSubscription.updateMany({ where: { voipToken: token }, data: { voipToken: null } }).catch(() => {})
  }
  if (!result.sent) await sendPush(userId, { ...alert, pushTokens: [device.pushToken] })
}

function ringCancelPayload(huddleId: string, conversationId: string, workspaceId: string): PushPayload {
  return {
    type: 'huddle-ring-cancel',
    dataOnly: true,
    priority: 'high',
    audience: 'chat',
    data: { huddleId, conversationId, workspaceId },
  }
}

/**
 * Rings still open, by huddle: the people who were pushed and when the ring
 * stops on its own. Cancelling sends `huddle-ring-cancel` so their phones stop.
 */
interface OpenRing {
  workspaceId: string
  conversationId: string
  userIds: string[]
  timer: ReturnType<typeof setTimeout>
}
const openRings = new Map<string, OpenRing>()

function registerRing(huddleId: string, ring: Omit<OpenRing, 'timer'>): void {
  const existing = openRings.get(huddleId)
  if (existing) clearTimeout(existing.timer)
  const timer = setTimeout(() => {
    void cancelRing(huddleId)
  }, RING_WINDOW_MS)
  timer.unref?.()
  openRings.set(huddleId, { ...ring, timer })
}

/** End a ring: answered, declined, the huddle ended, or the window passed. Safe to call twice. */
async function cancelRing(huddleId: string): Promise<void> {
  const ring = openRings.get(huddleId)
  if (!ring) return
  openRings.delete(huddleId)
  clearTimeout(ring.timer)
  for (const userId of ring.userIds) {
    void sendPush(userId, ringCancelPayload(huddleId, ring.conversationId, ring.workspaceId))
  }
}

/**
 * Rings for people invited into a live huddle, one per person. Each lasts the
 * ring window, then the invite reads as missed and their phone stops ringing.
 */
interface OpenInviteRing {
  workspaceId: string
  conversationId: string
  timer: ReturnType<typeof setTimeout>
}
const inviteRings = new Map<string, OpenInviteRing>()
const inviteRingKey = (huddleId: string, userId: string) => `${huddleId}:${userId}`

function registerInviteRing(huddleId: string, userId: string, conversation: { id: string; workspaceId: string }): void {
  const key = inviteRingKey(huddleId, userId)
  const existing = inviteRings.get(key)
  if (existing) clearTimeout(existing.timer)
  const timer = setTimeout(() => {
    void expireInviteRing(huddleId, userId)
  }, RING_WINDOW_MS)
  timer.unref?.()
  inviteRings.set(key, { workspaceId: conversation.workspaceId, conversationId: conversation.id, timer })
}

/** Stop ringing one invitee (answered, declined, cancelled, or timed out). Safe to call twice. */
function cancelInviteRing(huddleId: string, userId: string): void {
  const key = inviteRingKey(huddleId, userId)
  const ring = inviteRings.get(key)
  if (!ring) return
  inviteRings.delete(key)
  clearTimeout(ring.timer)
  void sendPush(userId, ringCancelPayload(huddleId, ring.conversationId, ring.workspaceId))
}

function cancelInviteRings(huddleId: string): void {
  for (const key of [...inviteRings.keys()]) {
    if (key.startsWith(`${huddleId}:`)) cancelInviteRing(huddleId, key.slice(huddleId.length + 1))
  }
}

async function expireInviteRing(huddleId: string, userId: string): Promise<void> {
  const ring = inviteRings.get(inviteRingKey(huddleId, userId))
  cancelInviteRing(huddleId, userId)
  try {
    const { count } = await db.huddleInvite.updateMany({ where: { huddleId, userId, status: 'ringing' }, data: { status: 'missed' } })
    if (count && ring) await announce(ring.conversationId)
  } catch (err) {
    console.error('[Huddles] invite expiry failed:', (err as Error).message)
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
  await publishHuddlePresence(row.workspaceId, stale.map((p: any) => p.userId))
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

/**
 * The conversation for someone who can see it, or who was rung or let into its
 * live huddle without being able to (an invited non-member). The second case
 * is only for acting on the huddle itself (leave, decline, invite others).
 */
async function loadHuddleAccess(conversationId: string, userId: string): Promise<{ conversation: any; viaHuddle: boolean }> {
  try {
    const { conversation } = await loadAccess(conversationId, userId)
    return { conversation, viaHuddle: false }
  } catch (err) {
    if (!(err instanceof ConversationError) || err.status !== 404) throw err
    const conversation = await huddleOnlyAccess(conversationId, userId, { requireInvite: false })
    if (!conversation) throw err
    return { conversation, viaHuddle: true }
  }
}

/**
 * The conversation when this person is a workspace member with a live huddle
 * there that they are in or were invited to, else null. Viewers can't talk, so they can't be let in.
 */
async function huddleOnlyAccess(conversationId: string, userId: string, opts: { requireInvite: boolean }): Promise<any | null> {
  const conversation = await db.conversation.findUnique({ where: { id: conversationId } })
  if (!conversation) return null
  const role = await getWorkspaceRole(conversation.workspaceId, userId)
  if (!role || role === 'viewer') return null
  const row = await db.huddle.findUnique({ where: { activeKey: conversationId }, select: { id: true } })
  if (!row) return null
  const invite = await db.huddleInvite.findFirst({ where: { huddleId: row.id, userId, status: { in: JOINABLE_INVITE } }, select: { id: true } })
  if (invite) return conversation
  if (opts.requireInvite) return null
  const stay = await db.huddleParticipant.findFirst({ where: { huddleId: row.id, userId, leftAt: null }, select: { id: true } })
  return stay ? conversation : null
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
  /** A DM huddle that started moments ago without you, or one you were just invited to: still ringing, for apps that missed the ring event. */
  ringing: boolean
  /** Set when the ring is an invitation: who rang you in, and the channel it is in. */
  invite?: { from: { userId: string; name: string; image: string | null }; conversationName: string | null; at: string }
}

/** Live huddles in conversations this person can see (or was invited to), for sidebar indicators and catching up on rings. */
export async function listActiveHuddles(workspaceId: string, userId: string): Promise<ActiveHuddleView[]> {
  const rows = await db.huddle.findMany({
    where: {
      workspaceId,
      activeKey: { not: null },
      OR: [
        { conversation: { OR: [{ kind: { in: ['public', 'activity'] } }, { members: { some: { userId } } }] } },
        { invites: { some: { userId, status: { in: JOINABLE_INVITE } } } },
        { participants: { some: { userId, leftAt: null } } },
      ],
    },
    include: {
      participants: OPEN_PARTICIPANTS,
      conversation: { select: { kind: true, name: true } },
      invites: { where: { userId } },
    },
    orderBy: { startedAt: 'asc' },
    take: 200,
  })
  const now = Date.now()
  return Promise.all(rows.map(async (row: any) => {
    const view = await serialize(row)
    const joined = view.participants.some((p) => p.userId === userId)
    const invite = row.invites?.[0]
    const inviteRinging = !!invite && !joined && effectiveInviteStatus(invite, now) === 'ringing'
    const dmRinging =
      isDirect(row.conversation.kind) &&
      row.startedById !== userId &&
      now - new Date(row.startedAt).getTime() < RING_WINDOW_MS &&
      !joined &&
      view.participants.some((p) => p.userId === row.startedById)
    let ringInvite: ActiveHuddleView['invite']
    if (inviteRinging) {
      const inviter = await db.user.findUnique({ where: { id: invite.invitedById }, select: { name: true, email: true, image: true } })
      ringInvite = {
        from: { userId: invite.invitedById, name: inviter?.name || inviter?.email || 'Someone', image: inviter?.image ?? null },
        conversationName: isDirect(row.conversation.kind) ? null : row.conversation.name ?? null,
        at: new Date(invite.updatedAt ?? invite.createdAt).toISOString(),
      }
    }
    return { ...view, conversationKind: row.conversation.kind, ringing: dmRinging || inviteRinging, ...(ringInvite ? { invite: ringInvite } : {}) }
  }))
}

/** Join (starting one if none is live) and get a LiveKit token for the room. */
export async function joinHuddle(conversationId: string, userId: string): Promise<HuddleJoin> {
  const config = liveKitConfig()
  if (!config) throw new ConversationError(400, 'huddles_disabled', 'Huddles are not set up on this server')
  let conversation: any
  // Someone rung into a huddle can join it without being able to see the conversation.
  let viaInvite = false
  try {
    conversation = (await requirePost(conversationId, userId)).conversation
  } catch (err) {
    if (!(err instanceof ConversationError) || (err.status !== 404 && err.status !== 403)) throw err
    conversation = await huddleOnlyAccess(conversationId, userId, { requireInvite: true })
    if (!conversation) throw err
    viaInvite = true
  }
  if (!viaInvite) {
    const userMembers = await db.conversationMember.count({ where: { conversationId, memberType: 'user' } })
    assertHuddleable(conversation, userMembers)
  }

  // The last person can leave between our read and our insert, ending the
  // huddle under us; go round again and start a fresh one.
  for (let attempt = 0; attempt < 3; attempt++) {
    let row = await activeHuddleRow(conversationId)
    let started = false
    if (row) {
      await reconcile(row)
      row = await activeHuddleRow(conversationId)
    }
    if (!row && viaInvite) throw new ConversationError(409, 'huddle_ended', 'This huddle has ended')
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
    if (!open) {
      const inCall = new Set((row.participants ?? []).map((p: any) => p.userId)).size
      if (inCall >= HUDDLE_MAX_PARTICIPANTS) {
        throw new ConversationError(409, 'huddle_full', `This huddle is full (${HUDDLE_MAX_PARTICIPANTS} people)`)
      }
      await db.huddleParticipant.create({ data: { huddleId: row.id, userId } })
    }
    const current = await db.huddle.findUnique({ where: { id: row.id }, select: { endedAt: true } })
    if (current?.endedAt) continue

    const invite = await db.huddleInvite.findFirst({ where: { huddleId: row.id, userId } })
    if (invite) {
      await db.huddleInvite.updateMany({ where: { huddleId: row.id, userId, status: { in: ['ringing', 'missed'] } }, data: { status: 'joined' } })
      cancelInviteRing(row.id, userId)
    }

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
    await publishHuddlePresence(conversation.workspaceId, [userId])
    // Answered by someone other than the caller: every other device stops ringing.
    if (userId !== row.startedById && !invite) await cancelRing(row.id)
    return { huddle, token, url: config.url }
  }
  throw new ConversationError(409, 'huddle_busy', 'The huddle changed while joining. Try again.')
}

export async function leaveHuddle(conversationId: string, userId: string): Promise<HuddleView | null> {
  const { conversation } = await loadHuddleAccess(conversationId, userId)
  const row = await activeHuddleRow(conversationId)
  if (!row) return null
  if (!(await closeStays(row.id, userId))) return serialize(row)
  const ended = await endIfEmpty(row.id)
  // Published here rather than in `endHuddle`: when this was the last person,
  // their roster row is already closed by now, so `endHuddle` sees nobody open
  // and would leave their badge up.
  await publishHuddlePresence(conversation.workspaceId, [userId])
  if (ended) return null
  return announce(conversationId)
}

/**
 * Turn down a huddle someone rang you into. Your other devices stop ringing
 * and the caller hears about it; in a 1:1 DM that nobody else joined, the
 * call ends.
 */
export async function declineHuddle(conversationId: string, userId: string): Promise<HuddleView | null> {
  const { conversation } = await loadHuddleAccess(conversationId, userId)
  const row = await activeHuddleRow(conversationId)
  if (!row) return null
  if (row.participants.some((p: any) => p.userId === userId)) return serialize(row)

  const invited = await db.huddleInvite.updateMany({
    where: { huddleId: row.id, userId, status: { in: ['ringing', 'missed'] } },
    data: { status: 'declined' },
  })
  cancelInviteRing(row.id, userId)
  const user = await db.user.findUnique({ where: { id: userId }, select: { name: true, email: true } })
  const audience = await huddleAudience(conversation, row.id)
  publishConversationEvent(
    conversation.workspaceId,
    { type: 'huddle.declined', conversationId, huddleId: row.id, userId, name: user?.name || user?.email || 'Someone' },
    audience,
  )
  // Your other devices stop ringing; the ring goes on for anyone else rung.
  void sendPush(userId, ringCancelPayload(row.id, conversationId, conversation.workspaceId))
  // An invitee turning down a call doesn't end the call they were invited into.
  if (invited.count) return announce(conversationId)
  const callerAlone = row.participants.every((p: any) => p.userId === row.startedById)
  if (conversation.kind === 'dm' && callerAlone) {
    await endHuddle(row.id)
    return null
  }
  return serialize(row)
}

/**
 * Ring more people into the huddle you're in. Anyone in the call may invite
 * any workspace member (viewers excepted): the invite lets them join the
 * huddle, not read the conversation it lives in.
 */
export async function inviteToHuddle(conversationId: string, userId: string, userIds: string[]): Promise<HuddleView> {
  const { conversation } = await loadHuddleAccess(conversationId, userId)
  const row = await activeHuddleRow(conversationId)
  if (!row) throw new ConversationError(409, 'huddle_ended', 'This huddle has ended')
  if (!row.participants.some((p: any) => p.userId === userId)) {
    throw new ConversationError(403, 'forbidden', 'Join the huddle to invite people')
  }
  const wanted = [...new Set(userIds.filter((id) => typeof id === 'string' && id && id !== userId && !isGuestId(id)))].slice(0, MAX_INVITES_PER_REQUEST)
  if (!wanted.length) throw new ConversationError(400, 'invalid_request', 'Pick at least one person to invite')

  const members: Array<{ userId: string; role: string }> = await db.member.findMany({
    where: { workspaceId: conversation.workspaceId, userId: { in: wanted }, projectId: null },
    select: { userId: true, role: true },
  })
  const inCall = new Set<string>(row.participants.map((p: any) => p.userId))
  const targets = members.filter((m) => m.role !== 'viewer' && !inCall.has(m.userId)).map((m) => m.userId)
  if (!targets.length) {
    if (wanted.every((id) => inCall.has(id))) return serialize(row)
    throw new ConversationError(400, 'invalid_request', 'Those people can’t be invited to this huddle')
  }
  const ringing = await db.huddleInvite.count({ where: { huddleId: row.id, status: 'ringing', userId: { notIn: targets } } })
  if (inCall.size + ringing + targets.length > HUDDLE_MAX_PARTICIPANTS) {
    throw new ConversationError(409, 'huddle_full', `This huddle is full (${HUDDLE_MAX_PARTICIPANTS} people)`)
  }

  for (const target of targets) {
    await db.huddleInvite.upsert({
      where: { huddleId_userId: { huddleId: row.id, userId: target } },
      create: { huddleId: row.id, userId: target, invitedById: userId },
      update: { invitedById: userId, status: 'ringing' },
    })
  }
  const huddle = (await announce(conversationId)) ?? (await serialize(row))
  await ringUsers(row, conversation, userId, targets, { invite: true })
  return huddle
}

/** Take back an invitation that hasn't been answered. Anyone in the call can. */
export async function cancelHuddleInvite(conversationId: string, userId: string, targetUserId: string): Promise<HuddleView | null> {
  await loadHuddleAccess(conversationId, userId)
  const row = await activeHuddleRow(conversationId)
  if (!row) return null
  if (!row.participants.some((p: any) => p.userId === userId)) {
    throw new ConversationError(403, 'forbidden', 'Join the huddle to manage invitations')
  }
  const { count } = await db.huddleInvite.updateMany({
    where: { huddleId: row.id, userId: targetUserId, status: { in: ['ringing', 'missed'] } },
    data: { status: 'cancelled' },
  })
  if (!count) return serialize(row)
  cancelInviteRing(row.id, targetUserId)
  return announce(conversationId)
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
    await publishHuddlePresence(row.workspaceId, [identity])
    return
  }

  // A second device with the same identity replaces the first, which LiveKit
  // reports as a leave; only drop the person if they are really gone.
  const config = liveKitConfig()
  const live = config ? await listRoomIdentities(config, row.roomName) : null
  if (live?.has(identity)) return
  if (!(await closeStays(row.id, identity))) return
  if (!(await endIfEmpty(row.id))) await announce(row.conversationId)
  await publishHuddlePresence(row.workspaceId, [identity])
}

// ─── Moderation ──────────────────────────────────────────────────────────────

/**
 * The live huddle for someone allowed to run it: the person who started it or
 * a workspace admin, and in the call themselves.
 */
async function loadModeration(conversationId: string, userId: string): Promise<{ conversation: any; row: any }> {
  const { conversation } = await loadHuddleAccess(conversationId, userId)
  const row = await activeHuddleRow(conversationId)
  if (!row) throw new ConversationError(409, 'huddle_ended', 'This huddle has ended')
  if (!row.participants.some((p: any) => p.userId === userId)) {
    throw new ConversationError(403, 'forbidden', 'Join the huddle first')
  }
  const role = await getWorkspaceRole(conversation.workspaceId, userId)
  if (row.startedById !== userId && role !== 'owner' && role !== 'admin') {
    throw new ConversationError(403, 'forbidden', 'Only the person who started the huddle or a workspace admin can do that')
  }
  return { conversation, row }
}

/** Silence someone's microphone. They can unmute themselves again. */
export async function muteHuddleParticipant(conversationId: string, userId: string, targetUserId: string): Promise<{ muted: boolean }> {
  const config = liveKitConfig()
  if (!config) throw new ConversationError(400, 'huddles_disabled', 'Huddles are not set up on this server')
  const { row } = await loadModeration(conversationId, userId)
  if (!row.participants.some((p: any) => p.userId === targetUserId)) {
    throw new ConversationError(404, 'not_in_huddle', 'That person is not in the huddle')
  }
  return { muted: await muteParticipantMicrophone(config, row.roomName, targetUserId) }
}

/**
 * Put someone out of the huddle. An invite or admission they used stops
 * working, so they can't walk straight back in; people who can already see the
 * conversation may still join again on their own.
 */
export async function removeHuddleParticipant(conversationId: string, userId: string, targetUserId: string): Promise<HuddleView | null> {
  const config = liveKitConfig()
  if (!config) throw new ConversationError(400, 'huddles_disabled', 'Huddles are not set up on this server')
  if (targetUserId === userId) throw new ConversationError(400, 'invalid_request', 'Use Leave to leave the huddle')
  const { conversation, row } = await loadModeration(conversationId, userId)
  if (!row.participants.some((p: any) => p.userId === targetUserId)) {
    throw new ConversationError(404, 'not_in_huddle', 'That person is not in the huddle')
  }
  await removeRoomParticipant(config, row.roomName, targetUserId)
  await closeStays(row.id, targetUserId)
  await db.huddleInvite.updateMany({ where: { huddleId: row.id, userId: targetUserId, status: { in: JOINABLE_INVITE } }, data: { status: 'cancelled' } })
  cancelInviteRing(row.id, targetUserId)
  await db.huddleJoinRequest.updateMany({
    where: { huddleId: row.id, status: 'admitted', OR: [{ userId: targetUserId }, { guestId: targetUserId }] },
    data: { status: 'denied', resolvedAt: new Date() },
  })
  const ended = await endIfEmpty(row.id)
  if (!isGuestId(targetUserId)) await publishHuddlePresence(conversation.workspaceId, [targetUserId])
  return ended ? null : announce(conversationId)
}

// ─── Link and knock to join ──────────────────────────────────────────────────

export interface HuddleLink {
  token: string
  /** App path that opens the join page. */
  path: string
}

/**
 * The shareable link for the huddle you're in, created on first request.
 * Anyone in the call can copy it; only a moderator can rotate it, which
 * revokes the old link and lapses requests still waiting on it.
 */
export async function getHuddleLink(conversationId: string, userId: string, opts: { rotate?: boolean } = {}): Promise<HuddleLink> {
  let row: any
  if (opts.rotate) {
    row = (await loadModeration(conversationId, userId)).row
  } else {
    await loadHuddleAccess(conversationId, userId)
    row = await activeHuddleRow(conversationId)
    if (!row) throw new ConversationError(409, 'huddle_ended', 'This huddle has ended')
    if (!row.participants.some((p: any) => p.userId === userId)) throw new ConversationError(403, 'forbidden', 'Join the huddle first')
  }
  let token: string | null = row.linkToken ?? null
  if (!token || opts.rotate) {
    token = randomBytes(18).toString('base64url')
    await db.huddle.update({ where: { id: row.id }, data: { linkToken: token } })
    if (opts.rotate) {
      await db.huddleJoinRequest.updateMany({ where: { huddleId: row.id, status: 'waiting' }, data: { status: 'expired', resolvedAt: new Date() } })
      await announce(conversationId)
    }
  }
  return { token: token!, path: `/huddle/join/${token}` }
}

export interface HuddleLinkInfo {
  live: boolean
  startedBy?: string | null
  participantCount?: number
  /** `member` can join directly; `knock` has to ask to be let in. */
  access?: 'member' | 'knock'
  /** The caller has an account and is signed in (a guest only needs a name). */
  signedIn?: boolean
  /** Only for people who can already join: enough to open the call. */
  conversationId?: string
  workspaceId?: string
  label?: string | null
}

async function canPostIn(conversationId: string, userId: string): Promise<boolean> {
  try {
    await requirePost(conversationId, userId)
    return true
  } catch {
    return false
  }
}

async function huddleByLink(token: string): Promise<any | null> {
  if (!token || token.length > 128) return null
  return db.huddle.findUnique({ where: { linkToken: token }, include: { participants: OPEN_PARTICIPANTS, conversation: true } })
}

/**
 * What the join page shows before anyone is let in. Reveals nothing about the
 * conversation to people who can't already see it.
 */
export async function getHuddleLinkInfo(token: string, userId: string | null): Promise<HuddleLinkInfo> {
  const row = await huddleByLink(token)
  if (!row || row.endedAt) return { live: false }
  const starter = await db.user.findUnique({ where: { id: row.startedById }, select: { name: true, email: true } })
  const info: HuddleLinkInfo = {
    live: true,
    startedBy: starter?.name || starter?.email || null,
    participantCount: new Set((row.participants ?? []).map((p: any) => p.userId)).size,
    access: 'knock',
    signedIn: !!userId,
  }
  if (!userId) return info
  const direct = (await canPostIn(row.conversationId, userId)) || !!(await huddleOnlyAccess(row.conversationId, userId, { requireInvite: true }))
  if (!direct) return info
  return {
    ...info,
    access: 'member',
    conversationId: row.conversationId,
    workspaceId: row.workspaceId,
    label: isDirect(row.conversation.kind) ? null : row.conversation.name ?? null,
  }
}

export interface HuddleKnock {
  /** Null when the person was already let in (they can join right away). */
  requestId: string | null
  status: 'waiting' | 'admitted'
  guest: boolean
  conversationId?: string
  workspaceId?: string
}

/**
 * Ask to be let in through the huddle link. A workspace member without access
 * to the conversation, or an outside guest who gives a name, waits on the
 * waiting screen while everyone in the call sees "X wants to join".
 */
export async function knockOnHuddle(token: string, input: { userId: string | null; guestName?: string | null }): Promise<HuddleKnock> {
  const row = await huddleByLink(token)
  if (!row || row.endedAt) throw new ConversationError(409, 'huddle_ended', 'This huddle has ended')

  let guestName: string | null = null
  if (input.userId) {
    const role = await getWorkspaceRole(row.workspaceId, input.userId)
    if (!role || role === 'viewer') throw new ConversationError(403, 'forbidden', 'You can’t join this huddle')
    if (await canPostIn(row.conversationId, input.userId)) {
      throw new ConversationError(400, 'already_has_access', 'You can join this huddle directly')
    }
    if (await huddleOnlyAccess(row.conversationId, input.userId, { requireInvite: true })) {
      return { requestId: null, status: 'admitted', guest: false, conversationId: row.conversationId, workspaceId: row.workspaceId }
    }
    const open = await db.huddleJoinRequest.findFirst({
      where: { huddleId: row.id, userId: input.userId, status: 'waiting', createdAt: { gt: new Date(Date.now() - KNOCK_WINDOW_MS) } },
    })
    if (open) return { requestId: open.id, status: 'waiting', guest: false }
  } else {
    guestName = (input.guestName ?? '').toString().replace(/\s+/g, ' ').trim().slice(0, MAX_GUEST_NAME)
    if (!guestName) throw new ConversationError(400, 'invalid_request', 'Enter your name to ask to join')
  }

  const waiting = await db.huddleJoinRequest.count({
    where: { huddleId: row.id, status: 'waiting', createdAt: { gt: new Date(Date.now() - KNOCK_WINDOW_MS) } },
  })
  if (waiting >= MAX_WAITING_REQUESTS) {
    throw new ConversationError(409, 'too_many_requests', 'Too many people are waiting to join. Try again in a moment.')
  }
  const created = await db.huddleJoinRequest.create({
    data: input.userId
      ? { huddleId: row.id, userId: input.userId }
      : { huddleId: row.id, guestId: `${GUEST_ID_PREFIX}${randomUUID()}`, guestName },
  })
  const user = input.userId ? await db.user.findUnique({ where: { id: input.userId }, select: { name: true, email: true } }) : null
  await announce(row.conversationId)
  const audience = await huddleAudience(row.conversation, row.id)
  publishConversationEvent(
    row.workspaceId,
    {
      type: 'huddle.knock',
      conversationId: row.conversationId,
      huddleId: row.id,
      request: { id: created.id, name: input.userId ? user?.name || user?.email || 'Someone' : guestName, guest: !input.userId },
    },
    audience,
  )
  return { requestId: created.id, status: 'waiting', guest: !input.userId }
}

export type HuddleRequestStatus = 'waiting' | 'admitted' | 'denied' | 'expired' | 'ended'

export interface HuddleRequestResult {
  status: HuddleRequestStatus
  /** Guests get a LiveKit token the moment they are let in. */
  token?: string
  url?: string
  guestId?: string
  /** Members let in join through the normal join call. */
  conversationId?: string
  workspaceId?: string
}

/**
 * Where a knock stands, polled by the waiting screen. When a guest has been
 * let in, this seats them in the call and hands over a token.
 */
export async function getHuddleJoinRequest(requestId: string, userId: string | null): Promise<HuddleRequestResult> {
  const request = await db.huddleJoinRequest.findUnique({ where: { id: requestId }, include: { huddle: true } })
  // A member's request is theirs alone; don't confirm it exists to anyone else.
  if (!request || (request.userId && request.userId !== userId)) throw new ConversationError(404, 'not_found', 'Request not found')
  const huddle = request.huddle
  let status: string = request.status
  if (status === 'waiting' && Date.now() - new Date(request.createdAt).getTime() > KNOCK_WINDOW_MS) {
    await db.huddleJoinRequest.updateMany({ where: { id: request.id, status: 'waiting' }, data: { status: 'expired', resolvedAt: new Date() } })
    status = 'expired'
    if (!huddle.endedAt) await announce(huddle.conversationId)
  }
  if (huddle.endedAt) return { status: status === 'denied' ? 'denied' : 'ended' }
  if (status !== 'admitted') return { status: status as HuddleRequestStatus }
  if (request.userId) return { status: 'admitted', conversationId: huddle.conversationId, workspaceId: huddle.workspaceId }

  const config = liveKitConfig()
  if (!config) throw new ConversationError(400, 'huddles_disabled', 'Huddles are not set up on this server')
  const row = await db.huddle.findUnique({ where: { id: huddle.id }, include: { participants: OPEN_PARTICIPANTS } })
  if (!row || row.endedAt) return { status: 'ended' }
  const seated = row.participants.some((p: any) => p.userId === request.guestId)
  if (!seated) {
    const inCall = new Set(row.participants.map((p: any) => p.userId)).size
    if (inCall >= HUDDLE_MAX_PARTICIPANTS) throw new ConversationError(409, 'huddle_full', `This huddle is full (${HUDDLE_MAX_PARTICIPANTS} people)`)
    await db.huddleParticipant.create({ data: { huddleId: row.id, userId: request.guestId } })
    await announce(row.conversationId)
  }
  const token = await mintJoinToken(config, {
    roomName: row.roomName,
    userId: request.guestId,
    name: request.guestName || 'Guest',
    guest: true,
  })
  return { status: 'admitted', token, url: config.url, guestId: request.guestId }
}

/** A guest hanging up. They have no session, so their request id is their credential. */
export async function guestLeaveHuddle(requestId: string): Promise<void> {
  const request = await db.huddleJoinRequest.findUnique({ where: { id: requestId }, include: { huddle: true } })
  if (!request?.guestId || request.huddle.endedAt) return
  if (!(await closeStays(request.huddleId, request.guestId))) return
  if (!(await endIfEmpty(request.huddleId))) await announce(request.huddle.conversationId)
}

/** Let someone in or turn them away. Anyone in the call can. */
export async function resolveHuddleRequest(
  conversationId: string,
  userId: string,
  requestId: string,
  decision: 'admit' | 'deny',
): Promise<HuddleView | null> {
  await loadHuddleAccess(conversationId, userId)
  const row = await activeHuddleRow(conversationId)
  if (!row) throw new ConversationError(409, 'huddle_ended', 'This huddle has ended')
  if (!row.participants.some((p: any) => p.userId === userId)) throw new ConversationError(403, 'forbidden', 'Join the huddle first')
  const request = await db.huddleJoinRequest.findFirst({ where: { id: requestId, huddleId: row.id } })
  if (!request) throw new ConversationError(404, 'not_found', 'Request not found')
  if (request.status !== 'waiting') return serialize(row)
  if (Date.now() - new Date(request.createdAt).getTime() > KNOCK_WINDOW_MS) {
    await db.huddleJoinRequest.updateMany({ where: { id: request.id, status: 'waiting' }, data: { status: 'expired', resolvedAt: new Date() } })
    await announce(conversationId)
    throw new ConversationError(409, 'request_expired', 'This request has expired')
  }
  await db.huddleJoinRequest.update({
    where: { id: request.id },
    data: { status: decision === 'admit' ? 'admitted' : 'denied', resolvedAt: new Date() },
  })
  if (decision === 'admit' && request.userId) {
    // Their pass into the huddle (not the conversation); "joined" keeps it off the Ringing tiles.
    await db.huddleInvite.upsert({
      where: { huddleId_userId: { huddleId: row.id, userId: request.userId } },
      create: { huddleId: row.id, userId: request.userId, invitedById: userId, status: 'joined' },
      update: { invitedById: userId, status: 'joined' },
    })
  }
  return announce(conversationId)
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
  for (const ring of openRings.values()) clearTimeout(ring.timer)
  openRings.clear()
  for (const ring of inviteRings.values()) clearTimeout(ring.timer)
  inviteRings.clear()
}

export function _setHuddlePushSenderForTests(sender: PushSender | null): void {
  sendPush = sender ?? sendPushToUser
}

/** Runs what the ring window timer does for every open ring. */
export async function _expireRingsForTests(): Promise<void> {
  for (const huddleId of [...openRings.keys()]) await cancelRing(huddleId)
  for (const key of [...inviteRings.keys()]) {
    const sep = key.indexOf(':')
    await expireInviteRing(key.slice(0, sep), key.slice(sep + 1))
  }
}

export function _setVoipSenderForTests(sender: VoipSender | null): void {
  sendVoip = sender ?? ((voipToken, payload) => sendVoipPush(voipToken, payload))
}
