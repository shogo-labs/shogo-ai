// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The ongoing notification Android keeps in the shade while an agent needs you
 * or is working: the Android counterpart of the iOS Live Activity. It is quiet
 * (the loud alert is the push), and when the agent is waiting on an approval it
 * carries the same Approve and Deny buttons as that push. Pure; the native
 * adapter posts it.
 */
import type { AgentGlanceSnapshot } from '../agent-glance'
import { glanceAgentSubtitle, glanceHeadline } from '../glance-summary'
import { leadAgent } from '../live-activity/live-activity-plan'
import { APPROVAL_CATEGORY } from '../notifications/agent-actions'

export const ONGOING_ID = 'agent-live'

export interface OngoingContent {
  title: string
  body: string
  /** `#rrggbb` */
  color: string
  /** Set while the agent waits on an approval: shows Approve and Deny. */
  categoryId: string | null
  data: Record<string, string>
}

export type OngoingPlan = { kind: 'show'; content: OngoingContent } | { kind: 'clear' }

export function planOngoingNotification(snapshot: AgentGlanceSnapshot | null, now: number): OngoingPlan {
  const lead = leadAgent(snapshot, now)
  if (!lead || !snapshot) return { kind: 'clear' }
  const waiting = lead.state === 'needs_you'
  const approval = waiting ? lead.approval : null
  return {
    kind: 'show',
    content: {
      title: waiting ? `${lead.name} needs you` : `${lead.name} is working`,
      // More than one agent: say so, since the notification follows only the first.
      body: snapshot.agents.length > 1 ? `${glanceAgentSubtitle(lead)} · ${glanceHeadline(snapshot, now)}` : glanceAgentSubtitle(lead),
      color: lead.color,
      categoryId: approval ? APPROVAL_CATEGORY : null,
      data: {
        // Opens the agent when tapped, through the deep link router.
        url: lead.link,
        ...(approval ? { approvalMessageId: approval.messageId, conversationId: approval.conversationId } : {}),
      },
    },
  }
}

export function ongoingChanged(prev: OngoingContent | null, next: OngoingContent): boolean {
  return !prev || JSON.stringify(prev) !== JSON.stringify(next)
}
