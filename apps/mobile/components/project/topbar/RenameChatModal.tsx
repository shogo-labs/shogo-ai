// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import React from "react";
import {
  Modal,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { X } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";

export function RenameChatModal({
  visible,
  currentName,
  onChangeName,
  onClose,
  onSave,
}: {
  visible: boolean;
  currentName: string;
  onChangeName: (v: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType={Platform.OS === "web" ? "fade" : "slide"}
      onRequestClose={onClose}
    >
      <Pressable
        onPress={onClose}
        className="flex-1 bg-black/50 items-center justify-center px-6"
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className="bg-background rounded-xl w-full max-w-sm shadow-xl overflow-hidden"
        >
          <View className="flex-row items-center justify-between px-5 pt-5 pb-3">
            <Text
              className={
                Platform.OS === "web"
                  ? "text-base font-semibold text-foreground"
                  : "text-lg font-semibold text-foreground"
              }
            >
              Rename chat
            </Text>
            <Pressable
              onPress={onClose}
              className={
                Platform.OS === "web"
                  ? "p-1 -mr-1 rounded-md active:bg-muted"
                  : "h-10 w-10 -mr-2 items-center justify-center rounded-lg active:bg-muted"
              }
            >
              <X
                size={Platform.OS === "web" ? 18 : 20}
                className="text-muted-foreground"
              />
            </Pressable>
          </View>
          <View className="px-5 pb-4">
            <TextInput
              value={currentName}
              onChangeText={onChangeName}
              placeholder="Chat name"
              placeholderTextColor="#9ca3af"
              className={
                Platform.OS === "web"
                  ? "border border-border rounded-lg px-3 py-2.5 text-sm text-foreground web:outline-none"
                  : "min-h-12 border border-border rounded-lg px-3 py-3 text-base text-foreground"
              }
              autoFocus
              selectTextOnFocus
            />
          </View>
          <View className="px-5 pb-5 flex-row justify-end gap-2">
            <Pressable
              onPress={onClose}
              className={
                Platform.OS === "web"
                  ? "px-4 py-2 rounded-lg border border-border active:bg-muted"
                  : "min-h-11 px-4 py-2 rounded-lg border border-border active:bg-muted justify-center"
              }
            >
              <Text
                className={
                  Platform.OS === "web"
                    ? "text-sm font-medium text-foreground"
                    : "text-base font-medium text-foreground"
                }
              >
                Cancel
              </Text>
            </Pressable>
            <Pressable
              onPress={onSave}
              className={cn(
                "px-4 py-2 rounded-lg justify-center",
                Platform.OS !== "web" && "min-h-11",
                currentName.trim()
                  ? "bg-primary active:opacity-80"
                  : "bg-muted",
              )}
            >
              <Text
                className={cn(
                  Platform.OS === "web"
                    ? "text-sm font-medium"
                    : "text-base font-medium",
                  currentName.trim()
                    ? "text-primary-foreground"
                    : "text-muted-foreground",
                )}
              >
                Save
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
