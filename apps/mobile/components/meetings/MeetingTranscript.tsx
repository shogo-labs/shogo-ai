// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { View, Text } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { formatDuration } from '../../lib/format-duration'
import type { ParsedTranscript, TranscriptSegment } from '../../lib/meeting-notes'

const SPEAKER_COLORS = [
  { bg: 'bg-blue-500/10', border: 'border-l-blue-500', text: 'text-blue-600', label: 'bg-blue-500/15' },
  { bg: 'bg-emerald-500/10', border: 'border-l-emerald-500', text: 'text-emerald-600', label: 'bg-emerald-500/15' },
  { bg: 'bg-purple-500/10', border: 'border-l-purple-500', text: 'text-purple-600', label: 'bg-purple-500/15' },
  { bg: 'bg-orange-500/10', border: 'border-l-orange-500', text: 'text-orange-600', label: 'bg-orange-500/15' },
  { bg: 'bg-pink-500/10', border: 'border-l-pink-500', text: 'text-pink-600', label: 'bg-pink-500/15' },
  { bg: 'bg-cyan-500/10', border: 'border-l-cyan-500', text: 'text-cyan-600', label: 'bg-cyan-500/15' },
  { bg: 'bg-amber-500/10', border: 'border-l-amber-500', text: 'text-amber-600', label: 'bg-amber-500/15' },
  { bg: 'bg-rose-500/10', border: 'border-l-rose-500', text: 'text-rose-600', label: 'bg-rose-500/15' },
]

function getSpeakerColor(speaker: string, speakerMap: Map<string, number>) {
  if (!speakerMap.has(speaker)) speakerMap.set(speaker, speakerMap.size)
  return SPEAKER_COLORS[speakerMap.get(speaker)! % SPEAKER_COLORS.length]
}

/** Groups consecutive segments by the same speaker for a cleaner display. */
function groupSegmentsBySpeaker(segments: TranscriptSegment[]) {
  const groups: { speaker: string | undefined; start: number; end: number; lines: string[] }[] = []
  for (const seg of segments) {
    const lastGroup = groups[groups.length - 1]
    if (lastGroup && lastGroup.speaker === seg.speaker && seg.speaker) {
      lastGroup.end = seg.end
      lastGroup.lines.push(seg.text)
    } else {
      groups.push({ speaker: seg.speaker, start: seg.start, end: seg.end, lines: [seg.text] })
    }
  }
  return groups
}

function SpeakerTranscriptView({ segments }: { segments: TranscriptSegment[] }) {
  const groups = groupSegmentsBySpeaker(segments)
  const speakerMap = new Map<string, number>()

  return (
    <View className="gap-4">
      {groups.map((group, index) => {
        const color = group.speaker ? getSpeakerColor(group.speaker, speakerMap) : null
        if (!color) {
          return (
            <View key={index} className="flex-row gap-3">
              <Text className="text-xs text-muted-foreground font-mono w-12 pt-0.5 text-right">
                {formatDuration(group.start)}
              </Text>
              <Text className="flex-1 text-sm text-foreground leading-relaxed">{group.lines.join(' ')}</Text>
            </View>
          )
        }
        return (
          <View key={index} className={cn('rounded-lg border-l-[3px] pl-3 py-2 pr-2', color.bg, color.border)}>
            <View className="flex-row items-center gap-2 mb-1">
              <View className={cn('rounded px-1.5 py-0.5', color.label)}>
                <Text className={cn('text-[10px] font-semibold uppercase', color.text)}>{group.speaker}</Text>
              </View>
              <Text className="text-[10px] text-muted-foreground font-mono">{formatDuration(group.start)}</Text>
            </View>
            <Text className="text-sm text-foreground leading-relaxed">{group.lines.join(' ')}</Text>
          </View>
        )
      })}
    </View>
  )
}

export function MeetingTranscript({
  transcript,
  live = false,
  partial = null,
  notice = null,
}: {
  transcript: ParsedTranscript | null
  live?: boolean
  /** Words still being said, shown muted after the settled text. */
  partial?: string | null
  /** Why the live transcript isn't updating. */
  notice?: string | null
}) {
  if (!transcript || (!transcript.text && transcript.segments.length === 0 && !partial)) {
    return (
      <View className="items-center justify-center py-16">
        <Text className="text-sm text-muted-foreground text-center px-6">
          {transcript?.error || notice || (live ? 'Listening… the live transcript shows up here as people talk.' : 'No transcript available')}
        </Text>
      </View>
    )
  }
  const hasSpeakers = transcript.segments.some((s) => s.speaker)
  return (
    <View>
      {live && (
        <View className="mb-4 flex-row items-center gap-2">
          <View className="h-1.5 w-1.5 rounded-full bg-red-500" />
          <Text className="text-xs text-muted-foreground">Live transcript. The full transcript replaces it when the recording stops.</Text>
        </View>
      )}
      {!!transcript.error && (
        <View className="bg-amber-500/10 rounded-lg p-3 mb-4 flex-row items-center gap-2">
          <Text className="flex-1 text-xs leading-5 text-amber-700 dark:text-amber-300">
            {transcript.segments.length > 0 || transcript.text
              ? `The latest transcription failed, so this is the transcript captured earlier. ${transcript.error}`
              : transcript.error}
          </Text>
        </View>
      )}
      {live && !!notice && (
        <View className="bg-amber-500/10 rounded-lg p-3 mb-4">
          <Text className="text-xs leading-5 text-amber-700 dark:text-amber-300">{notice}</Text>
        </View>
      )}
      {hasSpeakers ? (
        <SpeakerTranscriptView segments={transcript.segments} />
      ) : transcript.segments.length > 0 ? (
        transcript.segments.map((segment, index) => (
          <View key={index} className="flex-row gap-3 mb-3">
            <Text className="text-xs text-muted-foreground font-mono w-12 pt-0.5 text-right">
              {formatDuration(segment.start)}
            </Text>
            <Text className="flex-1 text-sm text-foreground leading-relaxed">{segment.text}</Text>
          </View>
        ))
      ) : transcript.text ? (
        <Text className="text-sm text-foreground leading-relaxed">{transcript.text}</Text>
      ) : null}
      {live && !!partial && (
        <View className="flex-row gap-3 mb-3">
          <Text className="text-xs text-muted-foreground font-mono w-12 pt-0.5 text-right">…</Text>
          <Text accessibilityLabel="Words being said" className="flex-1 text-sm text-muted-foreground leading-relaxed">
            {partial}
          </Text>
        </View>
      )}
    </View>
  )
}
