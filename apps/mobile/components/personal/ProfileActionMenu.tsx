// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Responsive presentation for the companion's profile actions.
 *
 * Phone-size layouts (native handset, or narrow web) keep the full-width
 * bottom sheet — it's the natural "more" surface for touch. Desktop / wide
 * web instead anchors a small dropdown directly under the trigger, since a
 * window-wide bottom sheet reads as a mistake on a large screen.
 *
 * Both presentations render the same `ProfileActionRows` so the actions
 * (Change avatar, Rename, Personality, ...) never drift between them.
 */
import { useCallback, type ComponentType, type ReactNode } from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'
import {
  Activity,
  Image as ImageIcon,
  MessagesSquare,
  PenLine,
  Sparkles,
  X,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Popover, PopoverBackdrop, PopoverBody, PopoverContent } from '../ui/popover'
import { usePhoneLayout } from '../../lib/native-phone-layout'

export type ProfileActionIcon = ComponentType<{ size?: number; className?: string }>

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

function ProfileActionRows({
  actions,
  onActionPress,
}: {
  actions: ProfileActionSheetAction[]
  onActionPress: (action: ProfileActionSheetAction) => void
}) {
  return (
    <>
      {actions.map((action, index) => (
        <Pressable
          key={action.id}
          onPress={() => onActionPress(action)}
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
    </>
  )
}

export interface ProfileActionMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  subtitle?: string
  actions: ProfileActionSheetAction[]
  /** Anchor rendered inline (desktop dropdown) or standalone (phone sheet trigger). */
  trigger: (triggerProps: Record<string, unknown>) => ReactNode
}

/** Desktop / wide web: dropdown anchored directly under the trigger. */
function ProfileActionDropdown({
  open,
  onOpenChange,
  title,
  subtitle,
  actions,
  trigger,
}: ProfileActionMenuProps) {
  const openMenu = useCallback(() => onOpenChange(true), [onOpenChange])
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  return (
    <Popover
      placement="bottom"
      size="sm"
      isOpen={open}
      onOpen={openMenu}
      onClose={close}
      trigger={trigger}
    >
      <PopoverBackdrop />
      <PopoverContent className="w-[320px] p-0">
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
        </View>
        <PopoverBody>
          <ProfileActionRows
            actions={actions}
            onActionPress={(action) => {
              close()
              action.onPress()
            }}
          />
        </PopoverBody>
      </PopoverContent>
    </Popover>
  )
}

/** Phone-size layouts: full-width bottom sheet (unchanged UX). */
function ProfileActionBottomSheet({
  open,
  onOpenChange,
  title,
  subtitle,
  actions,
  trigger,
}: ProfileActionMenuProps) {
  const close = () => onOpenChange(false)
  return (
    <>
      {trigger({ onPress: () => onOpenChange(true) })}
      {open ? (
        <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={close}>
          <View className="flex-1 justify-end">
            <Pressable
              className="absolute left-0 right-0 top-0 bottom-0 bg-black/40"
              onPress={close}
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
                  onPress={close}
                  accessibilityLabel="Close"
                  className="h-8 w-8 items-center justify-center rounded-full active:bg-muted"
                >
                  <X size={18} className="text-muted-foreground" />
                </Pressable>
              </View>
              <ScrollView bounces={false} keyboardShouldPersistTaps="handled">
                <ProfileActionRows
                  actions={actions}
                  onActionPress={(action) => {
                    close()
                    action.onPress()
                  }}
                />
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
    </>
  )
}

/**
 * Renders a dropdown on desktop / wide web and a bottom sheet on phone-size
 * layouts (native handset, or narrow web). See module docblock.
 */
export function ProfileActionMenu(props: ProfileActionMenuProps) {
  const isPhone = usePhoneLayout()
  return isPhone ? <ProfileActionBottomSheet {...props} /> : <ProfileActionDropdown {...props} />
}
