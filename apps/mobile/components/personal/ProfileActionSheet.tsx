// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The header's profile action sheet: everything you can do to/with your
 * companion from one tap on its avatar/name. Every action except "Activity"
 * is chat-first (prefills the primary composer with a starter prompt) —
 * consistent with the companion shell's "English is the interface"
 * philosophy (see the plan doc). "Activity" navigates because it's already
 * its own read surface, not a conversation.
 */
import type { ComponentType } from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'
import { Activity, Image as ImageIcon, MessagesSquare, PenLine, Sparkles, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

type ProfileActionIcon = ComponentType<{ size?: number; className?: string }>

export interface ProfileActionSheetAction {
  id: string
  label: string
  hint: string
  Icon: ProfileActionIcon
  onPress: () => void
}

export function buildDefaultProfileActions(opts: {
  agentName: string
  onPrefill: (content: string) => void
  onOpenActivity: () => void
  onOpenSideChats?: () => void
}): ProfileActionSheetAction[] {
  return [
    {
      id: 'avatar',
      label: 'Change avatar',
      hint: `Generate a new look for ${opts.agentName}`,
      Icon: ImageIcon,
      onPress: () => opts.onPrefill('I want to change your avatar to '),
    },
    {
      id: 'rename',
      label: 'Rename',
      hint: 'Give your companion a different name',
      Icon: PenLine,
      onPress: () => opts.onPrefill(`I want to rename you from ${opts.agentName} to `),
    },
    {
      id: 'personality',
      label: 'Personality',
      hint: 'Tune how it talks and what it focuses on',
      Icon: Sparkles,
      onPress: () => opts.onPrefill('I want you to be more '),
    },
    {
      id: 'memory',
      label: 'What I remember',
      hint: 'Ask what it knows about your goals so far',
      Icon: Activity,
      onPress: () => opts.onPrefill('What do you remember about me and my goals so far?'),
    },
    {
      id: 'activity',
      label: 'Activity',
      hint: 'See everything it has done and is working on',
      Icon: Activity,
      onPress: opts.onOpenActivity,
    },
    ...(opts.onOpenSideChats
      ? [
          {
            id: 'side-chats',
            label: 'Side chats',
            hint: 'Explore a tangent without derailing the main conversation',
            Icon: MessagesSquare,
            onPress: opts.onOpenSideChats,
          },
        ]
      : []),
  ]
}

export function ProfileActionSheet({
  visible,
  onClose,
  title,
  subtitle,
  actions,
}: {
  visible: boolean
  onClose: () => void
  title: string
  subtitle?: string
  actions: ProfileActionSheetAction[]
}) {
  if (!visible) return null

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View className="flex-1 justify-end">
        <Pressable
          className="absolute left-0 right-0 top-0 bottom-0 bg-black/40"
          onPress={onClose}
          accessibilityLabel="Dismiss menu"
        />
        <View className="z-10 mx-3 mb-3 overflow-hidden rounded-2xl border border-border bg-card">
          <View className="flex-row items-center justify-between border-b border-border/60 px-4 py-3">
            <View className="min-w-0 flex-1 pr-3">
              <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
                {title}
              </Text>
              {subtitle ? (
                <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
            <Pressable
              onPress={onClose}
              accessibilityLabel="Close"
              className="h-8 w-8 items-center justify-center rounded-full active:bg-muted"
            >
              <X size={18} className="text-muted-foreground" />
            </Pressable>
          </View>
          <ScrollView bounces={false} keyboardShouldPersistTaps="handled">
            {actions.map((action, index) => (
              <Pressable
                key={action.id}
                onPress={() => {
                  onClose()
                  action.onPress()
                }}
                className={cn(
                  'flex-row items-center gap-3 px-4 py-3.5 active:bg-muted/50',
                  index < actions.length - 1 && 'border-b border-border/40',
                )}
                accessibilityRole="button"
                accessibilityLabel={action.label}
              >
                <View className="h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                  <action.Icon size={18} className="text-primary" />
                </View>
                <View className="min-w-0 flex-1">
                  <Text className="text-sm font-medium text-foreground">{action.label}</Text>
                  <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
                    {action.hint}
                  </Text>
                </View>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}
