// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The note "hey Shogo" leaves in a huddle's chat. The message text is what the
 * agent reads — the request plus the last minute of the call — so showing it
 * raw would dump a transcript into the channel. Instead the chat shows what was
 * asked, and the transcript it was given sits behind a toggle.
 */
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'

export interface HuddleWakeBlock {
  huddleId: string
  meetingId?: string | null
  speakerId: string
  speakerName: string
  /** What they asked for, after the phrase. */
  request: string
  contextSeconds: number
  /** Everyone still in the call when it was woken. */
  participants?: string[]
  transcript?: Array<{ speaker: string; start: number; text: string }>
}

export function huddleWakeBlockOf(blocks: Record<string, unknown> | null | undefined): HuddleWakeBlock | null {
  const block = blocks?.huddleWake as HuddleWakeBlock | undefined
  if (!block || typeof block !== 'object') return null
  if (typeof block.speakerName !== 'string' || typeof block.request !== 'string') return null
  return block
}

/** `m:ss` from the start of the call, so a line can be found in the recording. */
function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export function HuddleWakeNote({ block, createdAt }: { block: HuddleWakeBlock; createdAt?: string }) {
  const [open, setOpen] = useState(false)
  const lines = block.transcript ?? []
  const who = block.speakerName?.trim() || 'Someone'
  const request = block.request.trim()
  return (
    <View className="self-center px-2" testID="huddle-wake-note">
      <View className="max-w-[420px] gap-1 rounded-xl border border-border bg-card px-3 py-2">
        <View className="flex-row items-center gap-1.5">
          <Text className="min-w-0 flex-1 text-[11px] font-semibold text-violet-600 dark:text-violet-400" numberOfLines={1}>
            ⚡ {who} woke Shogo in the huddle
          </Text>
          {createdAt ? <Text className="text-[10px] text-muted-foreground">{createdAt}</Text> : null}
        </View>
        <Text className="text-sm italic text-foreground">
          {request ? `“${request}”` : 'Asked Shogo to listen to the call'}
        </Text>
        {lines.length ? (
          <Pressable
            onPress={() => setOpen((value) => !value)}
            accessibilityRole="button"
            accessibilityLabel={open ? 'Hide the transcript Shogo was given' : 'Show the transcript Shogo was given'}
            className="flex-row items-center gap-1 self-start rounded-md bg-muted px-2 py-0.5 active:opacity-70"
          >
            <Text className="text-[11px] font-medium text-foreground">
              {open ? '▾ Hide transcript' : `▸ Show transcript (${lines.length})`}
            </Text>
          </Pressable>
        ) : null}
        {open
          ? lines.map((line, index) => (
              <View key={`${line.start}-${index}`} className={cn('flex-row gap-1.5', index === 0 && 'mt-0.5')}>
                <Text className="w-[68px] shrink-0 text-[11px] font-semibold text-muted-foreground" numberOfLines={1}>
                  {line.speaker}
                </Text>
                <Text className="min-w-0 flex-1 text-[11px] leading-4 text-foreground">
                  <Text className="text-muted-foreground">{clock(line.start)} </Text>
                  {line.text}
                </Text>
              </View>
            ))
          : null}
        {open && lines.length ? (
          <Text className="text-[10px] text-muted-foreground">The last {block.contextSeconds} s of the call.</Text>
        ) : null}
      </View>
    </View>
  )
}
