// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The list for trigger menus ("@" mentions, ":" emoji): optional section
 * headers, a right-aligned hint per row, an "Enter" hint on the highlighted
 * row, rows that open a category (chevron), and an optional footer.
 */
import type { ReactNode } from 'react'
import { Platform, Pressable, ScrollView, Text, View } from 'react-native'
import { ChevronLeft, ChevronRight } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

export interface CompletionMenuRow {
  key: string
  label: string
  subtitle?: string | null
  icon?: ReactNode
  section?: string
  trailing?: string | null
  /** Opens a category instead of inserting. */
  drill?: string
  /** Goes back up from a category. */
  back?: boolean
}

export interface CompletionMenuProps {
  rows: CompletionMenuRow[]
  selectedIndex: number
  onSelect: (index: number) => void
  onHover?: (index: number) => void
  footer?: string | null
  placement?: 'above' | 'below'
  testID?: string
}

export function CompletionMenu({ rows, selectedIndex, onSelect, onHover, footer, placement = 'above', testID }: CompletionMenuProps) {
  if (!rows.length) return null
  return (
    <View
      testID={testID}
      className={cn(
        'absolute left-0 right-0 z-50 max-h-[320px] overflow-hidden rounded-md border border-border bg-popover shadow-md',
        placement === 'above' ? 'bottom-full mb-1' : 'top-full mt-1',
      )}
    >
      <ScrollView keyboardShouldPersistTaps="handled">
        {rows.map((row, i) => (
          <View key={row.key}>
            {row.section ? (
              <Text className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{row.section}</Text>
            ) : null}
            <Pressable
              onPress={() => onSelect(i)}
              onHoverIn={onHover ? () => onHover(i) : undefined}
              accessibilityRole="menuitem"
              accessibilityLabel={row.back ? `Back from ${row.label}` : row.label}
              aria-selected={i === selectedIndex}
              testID={`completion-row-${row.key}`}
              className={cn('w-full flex-row items-center gap-2 px-3 py-1.5', i === selectedIndex ? 'bg-accent' : 'active:bg-accent')}
            >
              {row.back ? <ChevronLeft size={14} className="text-muted-foreground" /> : null}
              {row.icon ? <View className="w-5 items-center">{row.icon}</View> : null}
              <Text className={cn('text-xs text-foreground', row.back ? 'font-semibold' : 'font-medium')} numberOfLines={1}>
                {row.label}
              </Text>
              {row.subtitle ? (
                <Text className="min-w-0 flex-1 text-[10px] text-muted-foreground" numberOfLines={1}>
                  {row.subtitle}
                </Text>
              ) : (
                <View className="flex-1" />
              )}
              {row.trailing ? <Text className="text-[10px] text-muted-foreground">{row.trailing}</Text> : null}
              {i === selectedIndex && Platform.OS === 'web' && !row.drill && !row.back ? (
                <Text className="rounded bg-muted px-1 text-[10px] text-muted-foreground">Enter</Text>
              ) : null}
              {row.drill ? <ChevronRight size={14} className="text-muted-foreground" /> : null}
            </Pressable>
          </View>
        ))}
      </ScrollView>
      {footer ? <Text className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">{footer}</Text> : null}
    </View>
  )
}
