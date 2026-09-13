// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  View,
} from "react-native";
import { X as XIcon } from "lucide-react-native";
import {
  AccountSheetText as Text,
  AccountSheetTextInput as TextInput,
  accountSheetIcon,
} from "../../settings/account-sheet-chrome";

const X = accountSheetIcon(XIcon);

// ─── CreateWorkspaceModal (free — first workspace only) ────

export function CreateWorkspaceModal({
  visible,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give your workspace a name to continue.");
      return;
    }
    onSubmit(trimmed);
    setName("");
    setError(null);
    onClose();
  }, [name, onSubmit, onClose]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
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
              Create new workspace
            </Text>
            <Pressable onPress={onClose} className="p-1">
              <X size={20} className="text-muted-foreground" />
            </Pressable>
          </View>
          <Text className="text-sm text-muted-foreground mb-4">
            Create a new workspace for your team or projects
          </Text>
          <Text className="text-sm font-medium text-foreground mb-1.5">
            Workspace name
          </Text>
          <TextInput
            value={name}
            onChangeText={(t) => {
              setName(t);
              if (error) setError(null);
            }}
            placeholder="e.g. My Team, Acme Corp"
            placeholderTextColor="#9ca3af"
            className="border border-border rounded-md px-3 py-2 text-sm text-foreground bg-background"
            autoFocus={Platform.OS === "web"}
            onSubmitEditing={handleSubmit}
          />
          <Text className="text-xs text-muted-foreground mt-1.5 mb-3">
            You can rename it later in settings.
          </Text>
          {error && (
            <Text className="text-xs text-destructive mb-3">{error}</Text>
          )}
          <View className="flex-row gap-2 justify-end">
            <Pressable
              onPress={onClose}
              className="px-4 py-2 rounded-md border border-border active:bg-muted"
            >
              <Text className="text-sm text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleSubmit}
              className="px-4 py-2 rounded-md bg-primary active:bg-primary/80"
            >
              <Text className="text-sm text-primary-foreground">
                Create workspace
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
