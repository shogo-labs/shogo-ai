// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A Kanban column: a header, a scrolling stack of cards, and (on web) a drop
 * target. Board columns, the My work board view and the Tasks board use it.
 */
import { useState, type ReactNode } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { DropZone } from './drag'

export interface LaneProps {
  title: string
  count: ReactNode
  /** Read aloud instead of the bare count, e.g. "3 of 5 cards". */
  countLabel?: string
  countClassName?: string
  /** Extra header bits after the count: SLA badges, the column's agent. */
  badges?: ReactNode
  right?: ReactNode
  /** Accepts dropped cards when set. */
  onDropCard?: (itemId: string) => void
  dragging?: boolean
  children: ReactNode
  footer?: ReactNode
  testID?: string
  /**
   * Phone layout: a fixed width (so columns can snap) and a height that hugs
   * the cards up to `maxHeight` instead of filling the screen.
   */
  fixedWidth?: number
  maxHeight?: number
}

export function Lane({ title, count, countLabel, countClassName, badges, right, onDropCard, dragging, children, footer, testID, fixedWidth, maxHeight }: LaneProps) {
  const [over, setOver] = useState(false)
  const body = (
    <View
      className={cn('rounded-lg bg-muted/40 p-2', fixedWidth ? 'shrink' : 'w-72 flex-1', over && dragging && 'bg-primary/10')}
      style={fixedWidth ? { width: fixedWidth, maxHeight } : undefined}
      testID={testID}
    >
      <View className="mb-2 flex-row items-center gap-1.5 px-1">
        <Text className="min-w-0 shrink text-sm font-semibold text-foreground" numberOfLines={1}>{title}</Text>
        <Text className={cn('text-xs text-muted-foreground', countClassName)} accessibilityLabel={countLabel}>{count}</Text>
        {badges}
        <View className="flex-1" />
        {right}
      </View>
      <ScrollView className={fixedWidth ? 'grow-0 shrink' : 'flex-1'} contentContainerClassName="gap-2 pb-1">
        {children}
        {footer}
      </ScrollView>
    </View>
  )
  if (!onDropCard) return body
  return (
    <DropZone grow onDrop={onDropCard} onHover={setOver}>
      {body}
    </DropZone>
  )
}
