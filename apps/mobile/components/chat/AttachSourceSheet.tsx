// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { type ReactNode } from "react"
import { Modal, View, Text, Pressable, ScrollView, useWindowDimensions } from "react-native"
import { Camera, FolderOpen, Image as ImageIcon, X } from "lucide-react-native"
import {
  executeNativeAttachAction,
  type NativeAttachAction,
  type NativeAttachPickerOptions,
} from "../../lib/native-attachment-picker"
import { ComposerPlusCloseContext } from "./ComposerPlusMenu"

export { ComposerPlusCloseContext, useComposerPlusClose } from "./ComposerPlusMenu"

export interface AttachSourceSheetProps extends NativeAttachPickerOptions {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Extra home-composer actions (mode, stack, environment, project source). */
  children?: ReactNode
}

const ROWS: {
  action: NativeAttachAction
  label: string
  hint: string
  Icon: typeof Camera
}[] = [
  {
    action: "documents",
    label: "Browse files",
    hint: "Any file type",
    Icon: FolderOpen,
  },
  {
    action: "camera",
    label: "Take photo",
    hint: "Use your camera",
    Icon: Camera,
  },
  {
    action: "library",
    label: "Photo library",
    hint: "Pick from your gallery",
    Icon: ImageIcon,
  },
]

export function AttachSourceSheet({
  open,
  onOpenChange,
  children,
  ...opts
}: AttachSourceSheetProps) {
  const { height } = useWindowDimensions()
  const close = () => onOpenChange(false)
  const handleSelect = (action: NativeAttachAction) => {
    onOpenChange(false)
    executeNativeAttachAction(action, opts)
  }
  const hasExtras = children != null
  const maxBodyHeight = Math.round(height * 0.72)

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={close}
    >
      <ComposerPlusCloseContext.Provider value={close}>
        <View className="flex-1 justify-end">
          <Pressable
            className="absolute left-0 right-0 top-0 bottom-0 bg-black/60"
            onPress={close}
            role="button"
            accessibilityLabel="Dismiss attach menu"
          />
          <View className="z-10 w-full rounded-t-3xl border border-outline-100 border-b-0 bg-background-0 pb-safe shadow-hard-5">
            <View className="items-center pt-2 pb-1">
              <View className="h-1 w-12 rounded-full bg-background-400" />
            </View>

            <View className="flex-row items-start justify-between px-5 pb-2 pt-1">
              <View className="flex-1 pr-2">
                <Text className="text-lg font-semibold text-typography-900">
                  {hasExtras ? "Add" : "Attach"}
                </Text>
                <Text className="text-sm text-typography-500">
                  {hasExtras ? "Files, project setup, and run options" : "Choose a source"}
                </Text>
              </View>
              <Pressable
                onPress={close}
                hitSlop={8}
                className="rounded-full p-2 active:bg-background-100"
                role="button"
                accessibilityLabel="Close"
              >
                <X size={22} className="text-typography-500" />
              </Pressable>
            </View>

            <ScrollView
              style={{ maxHeight: maxBodyHeight }}
              bounces={false}
              keyboardShouldPersistTaps="handled"
            >
              <View className="px-2 pb-1">
                {ROWS.map(({ action, label, hint, Icon }) => (
                  <Pressable
                    key={action}
                    onPress={() => handleSelect(action)}
                    className="flex-row items-center gap-3 rounded-xl px-3 py-3.5 active:bg-background-50"
                  >
                    <View className="rounded-xl bg-background-100 p-2.5">
                      <Icon size={22} className="text-primary" />
                    </View>
                    <View className="flex-1 min-w-0">
                      <Text className="text-base font-medium text-typography-900">{label}</Text>
                      <Text className="text-sm text-typography-500">{hint}</Text>
                    </View>
                  </Pressable>
                ))}
              </View>
              {hasExtras ? (
                <View className="border-t border-outline-100 px-2 pb-3 pt-2">
                  {children}
                </View>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </ComposerPlusCloseContext.Provider>
    </Modal>
  )
}
