// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The in-app confirmation for a destructive sidebar action. Replaces
 * `window.confirm` / `Alert.alert` so the prompt looks the same on web and
 * native and can be asserted in a render test.
 */
import { Modal, Pressable, Text, View } from "react-native";
import { X } from "lucide-react-native";

export function ConfirmDeleteDialog({
  visible,
  title,
  message,
  confirmLabel = "Delete",
  onClose,
  onConfirm,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        className="flex-1 bg-black/50 items-center justify-center"
        onPress={onClose}
      >
        <Pressable
          className="bg-card rounded-xl p-6 w-80 border border-border"
          onPress={(e) => e.stopPropagation()}
        >
          <View className="flex-row items-center justify-between mb-1">
            <Text className="text-base font-semibold text-foreground">
              {title}
            </Text>
            <Pressable onPress={onClose} className="p-1" accessibilityLabel="Close">
              <X size={20} className="text-muted-foreground" />
            </Pressable>
          </View>
          <Text className="text-sm text-muted-foreground mb-4">{message}</Text>
          <View className="flex-row gap-2 justify-end">
            <Pressable
              onPress={onClose}
              accessibilityLabel="Cancel"
              className="px-4 py-2 rounded-md border border-border active:bg-muted"
            >
              <Text className="text-sm text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              accessibilityLabel={confirmLabel}
              className="px-4 py-2 rounded-md bg-destructive active:bg-destructive/80"
            >
              <Text className="text-sm text-destructive-foreground">
                {confirmLabel}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
