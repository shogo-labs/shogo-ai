// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Modal, Pressable, ScrollView, Text, View } from "react-native"
import { useBuddyLook } from "../../contexts/buddy-look"
import { useIslandAccent } from "../island/island-accent"
import { BuddyCustomizer } from "../island/buddy/BuddyCustomizer"
import type { BuddyLook } from "../island/buddy/look"
import { NativePhoneSheet } from "../phone/NativePhoneSheet"
import { usePhoneLayout } from "../../lib/native-phone-layout"

/** Edit a look other than the signed-in user's (an agent's, say). Without it the sheet edits your own Shogo. */
export interface BuddyLookTarget {
  look: BuddyLook
  onChange: (look: BuddyLook) => void
  error?: string
  /** Sheet title; defaults to "Dress up your Shogo". */
  title?: string
  /** Offered as "Reset to default" when set. */
  onReset?: () => void
}

interface BuddyLookSheetProps {
  visible: boolean
  onClose: () => void
  target?: BuddyLookTarget
}

const DEFAULT_TITLE = "Dress up your Shogo"

function useLookTarget(target?: BuddyLookTarget): BuddyLookTarget {
  const own = useBuddyLook()
  return target ?? { look: own.look, onChange: own.setLook, error: own.error }
}

function BuddyLookContent({
  target,
  onClose,
  layout = "full",
}: {
  target: BuddyLookTarget
  onClose?: () => void
  layout?: "full" | "compact"
}) {
  const color = useIslandAccent()

  return (
    <View className="gap-3">
      <BuddyCustomizer
        look={target.look}
        onChange={target.onChange}
        color={color}
        previewSize={layout === "compact" ? 130 : 150}
        layout={layout}
      />
      {target.error ? <Text className="text-xs text-destructive">{target.error}</Text> : null}
      {target.onReset ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset to default look"
          onPress={target.onReset}
          className="self-start rounded-lg border border-border px-3 py-1.5 active:bg-muted"
        >
          <Text className="text-xs font-medium text-foreground">Reset to default</Text>
        </Pressable>
      ) : null}
      {onClose ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Done customizing Shogo"
          onPress={onClose}
          className="self-end rounded-lg bg-primary px-4 py-2 active:opacity-80"
        >
          <Text className="text-sm font-semibold text-primary-foreground">Done</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

/** The customizer on its own, to sit on a page instead of in a sheet. */
export function BuddyLookEditor({ target, layout = "full" }: { target: BuddyLookTarget; layout?: "full" | "compact" }) {
  return <BuddyLookContent target={target} layout={layout} />
}

export function BuddyLookSheet({ visible, onClose, target: customTarget }: BuddyLookSheetProps) {
  const isPhone = usePhoneLayout()
  const target = useLookTarget(customTarget)
  const title = target.title ?? DEFAULT_TITLE

  if (isPhone) {
    return (
      <NativePhoneSheet
        visible={visible}
        onClose={onClose}
        title={title}
        headerTitleAlign="left"
        headerRight={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Done customizing Shogo"
            onPress={onClose}
            hitSlop={8}
            className="rounded-lg bg-primary px-4 py-2 active:opacity-80"
          >
            <Text className="text-sm font-semibold text-primary-foreground">Done</Text>
          </Pressable>
        }
        draggable
        maxHeightRatio={0.94}
      >
        <View className="gap-3 px-4 pb-2">
          <BuddyLookContent target={target} layout="compact" />
        </View>
      </NativePhoneSheet>
    )
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 items-center justify-center bg-black/50 p-6">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss Shogo customizer"
          onPress={onClose}
          className="absolute inset-0"
        />
        <View className="max-h-[92%] w-full max-w-5xl rounded-2xl border border-border bg-card p-5">
          <View className="mb-4 flex-row items-center justify-between">
            <View>
              <Text className="text-lg font-semibold text-foreground">{title}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close Shogo customizer"
              onPress={onClose}
              className="rounded-lg px-3 py-2 active:bg-muted"
            >
              <Text className="text-sm font-medium text-muted-foreground">Close</Text>
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled">
            <BuddyLookContent target={target} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}
