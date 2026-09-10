// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Pin, PinOff, Pencil, Trash2 } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";
import type { ReactNode } from "react";
import { NativePhoneSheet } from "../../phone/NativePhoneSheet";

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
      className="min-h-12 flex-row items-center gap-3 rounded-xl px-4 active:bg-muted"
    >
      {icon}
      <Text
        className={
          danger ? "text-base text-destructive" : "text-base text-foreground"
        }
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
      subtitle={projectName}
      animationType="slide"
      testID="native-project-actions-sheet"
    >
      <View className="gap-1 px-2 pb-2">
        <ActionRow
          label="Rename"
          icon={<Pencil size={20} className="text-muted-foreground" />}
          onPress={() => runAction(onRename)}
        />
        <ActionRow
          label={isPinned ? "Unpin project" : "Pin project"}
          icon={
            isPinned ? (
              <PinOff size={20} className="text-muted-foreground" />
            ) : (
              <Pin size={20} className="text-muted-foreground" />
            )
          }
          onPress={() => runAction(onTogglePin)}
        />
        <View className="my-1 h-px bg-border" />
        <ActionRow
          label="Delete project"
          icon={<Trash2 size={20} className="text-destructive" />}
          danger
          onPress={() => runAction(onDelete)}
        />
      </View>
    </NativePhoneSheet>
  );
}
