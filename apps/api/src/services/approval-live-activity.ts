// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What an approval does to the Live Activity on a person's iPhone: it appears
 * (or flips to "needs you") when a card opens, and goes back to "working" when
 * the card is answered, whichever device answered it.
 */
import type { ApprovalPush } from './approval-push'
import { liveActivityProps, pushAgentLiveActivity, type LiveActivityPushInput } from './live-activity-push'

type Pusher = (userId: string, input: LiveActivityPushInput) => Promise<number>
let push: Pusher = (userId, input) => pushAgentLiveActivity(userId, input)

/** The agent's key in the app: its project id, or `ws` for the workspace agent. */
function agentIdOf(projectId: string | null | undefined): string {
  return projectId || 'ws'
}

export async function liveActivityApprovalOpened(userId: string, approval: ApprovalPush): Promise<void> {
  await push(userId, {
    event: 'update',
    startIfNone: true,
    alert: { title: approval.title, body: approval.body },
    props: liveActivityProps({
      agentId: agentIdOf(approval.data.projectId),
      agentName: approval.agentName,
      state: 'needs_you',
      detail: approval.body,
    }),
  }).catch(() => 0)
}

export async function liveActivityApprovalAnswered(
  userId: string,
  input: { projectId: string | null | undefined; agentName: string; decision: 'approve' | 'deny' },
): Promise<void> {
  await push(userId, {
    event: 'update',
    props: liveActivityProps({
      agentId: agentIdOf(input.projectId),
      agentName: input.agentName,
      state: 'running',
      detail: input.decision === 'approve' ? 'Approved, continuing' : 'Denied',
    }),
  }).catch(() => 0)
}

export function _setLiveActivityPusherForTests(pusher: Pusher | null): void {
  push = pusher ?? ((userId, input) => pushAgentLiveActivity(userId, input))
}
