// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The "come back" nudges (SHO-258 §4).
 *
 * Two moments mattered and had no message attached to them:
 *
 *   - a workspace-chat turn built or changed a project while the person was
 *     away, so the build finished into silence (only project chats pushed);
 *   - a person hit the free window, was told "back at 14:00", and was never
 *     told again once 14:00 came.
 *
 * Both go through here so the push, the in-app row and the email always agree
 * on the link and the dedupe key, and so each is sent at most as often as the
 * plan allows (build-ready: once per day per user; credits-reset: once per cap,
 * enforced by the wallet's `capNotifyPendingAt` flag).
 */
import { prisma } from './prisma'
import { sendPushToUser } from './push-notifications'
import { createNotification } from '../services/notification.service'
import { sendBuildReadyEmail, sendCreditsResetEmail } from '../services/email.service'

/** Where the app lives, for links inside email. */
function appBaseUrl(): string {
  return process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://app.shogo.ai'
}

/** Deep link to a project's chat, and to the notification preferences. */
function projectChatUrl(projectId: string): string {
  return `${appBaseUrl()}/chat?project=${encodeURIComponent(projectId)}`
}

function preferencesUrl(): string {
  return `${appBaseUrl()}/settings/account`
}

export interface BuildReadyInput {
  userId: string
  workspaceId: string
  chatSessionId: string
  projectId: string
  projectName: string
  /** One line from the turn, shown in the push body and the email. */
  summary: string
  /** True when the person's client was gone when the turn finished. */
  userAway: boolean
}

/**
 * Send the build-ready nudge. Returns what it actually did so callers (and
 * tests) can assert the gates: `{ pushed, emailed }`.
 *
 * Email is once per user per day, and only when the person was away — a push
 * for every turn would be noise on a surface that already streams to an open
 * app.
 */
export async function notifyBuildReady(input: BuildReadyInput): Promise<{ pushed: boolean; emailed: boolean }> {
  const result = { pushed: false, emailed: false }
  if (!input.userAway) return result

  const url = projectChatUrl(input.projectId)
  const title = `${input.projectName} is ready`
  const body = input.summary || 'Your agent finished a turn.'

  try {
    await sendPushToUser(input.userId, {
      title,
      body,
      data: { type: 'build-ready', sessionId: input.chatSessionId, projectId: input.projectId },
      type: 'build-ready',
      channelId: 'chat-complete',
    })
    result.pushed = true
  } catch (error: any) {
    console.warn('[Lifecycle] build-ready push failed:', error?.message ?? error)
  }

  const dayKey = new Date().toISOString().slice(0, 10)
  const row = await createNotification({
    userId: input.userId,
    type: 'build_ready',
    title,
    message: body,
    actionUrl: url,
    metadata: { projectId: input.projectId, workspaceId: input.workspaceId, chatSessionId: input.chatSessionId },
    // At most one build-ready row per user per day.
    dedupeKey: `build_ready:${input.userId}:${dayKey}`,
  })
  // `createNotification` returns null when the day's row already existed, so
  // this is also the once-a-day email gate.
  if (!row) return result

  try {
    const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { email: true } })
    if (user?.email) {
      const sent = await sendBuildReadyEmail({
        to: user.email,
        projectName: input.projectName,
        summary: body,
        projectUrl: url,
        preferencesUrl: preferencesUrl(),
      })
      result.emailed = sent.success
    }
  } catch (error: any) {
    console.warn('[Lifecycle] build-ready email failed:', error?.message ?? error)
  }

  return result
}

export interface CreditsResetInput {
  userId: string
  workspaceId: string
  projectId: string | null
  projectName: string
  resetAt: Date
}

/**
 * Send the "your agent is back" nudge: push + in-app row + email, once per cap.
 * The caller clears `usage_wallets.capNotifyPendingAt` after this resolves, so
 * the flag is what makes this exactly-once.
 */
export async function notifyCreditsReset(input: CreditsResetInput): Promise<void> {
  const label = input.resetAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const title = 'Your agent is back'
  const message = input.projectId
    ? `Your usage limit reset at ${label}. Continue ${input.projectName}.`
    : `Your usage limit reset at ${label}.`
  const url = input.projectId ? projectChatUrl(input.projectId) : `${appBaseUrl()}/chat`

  try {
    await sendPushToUser(input.userId, {
      title,
      body: message,
      data: { type: 'credits-reset', ...(input.projectId ? { projectId: input.projectId } : {}) },
      type: 'credits-reset',
      channelId: 'chat-complete',
    })
  } catch (error: any) {
    console.warn('[Lifecycle] credits-reset push failed:', error?.message ?? error)
  }

  await createNotification({
    userId: input.userId,
    type: 'credits_reset',
    title,
    message,
    actionUrl: url,
    metadata: {
      workspaceId: input.workspaceId,
      // The phone app's "Continue <project>" chip reads this; without it the
      // row can only fall back to the project list (SHO-266 QA).
      projectId: input.projectId,
      resetAt: input.resetAt.toISOString(),
    },
    dedupeKey: `credits_reset:${input.workspaceId}:${input.resetAt.toISOString()}`,
  })

  try {
    const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { email: true } })
    if (user?.email) {
      await sendCreditsResetEmail({
        to: user.email,
        projectName: input.projectName,
        resetAt: label,
        continueUrl: url,
        preferencesUrl: preferencesUrl(),
      })
    }
  } catch (error: any) {
    console.warn('[Lifecycle] credits-reset email failed:', error?.message ?? error)
  }
}
