// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  Check,
  ChevronLeft,
  History,
  MessageSquare,
  MoreHorizontal,
  X,
} from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import {
  NATIVE_HEADER_PAD_BOTTOM,
  nativePhoneTitleInset,
} from "../../../../lib/project-topbar-layout";
import {
  NATIVE_PHONE_CONTROL_SIZE,
  NATIVE_PHONE_SHEET_BODY_RATIO,
} from "../../../../lib/native-phone-layout";
import { NativePhoneSheet } from "../../../phone/NativePhoneSheet";
import type { AgentTab } from "../agent-tabs";
import type { TopBarOverlayState } from "../types";
import { NativeCircleButton } from "./NativeCircleButton";
import { NativeClusterIcon, NATIVE_CLUSTER_SLOT } from "./NativeClusterIcon";
import { TrustBadge } from "../TrustBadge";

const NATIVE_HEADER_PAD_X = 12;
const NATIVE_HEADER_PAD_TOP = 4;
const NATIVE_CLUSTER_PAD_X = 6;
const NATIVE_CLUSTER_WIDTH = NATIVE_CLUSTER_PAD_X * 2 + NATIVE_CLUSTER_SLOT * 2;

export function NativePhoneHeader({
  projectName,
  projectMenu,
  onBack,
  showTrustBadge,
  trustLevel,
  onToggleTrust,
  trustBusy,
  narrowActiveTab,
  narrowPrimaryTabs,
  getTabActive,
  handleTabPress,
  onOpenChatSessions,
  chatSessionsOpen,
  overlayState,
}: {
  projectName: string;
  projectMenu: React.ReactNode;
  onBack: () => void;
  showTrustBadge: boolean;
  trustLevel?: "restricted" | "trusted";
  onToggleTrust?: () => void;
  trustBusy?: boolean;
  narrowActiveTab?: "chat" | "canvas";
  narrowPrimaryTabs: AgentTab[];
  getTabActive: (tabId: string) => boolean;
  handleTabPress: (tabId: string) => void;
  onOpenChatSessions?: () => void;
  chatSessionsOpen: boolean;
  overlayState: TopBarOverlayState;
}) {
  const onChat = narrowActiveTab === "chat";
  const showChatMoreCluster = !onChat;
  const leftChrome = NATIVE_HEADER_PAD_X + NATIVE_PHONE_CONTROL_SIZE;
  const rightChrome =
    NATIVE_HEADER_PAD_X +
    (showChatMoreCluster ? NATIVE_CLUSTER_WIDTH : NATIVE_PHONE_CONTROL_SIZE) +
    (showTrustBadge ? NATIVE_PHONE_CONTROL_SIZE + 8 : 0);
  const titleInset = nativePhoneTitleInset(leftChrome, rightChrome);

  return (
    <>
      <View
        className="bg-background"
        testID="project-native-header"
        style={{
          paddingTop: NATIVE_HEADER_PAD_TOP,
          paddingBottom: NATIVE_HEADER_PAD_BOTTOM,
        }}
      >
        <Pressable
          onPress={() => {
            overlayState.setDropdownKey((k) => k + 1);
            overlayState.setShowProjectSheet(true);
          }}
          className="absolute items-center justify-center"
          style={{
            top: NATIVE_HEADER_PAD_TOP,
            height: NATIVE_PHONE_CONTROL_SIZE,
            left: 0,
            right: 0,
            paddingHorizontal: titleInset,
          }}
          accessibilityLabel={`${projectName}. Project options`}
          accessibilityRole="button"
          testID="project-switcher-trigger"
        >
          <Text
            className="text-[17px] font-semibold text-foreground text-center"
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {projectName}
          </Text>
        </Pressable>
        <View
          className="flex-row items-center justify-between"
          pointerEvents="box-none"
          style={{
            height: NATIVE_PHONE_CONTROL_SIZE,
            paddingHorizontal: NATIVE_HEADER_PAD_X,
            zIndex: 2,
          }}
        >
          <NativeCircleButton
            icon={ChevronLeft}
            onPress={onBack}
            accessibilityLabel="Back to home"
            testID="project-native-back"
          />
          <View className="flex-row items-center gap-2">
            {showTrustBadge && trustLevel && onToggleTrust && (
              <TrustBadge
                trustLevel={trustLevel}
                onToggle={onToggleTrust}
                busy={trustBusy}
                compact
              />
            )}
            {showChatMoreCluster ? (
              <View
                className="flex-row items-center rounded-full bg-muted"
                testID="project-native-chat-more-cluster"
                style={{
                  height: NATIVE_PHONE_CONTROL_SIZE,
                  paddingHorizontal: NATIVE_CLUSTER_PAD_X,
                }}
              >
                <NativeClusterIcon
                  icon={MessageSquare}
                  onPress={() => handleTabPress("chat-fullscreen")}
                  accessibilityLabel="Chat"
                  testID="project-native-chat"
                />
                <NativeClusterIcon
                  icon={MoreHorizontal}
                  onPress={() => overlayState.setShowTabsSheet(true)}
                  accessibilityLabel="Project tabs"
                  testID="project-native-more"
                />
              </View>
            ) : (
              <NativeCircleButton
                icon={MoreHorizontal}
                onPress={() => overlayState.setShowTabsSheet(true)}
                accessibilityLabel="Project tabs"
                testID="project-native-more"
              />
            )}
          </View>
        </View>
      </View>

      <NativePhoneSheet
        visible={overlayState.showTabsSheet}
        onClose={() => overlayState.setShowTabsSheet(false)}
        maxHeightRatio={NATIVE_PHONE_SHEET_BODY_RATIO}
      >
        <View className="flex-row items-center px-4 pb-2">
          <NativeCircleButton
            icon={X}
            onPress={() => overlayState.setShowTabsSheet(false)}
            accessibilityLabel="Close"
          />
        </View>
        <ScrollView
          bounces={false}
          keyboardShouldPersistTaps="handled"
          className="px-2"
        >
          {narrowPrimaryTabs
            .filter((tab) => tab.id !== "chat-fullscreen")
            .map((tab) => {
              const Icon = tab.icon;
              const active = getTabActive(tab.id);
              return (
                <Pressable
                  key={tab.id}
                  onPress={() => {
                    handleTabPress(tab.id);
                    overlayState.setShowTabsSheet(false);
                  }}
                  className={cn(
                    "flex-row items-center gap-3 rounded-2xl px-3 py-3.5 min-h-14",
                    active ? "bg-muted" : "active:bg-muted/60",
                  )}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={tab.label}
                >
                  <View
                    className={cn(
                      "h-10 w-10 items-center justify-center rounded-full",
                      active ? "bg-primary" : "bg-background",
                    )}
                  >
                    <Icon
                      size={20}
                      className={
                        active ? "text-primary-foreground" : "text-foreground"
                      }
                    />
                  </View>
                  <Text
                    className={cn(
                      "flex-1 text-base",
                      active
                        ? "font-semibold text-foreground"
                        : "text-foreground",
                    )}
                  >
                    {tab.label}
                  </Text>
                  {active ? <Check size={18} className="text-primary" /> : null}
                </Pressable>
              );
            })}
          {onOpenChatSessions ? (
            <Pressable
              onPress={() => {
                overlayState.setShowTabsSheet(false);
                if (!onChat) handleTabPress("chat-fullscreen");
                onOpenChatSessions();
              }}
              className={cn(
                "flex-row items-center gap-3 rounded-2xl px-3 py-3.5 min-h-14",
                chatSessionsOpen ? "bg-muted" : "active:bg-muted/60",
              )}
              accessibilityLabel={
                chatSessionsOpen ? "Hide chat history" : "Chat history"
              }
            >
              <View className="h-10 w-10 items-center justify-center rounded-full bg-background">
                <History size={20} className="text-foreground" />
              </View>
              <Text className="flex-1 text-base text-foreground">
                Chat history
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </NativePhoneSheet>

      {projectMenu}
    </>
  );
}
