// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** `#eng › Thread › Agent · session`: how deep you are, and the way back up. */

import { Fragment } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ChevronRight } from 'lucide-react-native'
import { sessionCrumbs } from '../../lib/team-chat-nav'

export interface TrailItem {
  key: string
  label: string
  /** Tapping steps back up to here; the item you are on has none. */
  onPress?: () => void
}

export function Breadcrumb({ items, className }: { items: TrailItem[]; className?: string }) {
  return (
    <View accessibilityRole="header" className={className ?? 'flex-row flex-wrap items-center gap-x-1'}>
      {items.map((item, i) => (
        <Fragment key={item.key}>
          {i > 0 && <ChevronRight size={12} className="text-muted-foreground" />}
          {item.onPress ? (
            <Pressable accessibilityLabel={`Back to ${item.label}`} onPress={item.onPress} className="rounded px-1 py-0.5 active:bg-muted hover:bg-muted">
              <Text className="text-xs text-muted-foreground">{item.label}</Text>
            </Pressable>
          ) : (
            <Text className="px-1 text-xs font-medium text-foreground" accessibilityLabel={`Current: ${item.label}`}>
              {item.label}
            </Text>
          )}
        </Fragment>
      ))}
    </View>
  )
}

/** The trail above an agent session that was opened from a team chat. */
export function SessionBreadcrumb({ params }: { params: Record<string, string | string[] | undefined> }) {
  const router = useRouter()
  const crumbs = sessionCrumbs(params)
  if (!crumbs) return null
  return (
    <Breadcrumb
      className="flex-row flex-wrap items-center gap-x-1 border-b border-border bg-background px-4 py-2"
      items={crumbs.map((c) => ({ key: c.key, label: c.label, onPress: c.to ? () => router.navigate(c.to as any) : undefined }))}
    />
  )
}
