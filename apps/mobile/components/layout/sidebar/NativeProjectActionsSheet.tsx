// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Pin, PinOff, Pencil, Trash2 } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";
import type { ReactNode } from "react";
import { cn } from "@shogo/shared-ui/primitives";
import { PHONE_DENSITY } from "../../../lib/phone-density";
import { NativePhoneSheet } from "../../phone/NativePhoneSheet";

const ACTION_ICON_SIZE = PHONE_DENSITY.icon.lg;

interface NativeProjectActionsSheetProps {
  visible: boolean;
  projectName: string;
  isPinned: boolean;
  onClose: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}

function ActionRow({
  label,
  icon,
  danger = false,
  onPress,
}: {
  label: string;
  icon: ReactNode;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className={cn(
        "flex-row items-center gap-3.5 rounded-xl px-4 py-3.5 active:bg-muted",
        PHONE_DENSITY.rowMin,
      )}
    >
      {icon}
      <Text
        className={cn(
          PHONE_DENSITY.text.body,
          danger ? "text-destructive" : "text-foreground",
        )}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function NativeProjectActionsSheet({
  visible,
  projectName,
  isPinned,
  onClose,
  onRename,
  onTogglePin,
  onDelete,
}: NativeProjectActionsSheetProps) {
  const runAction = (action: () => void) => {
    onClose();
    action();
  };

  return (
    <NativePhoneSheet
      visible={visible}
      onClose={onClose}
      title="Project actions"
      animationType="slide"
      testID="native-project-actions-sheet"
    >
      <View
        accessibilityLabel={`Project actions for ${projectName}`}
        className="gap-1 px-2 pb-3"
      >
        <ActionRow
          label="Rename"
          icon={
            <Pencil
              size={ACTION_ICON_SIZE}
              className="text-muted-foreground"
            />
          }
          onPress={() => runAction(onRename)}
        />
        <ActionRow
          label={isPinned ? "Unpin project" : "Pin project"}
          icon={
            isPinned ? (
              <PinOff
                size={ACTION_ICON_SIZE}
                className="text-muted-foreground"
              />
            ) : (
              <Pin
                size={ACTION_ICON_SIZE}
                className="text-muted-foreground"
              />
            )
          }
          onPress={() => runAction(onTogglePin)}
        />
        <View className="my-1 h-px bg-border" />
        <ActionRow
          label="Delete project"
          icon={
            <Trash2 size={ACTION_ICON_SIZE} className="text-destructive" />
          }
          danger
          onPress={() => runAction(onDelete)}
        />
      </View>
    </NativePhoneSheet>
  );
}
