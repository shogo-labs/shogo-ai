// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A team-chat message queued behind a reply the agent is still writing here.
 *
 * The wake is durable (`AgentWake`), and this row is one of its two views: the
 * session's queue dock is the other. Both press the same buttons — Send now
 * starts the message immediately (stopping the reply in front of it, exactly
 * like the chat queue's Send now) and ✕ takes it off the queue for good. The
 * note carries the row's id, so a row painted before that change (no `wakeId`)
 * is left as the plain system line it has always been.
 */

import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { AlarmClock, Loader2, SendHorizontal, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { teamChatApi, type ChatMessage } from '../../lib/team-chat-api'
import { wakeRefusalMessage } from '../../lib/wake-refusal'
import { formatTime } from '../../lib/team-chat-time'

/** What a queued note's `blocks.wakeQueued` carries. */
export type WakeQueuedBlock = {
  wakeId?: string
  /** `project:<id>` or `workspace`. */
  agentRef?: string
  agentName?: string
  /** pending | sending | running | done | failed | removed */
  status?: string
  /** Why the run failed, when it did. */
  error?: string
  sentNowBy?: { id?: string; name?: string | null } | null
  triggerMessageId?: string
  runningMessageId?: string | null
}

export function wakeQueuedOf(message: ChatMessage): WakeQueuedBlock | null {
  const block = (message.blocks as { wakeQueued?: WakeQueuedBlock } | null | undefined)?.wakeQueued
  return block && typeof block === 'object' ? block : null
}

/** How the row reads once there is nothing left to press. */
function labelFor(wake: WakeQueuedBlock): string {
  const agent = wake.agentName ?? 'the agent'
  const sender = wake.sentNowBy?.name
  switch (wake.status) {
    case 'sending':
      return 'Sending…'
    case 'running':
      return sender ? `Sent now by ${sender} · running` : 'Running'
    case 'done':
      return sender ? `Sent now by ${sender}` : 'Done'
    case 'failed':
      // The run threw: the note must not claim a reply that never happened.
      return sender ? `Sent now by ${sender} · failed` : 'Failed to run'
    case 'removed':
      return 'Removed'
    default:
      return `Queued for ${agent}`
  }
}

export function QueuedWakeRow({ message, wake }: { message: ChatMessage; wake: WakeQueuedBlock }) {
  const [busy, setBusy] = useState(false)
  const [acted, setActed] = useState<"send" | "remove" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pending = (wake.status ?? "pending") === "pending"
  const waiting = pending && !acted
  // Hold the clicked state until the server's own rewrite of the note arrives,
  // so a row never falls back to "Queued for …" between the click and the poll.
  const label = busy || acted === "send" ? "Sending…" : acted === "remove" ? "Removed" : labelFor(wake)
  const active = waiting || busy

  const act = (kind: "send" | "remove", run: () => Promise<unknown>) => {
    if (busy) return
    setError(null)
    setBusy(true)
    void run()
      .then(() => setActed(kind))
      .catch((err: unknown) => setError(wakeRefusalMessage(err)))
      .finally(() => setBusy(false))
  }
  const sendNow = () => act("send", () => teamChatApi().sendWakeNow(wake.wakeId!))
  const remove = () => act("remove", () => teamChatApi().removeWake(wake.wakeId!))

  return (
    <View
      accessibilityLabel={`Queued message for ${wake.agentName ?? 'an agent'}: ${message.text}`}
      className="flex-row items-center gap-2 px-4 py-1.5"
    >
      {active ? (
        <AlarmClock size={13} className="text-amber-600 dark:text-amber-400" />
      ) : (
        <SendHorizontal size={13} className="text-muted-foreground" />
      )}
      <View className="min-w-0 flex-1">
        <Text className={cn('text-xs', active ? 'text-foreground' : 'text-muted-foreground')} numberOfLines={1}>
          {label}
        </Text>
        {error ? (
          <Text className="text-[11px] text-destructive" numberOfLines={2}>
            {error}
          </Text>
        ) : wake.status === "failed" && wake.error ? (
          <Text className="text-[11px] text-muted-foreground" numberOfLines={2}>
            {wake.error}
          </Text>
        ) : null}
      </View>
      {waiting ? (
        <View className="flex-row items-center gap-1">
          <Pressable
            onPress={sendNow}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Send queued message now"
            className={cn(
              'flex-row items-center gap-1 rounded-md border border-border px-2 py-0.5',
              busy ? 'opacity-60' : 'active:bg-muted',
            )}
          >
            {busy ? (
              <Loader2 size={10} className="text-muted-foreground" />
            ) : (
              <SendHorizontal size={10} className="text-muted-foreground" />
            )}
            <Text className="text-[11px] text-muted-foreground">{busy ? 'Sending…' : 'Send now'}</Text>
          </Pressable>
          <Pressable
            onPress={remove}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Remove queued message"
            className={cn('rounded-md px-1.5 py-0.5', busy ? 'opacity-60' : 'active:bg-muted')}
          >
            <X size={11} className="text-muted-foreground" />
          </Pressable>
        </View>
      ) : null}
      <Text className="text-[11px] text-muted-foreground">{formatTime(message.createdAt)}</Text>
    </View>
  )
}
