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
import {
  ArrowLeft,
  Briefcase,
  ChevronRight,
  Folder,
} from "lucide-react-native";
import {
  SettingsContent,
  WorkspaceAccountActions,
} from "../../app/(app)/settings";
import { Text } from "../settings/account-sheet-chrome";
import { ProjectSettingsContent } from "../settings/ProjectSettingsContent";
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
  projectId,
  openProjectSettings = false,
}: {
  visible: boolean;
  onClose: () => void;
  projectId?: string;
  openProjectSettings?: boolean;
}) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { features, localMode } = usePlatformConfig();
  const [activeTab, setActiveTab] = useState<SettingsTabId | null>(null);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [workspaceActionsOpen, setWorkspaceActionsOpen] = useState(false);
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
    if (!visible) {
      setActiveTab(null);
      setProjectSettingsOpen(false);
      setWorkspaceActionsOpen(false);
      return;
    }
    setProjectSettingsOpen(openProjectSettings && !!projectId);
  }, [openProjectSettings, projectId, visible]);

  const title = projectSettingsOpen
    ? "Project settings"
    : workspaceActionsOpen
    ? "Workspace actions"
    : activeTab
    ? settingsTab(activeTab).label
    : "Settings";

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View className="flex-1 justify-end">
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
            {activeTab || projectSettingsOpen || workspaceActionsOpen ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Back to settings"
                onPress={() => {
                  setActiveTab(null);
                  setProjectSettingsOpen(false);
                  setWorkspaceActionsOpen(false);
                }}
                className="-ml-2 mr-2 h-9 w-9 items-center justify-center rounded-full active:bg-muted"
              >
                <ArrowLeft size={18} className="text-foreground" />
              </Pressable>
            ) : null}
            <Text className="flex-1 text-base font-semibold text-foreground">
              {title}
            </Text>
          </View>

          {activeTab || projectSettingsOpen || workspaceActionsOpen ? (
            <ScrollView
              className="flex-1"
              contentContainerClassName="px-5 pt-5"
              contentContainerStyle={{
                paddingBottom: Math.max(insets.bottom + 24, 40),
              }}
              showsVerticalScrollIndicator={false}
            >
              {projectSettingsOpen && projectId ? (
                <ProjectSettingsContent projectId={projectId} />
              ) : workspaceActionsOpen ? (
                <WorkspaceAccountActions
                  onSelectTab={setActiveTab}
                  showWorkspace={false}
                  showSignOut={false}
                  showActionsHeading={false}
                />
              ) : activeTab ? (
                <SettingsContent
                  activeTab={activeTab}
                  localMode={isLocal}
                  onSelectTab={setActiveTab}
                />
              ) : null}
            </ScrollView>
          ) : (
            <ScrollView
              className="flex-1"
              contentContainerClassName="px-6 py-3"
              showsVerticalScrollIndicator={false}
            >
              <WorkspaceAccountActions
                onSelectTab={setActiveTab}
                showActions={false}
                showSignOut={false}
              />
              {projectId ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Open project settings"
                  onPress={() => setProjectSettingsOpen(true)}
                  className="flex-row items-center gap-3 rounded-lg py-4 active:bg-muted/60"
                >
                  <Folder size={19} className="text-primary" />
                  <Text className="flex-1 text-base text-foreground">
                    Project settings
                  </Text>
                  <ChevronRight size={18} className="text-muted-foreground" />
                </Pressable>
              ) : null}
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
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open workspace actions"
                onPress={() => setWorkspaceActionsOpen(true)}
                className="flex-row items-center gap-3 rounded-lg py-4 active:bg-muted/60"
              >
                <Briefcase size={19} className="text-foreground" />
                <Text className="flex-1 text-base text-foreground">
                  Workspace actions
                </Text>
                <ChevronRight size={18} className="text-muted-foreground" />
              </Pressable>
              <WorkspaceAccountActions
                onSelectTab={setActiveTab}
                showWorkspace={false}
                showActions={false}
              />
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}
