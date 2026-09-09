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
import { X } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";

export function ProjectDetailsModal({
  visible,
  onClose,
  projectName,
  workspaceName,
  ownerName,
  createdAt,
  modifiedAt,
}: {
  visible: boolean;
  onClose: () => void;
  projectName: string;
  workspaceName: string;
  ownerName: string;
  createdAt?: string | number;
  modifiedAt?: string | number;
}) {
  const formatDate = (d?: string | number) => {
    if (!d) return "—";
    const date = new Date(d);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const rows: { label: string; value: string }[] = [
    { label: "Location", value: projectName },
    { label: "Owner", value: ownerName || workspaceName || "—" },
    { label: "Modified", value: formatDate(modifiedAt) },
    { label: "Created", value: formatDate(createdAt) },
  ];

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
          {/* Header */}
          <View className="flex-row items-center justify-between px-5 pt-5 pb-3">
            <Text
              className={
                Platform.OS === "web"
                  ? "text-base font-semibold text-foreground"
                  : "text-lg font-semibold text-foreground"
              }
            >
              Project details
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

          {/* Detail rows */}
          <ScrollView
            className="px-5 pb-2"
            style={{ maxHeight: 420 }}
            showsVerticalScrollIndicator={Platform.OS !== "web"}
            nestedScrollEnabled={Platform.OS !== "web"}
          >
            <View className="border border-border rounded-lg overflow-hidden">
              {rows.map((row, idx) => (
                <View
                  key={row.label}
                  className={cn(
                    "flex-row items-center px-4 py-3",
                    Platform.OS !== "web" && "min-h-12",
                    idx < rows.length - 1 && "border-b border-border",
                  )}
                >
                  <Text
                    className={
                      Platform.OS === "web"
                        ? "text-sm text-muted-foreground w-24"
                        : "text-base text-muted-foreground w-24"
                    }
                  >
                    {row.label}
                  </Text>
                  <Text
                    className={
                      Platform.OS === "web"
                        ? "text-sm text-foreground flex-1"
                        : "text-base text-foreground flex-1"
                    }
                    numberOfLines={1}
                  >
                    {row.value}
                  </Text>
                </View>
              ))}
            </View>
          </ScrollView>

          {/* Footer */}
          <View className="px-5 pt-2 pb-5 flex-row justify-end">
            <Pressable
              onPress={onClose}
              className={
                Platform.OS === "web"
                  ? "px-5 py-2 rounded-lg border border-border active:bg-muted"
                  : "min-h-11 px-5 py-2 rounded-lg border border-border active:bg-muted justify-center"
              }
            >
              <Text
                className={
                  Platform.OS === "web"
                    ? "text-sm font-medium text-foreground"
                    : "text-base font-medium text-foreground"
                }
              >
                Close
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
