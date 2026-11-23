// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A person's Shogo Certified level, XP rank, streak and badges, shown wherever Shogo
 * shows a person (workspace profile card, creator profile). The data comes
 * with that person's card from the API; nothing renders until they start
 * learning.
 */
import { Pressable, ScrollView, Text, View } from 'react-native'
import { SvgXml } from 'react-native-svg'
import { ExternalLink, Flame, GraduationCap } from 'lucide-react-native'
import { learnBadgeSvg, type LearnProfileSummary } from '../../lib/learn-badge-art'
import { openExternalLink } from '../../lib/open-external-link'

export function LearnProfileSection({
  learn,
  isSelf = false,
  name,
  padded = false,
}: {
  learn: LearnProfileSummary | null | undefined
  isSelf?: boolean
  name?: string
  /** Horizontal page padding (creator profile); the profile card has its own. */
  padded?: boolean
}) {
  if (!learn) return null
  const pct = learn.rank.next
    ? Math.max(4, Math.round(((learn.xp - learn.rank.min) / (learn.rank.next.min - learn.rank.min)) * 100))
    : 100
  const certified = learn.certifiedLevel > 0 && learn.certifiedTitle
  const link = isSelf ? `${learn.url}/profile/` : `${learn.url}/`
  const px = padded ? 'px-5' : ''
  return (
    <View testID="learn-profile" className="gap-2">
      <View className={`flex-row items-center justify-between ${px}`}>
        <Text className="text-[11px] font-semibold uppercase text-muted-foreground">Shogo Learn</Text>
        <Pressable
          onPress={() => void openExternalLink(link)}
          accessibilityRole="link"
          accessibilityLabel={isSelf ? 'Open your Shogo Learn profile' : 'Open Shogo Learn'}
          className="flex-row items-center gap-1"
        >
          <Text className="text-xs text-primary">{isSelf ? 'Your progress' : 'Learn too'}</Text>
          <ExternalLink size={11} className="text-primary" />
        </Pressable>
      </View>

      <View className={padded ? 'px-5' : ''}>
        <View className="rounded-xl border border-border bg-card p-3 gap-2.5">
          <View className="flex-row items-center gap-3">
            <View
              accessibilityLabel={certified ? `Shogo Certified Level ${learn.certifiedLevel}` : 'Not certified yet'}
              className={`h-10 w-10 items-center justify-center rounded-full ${certified ? 'bg-primary' : 'bg-primary/10'}`}
            >
              <Text testID="learn-profile-level" className={`text-base font-bold ${certified ? 'text-primary-foreground' : 'text-primary'}`}>
                {certified ? learn.certifiedLevel : '–'}
              </Text>
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-sm font-semibold text-foreground">
                {certified ? `Shogo Certified ${learn.certifiedTitle}` : 'Learning on Shogo Learn'}
                {certified ? <Text className="text-xs font-normal text-muted-foreground">  ·  Level {learn.certifiedLevel}</Text> : null}
              </Text>
              <Text className="mt-0.5 text-xs text-muted-foreground">
                {learn.rank.name} rank  ·  {learn.xp} XP
              </Text>
              <View className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                <View className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
              </View>
            </View>
          </View>
          <View className="flex-row flex-wrap gap-x-4 gap-y-1">
            <View className="flex-row items-center gap-1">
              <GraduationCap size={12} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">
                {learn.lessonsCompleted} lesson{learn.lessonsCompleted === 1 ? '' : 's'}
                {learn.coursesCompleted ? ` · ${learn.coursesCompleted} course${learn.coursesCompleted === 1 ? '' : 's'}` : ''}
              </Text>
            </View>
            {learn.streak.current > 0 ? (
              <View className="flex-row items-center gap-1">
                <Flame size={12} color="#f97316" />
                <Text className="text-xs text-muted-foreground">{learn.streak.current}-day streak</Text>
              </View>
            ) : null}
            <Text className="text-xs text-muted-foreground">
              {learn.badgeCount} of {learn.badgeTotal} badges
            </Text>
          </View>
        </View>
      </View>

      {learn.badges.length ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 10, paddingHorizontal: padded ? 20 : 0 }}
        >
          {learn.badges.map((b) => (
            <View
              key={b.id}
              testID={`learn-badge-${b.id}`}
              accessibilityLabel={`${b.name}: ${b.description}`}
              className="w-[84px] items-center gap-1"
            >
              <SvgXml xml={learnBadgeSvg(b, `${name ?? 'u'}${b.id}`)} width={48} height={53} />
              <Text className="text-center text-[11px] font-medium leading-tight text-foreground" numberOfLines={2}>
                {b.name}
              </Text>
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  )
}
