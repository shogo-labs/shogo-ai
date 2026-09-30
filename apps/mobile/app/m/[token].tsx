// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Public, read-only view of shared meeting notes. No transcript, no audio,
 * no rough notes: just what the owner chose to share.
 */
import { useEffect, useState } from 'react'
import { View, Text, ScrollView, ActivityIndicator, Pressable, Linking } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { CheckSquare, Square } from 'lucide-react-native'
import { API_URL } from '../../lib/api'
import { formatDuration } from '../../lib/format-duration'
import { stripActionItemsSection } from '../../lib/meeting-notes'
import type { MeetingActionItem } from '../../lib/meetings-api'
import { MarkdownText } from '../../components/chat/MarkdownText'

interface SharedMeeting {
  title: string | null
  createdAt: string
  duration: number | null
  enhancedNotes: string | null
  actionItems: MeetingActionItem[]
}

export default function SharedMeetingScreen() {
  const { token } = useLocalSearchParams<{ token: string }>()
  const [meeting, setMeeting] = useState<SharedMeeting | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return
    fetch(`${API_URL}/api/shared-meetings/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body?.error?.message || 'This link is invalid or was revoked')
        setMeeting(body.meeting)
      })
      .catch((err) => setError(err.message))
  }, [token])

  if (error) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background px-8">
        <Text className="text-base font-semibold text-foreground">Notes unavailable</Text>
        <Text className="mt-1 text-center text-sm text-muted-foreground">{error}</Text>
      </SafeAreaView>
    )
  }

  if (!meeting) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator color="#f97316" />
      </SafeAreaView>
    )
  }

  const date = new Date(meeting.createdAt)
  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="mx-auto w-full max-w-[760px] px-5 pb-16 pt-8">
        <Text className="text-[11px] font-semibold uppercase tracking-[1.2px] text-orange-600 dark:text-orange-300">
          Meeting notes
        </Text>
        <Text className="mt-1 text-[28px] font-semibold tracking-[-0.6px] text-foreground">
          {meeting.title || 'Meeting notes'}
        </Text>
        <Text className="mt-1 text-sm text-muted-foreground">
          {date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
          {meeting.duration ? ` · ${formatDuration(meeting.duration)}` : ''}
        </Text>

        {!!meeting.enhancedNotes && (
          <View className="mt-6 rounded-2xl border border-border/70 bg-card p-5">
            <MarkdownText>{stripActionItemsSection(meeting.enhancedNotes)}</MarkdownText>
          </View>
        )}

        {meeting.actionItems.length > 0 && (
          <View className="mt-4 rounded-2xl border border-border/70 bg-card p-5">
            <Text className="mb-3 text-[11px] font-semibold uppercase tracking-[1.2px] text-orange-600 dark:text-orange-300">
              Action items
            </Text>
            {meeting.actionItems.map((item, index) => (
              <View key={index} className="mb-2 flex-row items-start gap-2.5">
                {item.done ? (
                  <CheckSquare size={16} className="mt-0.5 text-green-600" />
                ) : (
                  <Square size={16} className="mt-0.5 text-muted-foreground" />
                )}
                <Text className="flex-1 text-sm leading-5 text-foreground">
                  {item.text}
                  {item.owner ? <Text className="text-muted-foreground"> — {item.owner}</Text> : null}
                </Text>
              </View>
            ))}
          </View>
        )}

        <Pressable onPress={() => Linking.openURL('https://shogo.ai')} className="mt-10 self-center">
          <Text className="text-xs text-muted-foreground">Notes by Shogo</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  )
}
