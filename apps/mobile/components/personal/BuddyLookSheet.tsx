// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Modal, Pressable, ScrollView, Text, View } from "react-native"
import { useBuddyLook } from "../../contexts/buddy-look"
import { useIslandAccent } from "../island/island-accent"
import { BuddyCustomizer } from "../island/buddy/BuddyCustomizer"
import { NativePhoneSheet } from "../phone/NativePhoneSheet"
import { usePhoneLayout } from "../../lib/native-phone-layout"

interface BuddyLookSheetProps {
  visible: boolean
  onClose: () => void
}

function BuddyLookContent({ onClose, layout = "full" }: { onClose?: () => void; layout?: "full" | "compact" }) {
  const buddy = useBuddyLook()
  const color = useIslandAccent()

  return (
    <View className="gap-3">
      <BuddyCustomizer
        look={buddy.look}
        onChange={buddy.setLook}
        color={color}
        previewSize={layout === "compact" ? 130 : 150}
        layout={layout}
      />
      {buddy.error ? <Text className="text-xs text-destructive">{buddy.error}</Text> : null}
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

export function BuddyLookSheet({ visible, onClose }: BuddyLookSheetProps) {
  const isPhone = usePhoneLayout()

  if (isPhone) {
    return (
      <NativePhoneSheet
        visible={visible}
        onClose={onClose}
        title="Dress up your Shogo"
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
          <BuddyLookContent layout="compact" />
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
              <Text className="text-lg font-semibold text-foreground">Dress up your Shogo</Text>
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
            <BuddyLookContent />
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}
