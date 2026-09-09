// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import React from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { FolderInput, X } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";

export function MoveToFolderModal({
  visible,
  folders,
  onClose,
  onMove,
}: {
  visible: boolean;
  folders: { id: string; name: string }[];
  onClose: () => void;
  onMove: (folderId: string | null) => void;
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
              Move to folder
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
          <ScrollView
            className={
              Platform.OS === "web"
                ? "max-h-[240px] px-5 pb-2"
                : "max-h-[360px] px-5 pb-2"
            }
            showsVerticalScrollIndicator={Platform.OS !== "web"}
            nestedScrollEnabled={Platform.OS !== "web"}
          >
            <Pressable
              onPress={() => onMove(null)}
              className={cn(
                "flex-row items-center gap-3 px-3 py-3 rounded-lg active:bg-muted border border-border mb-2",
                Platform.OS !== "web" && "min-h-12",
              )}
            >
              <FolderInput
                size={Platform.OS === "web" ? 16 : 20}
                className="text-muted-foreground"
              />
              <Text
                className={
                  Platform.OS === "web"
                    ? "text-sm text-foreground"
                    : "text-base text-foreground"
                }
              >
                Root (no folder)
              </Text>
            </Pressable>
            {folders.map((folder) => (
              <Pressable
                key={folder.id}
                onPress={() => onMove(folder.id)}
                className={cn(
                  "flex-row items-center gap-3 px-3 py-3 rounded-lg active:bg-muted border border-border mb-2",
                  Platform.OS !== "web" && "min-h-12",
                )}
              >
                <FolderInput
                  size={Platform.OS === "web" ? 16 : 20}
                  className="text-muted-foreground"
                />
                <Text
                  className={
                    Platform.OS === "web"
                      ? "text-sm text-foreground"
                      : "text-base text-foreground"
                  }
                >
                  {folder.name}
                </Text>
              </Pressable>
            ))}
            {folders.length === 0 && (
              <View className="py-6 items-center">
                <Text className="text-sm text-muted-foreground">
                  No folders yet
                </Text>
              </View>
            )}
          </ScrollView>
          <View className="px-5 pt-2 pb-5 flex-row justify-end">
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
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
