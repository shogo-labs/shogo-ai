// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Small destructive-confirmation modal shared by the People tab dialogs
 * (remove member, leave workspace). Works the same on web and native, unlike
 * `window.confirm`.
 */
import type { ReactNode } from "react";
import { Modal, Pressable, View } from "react-native";
import { X } from "lucide-react-native";
import { Button } from "@shogo/shared-ui/primitives";
import { Text, useAccountSheetIcons } from "../account-sheet-chrome";

const ICONS = { X } as const;

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  testID?: string;
}

export function ConfirmDialog({
  visible,
  title,
  children,
  confirmLabel,
  busyLabel,
  busy,
  error,
  onCancel,
  onConfirm,
  testID,
}: ConfirmDialogProps) {
  const { X: CloseIcon } = useAccountSheetIcons(ICONS);
  const dismiss = () => {
    if (!busy) onCancel();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={dismiss}
    >
      <Pressable
        className="flex-1 bg-black/50 justify-center items-center px-6"
        onPress={dismiss}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className="bg-background rounded-xl p-6 w-full max-w-sm gap-4"
          testID={testID}
        >
          <View className="flex-row items-start justify-between gap-3">
            <Text className="flex-1 text-lg font-semibold text-foreground">
              {title}
            </Text>
            <Pressable
              onPress={dismiss}
              className="p-1"
              accessibilityLabel="Close"
            >
              <CloseIcon size={20} className="text-muted-foreground" />
            </Pressable>
          </View>
          <View className="gap-2">{children}</View>
          {error ? (
            <Text
              className="text-sm text-destructive"
              testID={testID ? `${testID}-error` : undefined}
            >
              {error}
            </Text>
          ) : null}
          <View className="flex-row gap-2 justify-end">
            <Button
              variant="outline"
              size="sm"
              onPress={onCancel}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onPress={onConfirm}
              disabled={busy}
              testID={testID ? `${testID}-confirm` : undefined}
            >
              {busy ? busyLabel : confirmLabel}
            </Button>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
