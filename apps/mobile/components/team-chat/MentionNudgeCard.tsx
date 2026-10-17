// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shown only to the sender, just under the message they posted, when it
 * mentions someone who isn't a member — the moment Slack's "You mentioned @X,
 * but they're not in this private channel" nudge appears.
 *
 * Rendered as a Shogo-attributed ephemeral (see `EphemeralNotice`) so it reads
 * the way Slack's does: a bot line, an "Only visible to you" annotation, and
 * the reader's own choices underneath. Not a real message: local UI state,
 * never sent to the server or cached with the timeline.
 */
import { EphemeralNotice } from './EphemeralNotice'
import type { MentionNames } from '../../lib/team-chat-state'

export interface MentionNudgeCardProps {
  ids: string[]
  names: MentionNames
  /** Slack words the warning differently for a private channel. */
  isPrivate?: boolean
  workspaceId?: string | null
  createdAt: string
  busy?: boolean
  error?: string | null
  onAdd: () => void
  onDismiss: () => void
  onDontShowAgain: () => void
}

export function MentionNudgeCard({
  ids,
  names,
  isPrivate,
  workspaceId,
  createdAt,
  busy,
  error,
  onAdd,
  onDismiss,
  onDontShowAgain,
}: MentionNudgeCardProps) {
  if (!ids.length) return null
  const mentioned = ids.map((id) => `<@u:${id}>`).join(', ')
  return (
    <EphemeralNotice
      testID="mention-nudge-card"
      text={`You mentioned ${mentioned}, but they're not in this ${isPrivate ? 'private channel' : 'channel'}.`}
      names={names}
      createdAt={createdAt}
      workspaceId={workspaceId}
      ephemeralLabel
      error={error}
      actions={[
        { label: 'Add them', busyLabel: 'Adding…', busy, primary: true, onPress: onAdd, accessibilityLabel: 'Add them to this channel' },
        { label: 'Dismiss', onPress: onDismiss, accessibilityLabel: 'Dismiss' },
        { label: "Don't show again", onPress: onDontShowAgain, accessibilityLabel: "Don't show this again" },
      ]}
    />
  )
}
