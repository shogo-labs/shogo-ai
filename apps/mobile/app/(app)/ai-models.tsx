// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ArrowLeft, BrainCircuit } from "lucide-react-native";
import AdminSettingsPage from "../(admin)/settings";

/**
 * Mobile entry point for the super-admin model catalog. It deliberately
 * reuses the established management surface without mounting the Admin
 * layout, so the page has a focused back affordance instead of a sidebar.
 */
export default function AIModelsPage() {
  const router = useRouter();

  return (
    <View className="flex-1 bg-background">
      <View className="min-h-16 flex-row items-center gap-3 border-b border-border/70 px-4 py-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to chat"
          onPress={() => router.back()}
          className="h-11 w-11 items-center justify-center rounded-full active:bg-muted"
        >
          <ArrowLeft size={22} className="text-foreground" />
        </Pressable>
        <View className="min-w-0 flex-1">
          <View className="flex-row items-center gap-2">
            <BrainCircuit size={18} className="text-primary" />
            <Text className="text-lg font-semibold text-foreground">
              AI &amp; Models
            </Text>
          </View>
          <Text className="text-xs text-muted-foreground">
            Configure providers and available models
          </Text>
        </View>
      </View>
      <AdminSettingsPage />
    </View>
  );
}
