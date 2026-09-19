// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared presentational primitives for the personal and team Activity
 * screens (`components/personal/PersonalActivityScreen.tsx` and
 * `app/(app)/activity.tsx`'s `TeamActivityScreen`).
 *
 * The two screens read from genuinely different sources today (workspace
 * goal events/agent tasks vs. agent tasks + project/notification
 * collections) — unifying that into one `WorkspaceActivity` read model is a
 * separate, larger change (tracked as a follow-up). This file extracts the
 * row/empty/error/loading UI the two screens already rendered almost
 * identically, so at least the *look* of "activity" is one definition, not
 * two that can drift, and either screen's data model can change without
 * touching the other's markup.
 */

import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { CircleAlert } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

export type ActivityCardTone = 'neutral' | 'primary' | 'destructive'

const TONE_CARD_CLASSES: Record<ActivityCardTone, string> = {
  neutral: 'border-border bg-card',
  primary: 'border-primary bg-primary/5',
  destructive: 'border-destructive bg-destructive/5',
}

const TONE_ICON_CLASSES: Record<ActivityCardTone, string> = {
  neutral: 'bg-muted',
  primary: 'bg-primary/10',
  destructive: 'bg-destructive/10',
}

export interface ActivityCardProps {
  tone?: ActivityCardTone
  icon: ReactNode
  title: string
  /** Small muted line under the title, e.g. "Project · Running · 3m". */
  subtitle?: string
  /** Body content — a plain string or a custom node (e.g. a boxed "current step" block). */
  message?: ReactNode
  /** Small muted line rendered after the message, e.g. a relative timestamp. */
  footer?: ReactNode
  /** Trailing content in the title row, e.g. a chevron for pressable cards. */
  trailing?: ReactNode
  onPress?: () => void
  accessibilityLabel?: string
  testID?: string
}

/**
 * One activity entry: icon in a tinted circle, title (+ optional trailing
 * element) on the first line, an optional subtitle, and a message body.
 * Used for goal/task updates (personal) and running/failed task cards
 * (team) alike.
 */
export function ActivityCard({
  tone = 'neutral',
  icon,
  title,
  subtitle,
  message,
  footer,
  trailing,
  onPress,
  accessibilityLabel,
  testID,
}: ActivityCardProps) {
  const Container = onPress ? Pressable : View
  return (
    <Container
      testID={testID}
      {...(onPress ? { onPress, accessibilityLabel: accessibilityLabel ?? title, className: cn('rounded-2xl border p-4 active:opacity-80', TONE_CARD_CLASSES[tone]) } : { className: cn('rounded-2xl border p-4', TONE_CARD_CLASSES[tone]) })}
    >
      <View className="flex-row items-start gap-3">
        <View className={cn('h-10 w-10 items-center justify-center rounded-xl', TONE_ICON_CLASSES[tone])}>
          {icon}
        </View>
        <View className="min-w-0 flex-1">
          <View className="flex-row items-start gap-2">
            <Text className="flex-1 font-semibold text-foreground" numberOfLines={2}>{title}</Text>
            {trailing}
          </View>
          {subtitle ? <Text className="mt-1 text-xs text-muted-foreground">{subtitle}</Text> : null}
          {message ? (
            typeof message === 'string' ? (
              <Text className="mt-2 text-sm leading-5 text-muted-foreground">{message}</Text>
            ) : (
              <View className="mt-2">{message}</View>
            )
          ) : null}
          {footer ? (
            typeof footer === 'string' ? (
              <Text className="mt-2 text-xs text-muted-foreground">{footer}</Text>
            ) : (
              <View className="mt-2">{footer}</View>
            )
          ) : null}
        </View>
      </View>
    </Container>
  )
}

export interface ActivityEmptyCardProps {
  icon?: ReactNode
  title: string
  message: string
  /** Center content instead of the default icon-left layout (no icon = centered by default). */
  centered?: boolean
}

/** A soft "nothing here" card for a section or an entire activity feed. */
export function ActivityEmptyCard({ icon, title, message, centered = !icon }: ActivityEmptyCardProps) {
  if (centered) {
    return (
      <View className="rounded-2xl border border-dashed border-border px-5 py-8">
        {icon ? <View className="mb-3 items-center">{icon}</View> : null}
        <Text className="text-center text-base font-medium text-foreground">{title}</Text>
        <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">{message}</Text>
      </View>
    )
  }
  return (
    <View className="rounded-2xl border border-dashed border-border bg-card/60 px-4 py-5">
      <View className="flex-row items-center gap-3">
        <View className="h-9 w-9 items-center justify-center rounded-xl bg-muted">
          {icon ?? <CircleAlert size={18} className="text-muted-foreground" />}
        </View>
        <View className="flex-1">
          <Text className="text-base font-medium text-foreground">{title}</Text>
          <Text className="mt-1 text-xs leading-5 text-muted-foreground">{message}</Text>
        </View>
      </View>
    </View>
  )
}

/** Full-bleed centered spinner, shown while a feed's first load is in flight. */
export function ActivityLoadingState() {
  return (
    <View className="flex-1 items-center justify-center py-14">
      <ActivityIndicator />
    </View>
  )
}

export interface ActivityErrorBannerProps {
  message: string
  onRetry: () => void
}

/** Dismissible-by-retry error banner shown above a feed when a (re)load fails. */
export function ActivityErrorBanner({ message, onRetry }: ActivityErrorBannerProps) {
  return (
    <View className="flex-row items-start gap-2 rounded-2xl border border-destructive bg-destructive/10 px-3 py-3">
      <CircleAlert size={18} className="mt-0.5 text-destructive" />
      <Text className="flex-1 text-sm leading-5 text-destructive">{message}</Text>
      <Pressable onPress={onRetry} accessibilityLabel="Try loading activity again" className="rounded-lg px-2 py-1 active:bg-destructive/10">
        <Text className="text-sm font-semibold text-destructive">Try again</Text>
      </Pressable>
    </View>
  )
}
