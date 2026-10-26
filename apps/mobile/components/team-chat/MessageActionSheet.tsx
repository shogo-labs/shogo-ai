// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The message actions menu, for touch.
 *
 * Web gets `SidebarContextMenu` (a DOM portal with hover flyouts). Native needs
 * the same options in a bottom sheet: `Alert.alert` on Android silently drops
 * everything past three buttons, so a menu this long could not be built on it.
 * A row with `children` swaps the sheet to a second page, which is how Slack
 * presents "Add a reminder".
 *
 * Both platforms render the same `SidebarMenuEntry[][]` groups from
 * `MessageRow`, so the two can't drift apart.
 */
import { useEffect, useState } from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'
import { ChevronLeft, ChevronRight, SmilePlus, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { SidebarMenuEntry, SidebarMenuItem } from '../layout/SidebarContextMenu'

function Row({ item, onPress }: { item: SidebarMenuItem; onPress: () => void }) {
  const hasChildren = !!item.children?.length
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.label}
      accessibilityState={{ disabled: !!item.disabled }}
      disabled={!!item.disabled}
      onPress={onPress}
      className={cn(
        'flex-row items-center gap-3 px-4 py-3 active:bg-muted',
        item.disabled && 'opacity-50',
      )}
    >
      {item.icon ? <View className="w-5 items-center">{item.icon}</View> : null}
      <Text
        className={cn(
          'flex-1 text-[15px]',
          item.danger ? 'text-destructive' : 'text-foreground',
        )}
        numberOfLines={1}
      >
        {item.label}
      </Text>
      {hasChildren ? <ChevronRight size={16} className="text-muted-foreground" /> : null}
    </Pressable>
  )
}

export function MessageActionSheet({
  open,
  onClose,
  groups,
  title,
  reactions,
  onAddReaction,
}: {
  open: boolean
  onClose: () => void
  groups: SidebarMenuEntry[][]
  title?: string
  /** Quick reactions strip at the top. Native has no hover toolbar, so this is its only one. */
  reactions?: Array<{ emoji: string; active?: boolean; onPress: () => void }>
  onAddReaction?: () => void
}) {
  // A submenu page: `null` shows the root menu.
  const [page, setPage] = useState<SidebarMenuItem | null>(null)

  // Reopening must always start at the root, not wherever it was left.
  useEffect(() => {
    if (!open) setPage(null)
  }, [open])

  const visible: SidebarMenuItem[][] = page
    ? [(page.children ?? []).filter((c): c is SidebarMenuItem => !('separator' in c && c.separator))]
    : groups.map((g) => g.filter((e): e is SidebarMenuItem => !('separator' in e && e.separator)))

  const close = () => {
    setPage(null)
    onClose()
  }

  return (
    <Modal visible={open} transparent animationType="fade" statusBarTranslucent onRequestClose={close}>
      <View className="flex-1 justify-end">
        <Pressable
          className="absolute bottom-0 left-0 right-0 top-0 bg-black/40"
          onPress={close}
          accessibilityLabel="Dismiss menu"
        />
        <View className="z-10 mx-3 mb-3 max-h-[70%] overflow-hidden rounded-2xl border border-border bg-card">
          <View className="flex-row items-center gap-2 border-b border-border/60 px-4 py-3">
            {page ? (
              <Pressable
                onPress={() => setPage(null)}
                accessibilityLabel="Back"
                className="h-8 w-8 items-center justify-center rounded-full active:bg-muted"
              >
                <ChevronLeft size={18} className="text-muted-foreground" />
              </Pressable>
            ) : null}
            <Text className="flex-1 text-base font-semibold text-foreground" numberOfLines={1}>
              {page ? page.label : (title ?? 'Message')}
            </Text>
            <Pressable
              onPress={close}
              accessibilityLabel="Close"
              className="h-8 w-8 items-center justify-center rounded-full active:bg-muted"
            >
              <X size={18} className="text-muted-foreground" />
            </Pressable>
          </View>
          <ScrollView bounces={false} keyboardShouldPersistTaps="handled">
            {!page && (reactions?.length || onAddReaction) ? (
              <View className="flex-row items-center gap-1 border-b border-border/60 px-3 py-2">
                {(reactions ?? []).map((r) => (
                  <Pressable
                    key={r.emoji}
                    onPress={() => {
                      close()
                      r.onPress()
                    }}
                    accessibilityLabel={`React ${r.emoji}`}
                    className={cn(
                      'h-9 w-9 items-center justify-center rounded-full active:bg-muted',
                      r.active && 'bg-primary/10',
                    )}
                  >
                    <Text className="text-lg">{r.emoji}</Text>
                  </Pressable>
                ))}
                {onAddReaction ? (
                  <Pressable
                    onPress={() => {
                      close()
                      onAddReaction()
                    }}
                    accessibilityLabel="More reactions"
                    className="h-9 w-9 items-center justify-center rounded-full active:bg-muted"
                  >
                    <SmilePlus size={18} className="text-muted-foreground" />
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {visible.map((group, gi) => (
              <View key={gi} className={gi > 0 ? 'border-t border-border/60' : undefined}>
                {group.map((item, i) => (
                  <Row
                    key={`${gi}-${i}`}
                    item={item}
                    onPress={() => {
                      if (item.children?.length) {
                        setPage(item)
                        return
                      }
                      close()
                      item.onSelect?.()
                    }}
                  />
                ))}
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}
