// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Keeps the iPhone Lock Screen Live Activity in step with an agent that needs
 * a person, even when the app is closed. The app starts and updates the
 * activity itself while it runs; this covers the moments it can't: an approval
 * arriving while the app is suspended, and the answer being given from a
 * notification button.
 *
 * Live Activities are updated over APNs directly (Expo's push service does not
 * carry them). The content state mirrors what the app's `expo-widgets` Live
 * Activity decodes: `{ name, props }` where `props` is the JSON the layout in
 * `apps/mobile/lib/live-activity/AgentActivity.tsx` renders.
 *
 * Without APNs credentials in the environment every function here does nothing.
 */
import { prisma } from '../lib/prisma'
import {
  apnsConfigFromEnv,
  buildApnsRequest,
  http2Transport,
  isDeadTokenResponse,
  type ApnsConfig,
  type ApnsRequest,
  type ApnsResponse,
  type ApnsTransport,
} from '../lib/apns'

export { apnsConfigFromEnv, isDeadTokenResponse, signApnsJwt } from '../lib/apns'
export type { ApnsConfig, ApnsRequest, ApnsResponse, ApnsTransport } from '../lib/apns'

/** `createLiveActivity` name in the app. */
export const LIVE_ACTIVITY_NAME = 'AgentActivity'
/** Swift type of the activity's static attributes (from expo-widgets). */
export const LIVE_ACTIVITY_ATTRIBUTES_TYPE = 'LiveActivityAttributes'

export type LiveActivityState = 'needs_you' | 'running' | 'failed' | 'done'

/** Mirrors `AgentActivityProps` in apps/mobile/lib/live-activity/live-activity-plan.ts. */
export interface LiveActivityProps {
  agentId: string
  agentName: string
  state: LiveActivityState
  headline: string
  detail: string
  /** `#rrggbb` */
  color: string
  waiting: number
  working: number
  /** `shogo://agents/<id>` */
  link: string
  startedAt: number
}

export type ApnsEvent = 'start' | 'update' | 'end'

export interface ApnsAlert {
  title: string
  body: string
}

const DEFAULT_COLOR = '#3b5bdb'
const END_DISMISS_SECONDS = 15 * 60

export function liveActivityProps(input: {
  agentId: string
  agentName: string
  state: LiveActivityState
  detail: string
  color?: string
  now?: number
}): LiveActivityProps {
  const waiting = input.state === 'needs_you' ? 1 : 0
  return {
    agentId: input.agentId,
    agentName: input.agentName,
    state: input.state,
    headline: input.state === 'needs_you' ? '1 needs you' : input.state === 'running' ? '1 working' : input.state === 'failed' ? 'Failed' : 'Done',
    detail: input.detail,
    color: input.color && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color.toLowerCase() : DEFAULT_COLOR,
    waiting,
    working: input.state === 'running' ? 1 : 0,
    link: `shogo://agents/${encodeURIComponent(input.agentId)}`,
    startedAt: input.now ?? Date.now(),
  }
}

/** The APNs JSON body for a Live Activity event. */
export function buildApnsBody(input: {
  event: ApnsEvent
  props: LiveActivityProps
  nowSeconds: number
  alert?: ApnsAlert
}): { aps: Record<string, unknown> } {
  const aps: Record<string, unknown> = {
    timestamp: input.nowSeconds,
    event: input.event,
    'content-state': { name: LIVE_ACTIVITY_NAME, props: JSON.stringify(input.props) },
  }
  if (input.event === 'start') {
    aps['attributes-type'] = LIVE_ACTIVITY_ATTRIBUTES_TYPE
    aps.attributes = { url: input.props.link }
    // A start push must carry an alert; the system rejects it otherwise.
    aps.alert = input.alert ?? { title: input.props.agentName, body: input.props.detail || input.props.headline }
  } else if (input.alert) {
    aps.alert = input.alert
  }
  if (input.event === 'end') aps['dismissal-date'] = input.nowSeconds + END_DISMISS_SECONDS
  return { aps }
}

export function apnsRequest(config: ApnsConfig, deviceToken: string, event: ApnsEvent, body: object, nowSeconds: number): ApnsRequest {
  return buildApnsRequest({
    config,
    deviceToken,
    pushType: 'liveactivity',
    topicSuffix: '.push-type.liveactivity',
    // An update that should be seen now goes out at priority 10; the end can wait.
    priority: event === 'end' ? '5' : '10',
    body,
    nowSeconds,
  })
}

interface SubscriptionRow {
  id: string
  liveActivityToken: string | null
  liveActivityPushToStartToken: string | null
}

export interface LiveActivityDeps {
  db?: any
  config?: ApnsConfig | null
  transport?: ApnsTransport
  now?: () => number
}

export interface LiveActivityPushInput {
  props: LiveActivityProps
  /** `update` changes the running activity; `end` ends it. A device with none running is started only for `update` with `startIfNone`. */
  event: 'update' | 'end'
  alert?: ApnsAlert
  /** Start the activity on devices that have none yet (an approval is waiting). */
  startIfNone?: boolean
}

/** Pushes the event to the user's iPhones. Returns how many were sent. */
export async function pushAgentLiveActivity(
  userId: string,
  input: LiveActivityPushInput,
  deps: LiveActivityDeps = {},
): Promise<number> {
  const config = deps.config === undefined ? apnsConfigFromEnv() : deps.config
  if (!config) return 0
  const db = deps.db ?? (prisma as any)
  const transport = deps.transport ?? http2Transport
  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000)

  let sent = 0
  try {
    const rows: SubscriptionRow[] = await db.mobilePushSubscription.findMany({
      where: { userId, platform: 'ios', OR: [{ liveActivityToken: { not: null } }, { liveActivityPushToStartToken: { not: null } }] },
      select: { id: true, liveActivityToken: true, liveActivityPushToStartToken: true },
    })
    await Promise.all(rows.map(async (row) => {
      let event: ApnsEvent
      let token: string | null
      let column: 'liveActivityToken' | 'liveActivityPushToStartToken'
      if (row.liveActivityToken) {
        event = input.event
        token = row.liveActivityToken
        column = 'liveActivityToken'
      } else if (input.event === 'update' && input.startIfNone && row.liveActivityPushToStartToken) {
        event = 'start'
        token = row.liveActivityPushToStartToken
        column = 'liveActivityPushToStartToken'
      } else {
        return
      }
      const body = buildApnsBody({ event, props: input.props, nowSeconds, alert: input.alert })
      const response = await transport(apnsRequest(config, token, event, body, nowSeconds))
      if (response.status === 200) {
        sent++
        // An ended activity's token is spent; the app registers a new one for the next.
        if (event === 'end') await db.mobilePushSubscription.update({ where: { id: row.id }, data: { liveActivityToken: null } }).catch(() => {})
      } else if (isDeadTokenResponse(response)) {
        await db.mobilePushSubscription.update({ where: { id: row.id }, data: { [column]: null } }).catch(() => {})
      } else {
        console.warn(`[LiveActivity] APNs ${event} failed: ${response.status} ${response.reason ?? ''}`.trim())
      }
    }))
  } catch (err) {
    console.error('[LiveActivity] push failed:', (err as Error).message)
  }
  return sent
}
