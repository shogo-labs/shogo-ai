// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useMemo, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
} from "react-native";
import { ArrowLeft, ChevronRight } from "lucide-react-native";
import { SettingsContent } from "../../app/(app)/settings";
import { Text } from "../settings/account-sheet-chrome";
import { usePlatformConfig } from "../../lib/platform-config";
import {
  settingsTab,
  type SettingsTabId,
  visibleSettingsTabs,
} from "../../lib/settings-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export function MobileSettingsSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { features, localMode } = usePlatformConfig();
  const [activeTab, setActiveTab] = useState<SettingsTabId | null>(null);
  const isLocal = localMode || !features.billing;
  const tabs = useMemo(
    () =>
      visibleSettingsTabs({
        localMode: isLocal,
        showBilling: features.billing,
        platform: Platform.OS,
      }),
    [features.billing, isLocal]
  );

  useEffect(() => {
    if (!visible) setActiveTab(null);
  }, [visible]);

  const title = activeTab ? settingsTab(activeTab).label : "Settings";

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View className="flex-1 justify-end bg-black/40">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close settings"
          onPress={onClose}
          className="absolute inset-0"
        />
        <View
          className="max-h-[88%] overflow-hidden rounded-t-[28px] bg-card"
          style={{
            height: Math.round(height * 0.86),
            paddingBottom: Math.max(insets.bottom, 16),
          }}
        >
          <View className="items-center pb-2 pt-3">
            <View className="h-1 w-9 rounded-full bg-muted-foreground/30" />
          </View>
          <View className="flex-row items-center px-6 pb-4 pt-2">
            {activeTab ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Back to settings"
                onPress={() => setActiveTab(null)}
                className="-ml-2 mr-2 h-9 w-9 items-center justify-center rounded-full active:bg-muted"
              >
                <ArrowLeft size={18} className="text-foreground" />
              </Pressable>
            ) : null}
            <Text className="flex-1 text-base font-semibold text-foreground">
              {title}
            </Text>
          </View>

          {activeTab ? (
            <ScrollView
              className="flex-1"
              contentContainerClassName="px-5 pt-5"
              contentContainerStyle={{
                paddingBottom: Math.max(insets.bottom + 24, 40),
              }}
              showsVerticalScrollIndicator={false}
            >
              <SettingsContent activeTab={activeTab} localMode={isLocal} />
            </ScrollView>
          ) : (
            <ScrollView
              className="flex-1"
              contentContainerClassName="px-6 py-3"
              showsVerticalScrollIndicator={false}
            >
              {tabs.map(({ id, label, Icon }) => (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${label} settings`}
                  onPress={() => setActiveTab(id)}
                  className="flex-row items-center gap-3 rounded-lg py-4 active:bg-muted/60"
                >
                  <Icon size={19} className="text-foreground" />
                  <Text className="flex-1 text-base text-foreground">
                    {label}
                  </Text>
                  <ChevronRight size={18} className="text-muted-foreground" />
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}
