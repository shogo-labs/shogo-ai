// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import React from "react";
import { Platform, Pressable, Text, View } from "react-native";
import {
  ChevronLeft,
  ChevronRight,
  FolderInput,
  Info,
  Pencil,
  Share2,
  Star,
  Settings,
  Upload,
} from "lucide-react-native";
import { cn, Badge } from "@shogo/shared-ui/primitives";
import type { UsageWindows } from "@shogo/shared-app/hooks";
import type { UsageOverageContext } from "../../../../lib/billing-config";
import { CompactUsageWindows } from "../../../billing/UsageWindows";
import { usePlatformConfig } from "../../../../lib/platform-config";
import { NativeSheetCircleAction } from "../native/NativeSheetCircleAction";
import { AppearanceMenu } from "./AppearanceMenu";

export function ProjectMenuView({
  projectId: _projectId,
  projectName,
  workspaceName,
  planLabel,
  usageWindows,
  usageOverage,
  onGoToDashboard,
  onSwitchProject,
  onClose,
  router,
  ownerName: _ownerName,
  projectCreatedAt: _projectCreatedAt,
  projectModifiedAt: _projectModifiedAt,
  isStarred,
  onRenameProject: _onRenameProject,
  onToggleStar,
  onMoveToFolder: _onMoveToFolder,
  folders: _folders,
  canvasThemeSupported,
  variant = "popover",
  isExporting = false,
  onRequestRename,
  onRequestExport,
  onRequestDetails,
  onRequestMove,
}: {
  projectId: string;
  projectName: string;
  workspaceName: string;
  planLabel: string;
  usageWindows?: UsageWindows;
  usageOverage?: UsageOverageContext;
  onGoToDashboard: () => void;
  onSwitchProject: () => void;
  onClose: () => void;
  router: any;
  ownerName: string;
  projectCreatedAt?: string | number;
  projectModifiedAt?: string | number;
  isStarred: boolean;
  onRenameProject?: (newName: string) => void;
  onToggleStar?: () => void;
  onMoveToFolder?: (folderId: string | null) => void;
  folders: { id: string; name: string }[];
  canvasThemeSupported?: boolean | null;
  variant?: "popover" | "sheet";
  isExporting?: boolean;
  onRequestRename: () => void;
  onRequestExport: () => void;
  onRequestDetails: () => void;
  onRequestMove: () => void;
}) {
  const isNative = Platform.OS !== "web";
  const { features } = usePlatformConfig();
  const showBilling = features.billing;

  const menuItems: {
    id: string;
    icon: React.ElementType;
    label: string;
    onPress: () => void;
    trailing?: React.ReactNode;
  }[] = [
    {
      id: "settings",
      icon: Settings,
      label: "Settings",
      onPress: () => {
        onClose();
        router.push("/(app)/settings" as any);
      },
      trailing: (
        <Text className="text-[11px] text-muted-foreground font-mono">
          {Platform.OS === "web" ? "\u2318." : ""}
        </Text>
      ),
    },
    {
      id: "rename",
      icon: Pencil,
      label: "Rename project",
      onPress: onRequestRename,
    },
    {
      id: "star",
      icon: Star,
      label: isStarred ? "Unstar project" : "Star project",
      onPress: () => {
        onToggleStar?.();
        onClose();
      },
    },
    {
      id: "move",
      icon: FolderInput,
      label: "Move to folder",
      onPress: onRequestMove,
    },
    {
      id: "details",
      icon: Info,
      label: "Details",
      onPress: onRequestDetails,
    },
    {
      id: "export",
      icon: Upload,
      label: isExporting ? "Exporting..." : "Export project",
      onPress: onRequestExport,
    },
  ];

  const isSheet = variant === "sheet";
  const visibleMenuItems = isSheet
    ? menuItems.filter(
        (item) =>
          item.id !== "rename" && item.id !== "star" && item.id !== "export",
      )
    : menuItems;

  return (
    <>
      <View>
        {isSheet ? (
          <>
            <Text
              className="px-5 pt-1 pb-3 text-xl font-semibold text-foreground"
              numberOfLines={2}
            >
              {projectName}
            </Text>
            <View className="flex-row items-center gap-4 px-5 pb-4">
              <NativeSheetCircleAction
                icon={Pencil}
                label="Rename"
                onPress={onRequestRename}
              />
              <NativeSheetCircleAction
                icon={Star}
                label={isStarred ? "Unstar" : "Star"}
                onPress={() => {
                  onToggleStar?.();
                }}
                active={isStarred}
              />
              <NativeSheetCircleAction
                icon={Share2}
                label="Export"
                onPress={onRequestExport}
              />
            </View>
          </>
        ) : (
          <Pressable
            onPress={onGoToDashboard}
            className={cn(
              "flex-row items-center gap-2 px-4 active:bg-muted border-b border-border",
              isNative ? "min-h-12 py-3" : "py-3",
            )}
          >
            <ChevronLeft
              size={isNative ? 20 : 16}
              className="text-muted-foreground"
            />
            <Text
              className={
                isNative
                  ? "text-base font-medium text-foreground"
                  : "text-sm font-medium text-foreground"
              }
            >
              Go to Dashboard
            </Text>
          </Pressable>
        )}

        {/* Workspace info + plan badge */}
        <Pressable
          onPress={onSwitchProject}
          className={cn("px-4 active:bg-muted", isNative ? "py-4" : "py-3")}
          testID="project-switcher-open"
        >
          <View className="flex-row items-center gap-2.5">
            <View
              className={cn(
                "rounded-lg bg-primary items-center justify-center",
                isNative ? "h-10 w-10" : "h-8 w-8",
              )}
            >
              <Text
                className={
                  isNative
                    ? "text-sm font-bold text-primary-foreground"
                    : "text-xs font-bold text-primary-foreground"
                }
              >
                {(workspaceName || "W")[0]?.toUpperCase()}
              </Text>
            </View>
            <View className="flex-1 min-w-0">
              <View className="flex-row items-center gap-2">
                <Text
                  className={
                    isNative
                      ? "text-base font-semibold text-foreground"
                      : "text-sm font-semibold text-foreground"
                  }
                  numberOfLines={1}
                >
                  {workspaceName || "Workspace"}
                </Text>
                {showBilling && (
                  <Badge variant="secondary" className="px-1.5 py-0">
                    <Text className="text-[10px] font-semibold text-secondary-foreground uppercase">
                      {planLabel}
                    </Text>
                  </Badge>
                )}
              </View>
            </View>
            {isSheet ? (
              <ChevronRight size={18} className="text-muted-foreground" />
            ) : null}
          </View>
        </Pressable>

        {showBilling && (
          <View className="px-4 pb-3">
            <View
              className={cn(
                "border border-border rounded-lg p-3 gap-2.5",
                isSheet ? "bg-muted" : "bg-card",
              )}
            >
              <Pressable
                onPress={() => {
                  onClose();
                  router.push("/(app)/billing" as any);
                }}
                className="flex-row items-center justify-between"
              >
                <Text className="text-sm font-medium text-foreground">
                  Usage
                </Text>
                <ChevronRight size={14} className="text-muted-foreground" />
              </Pressable>
              <CompactUsageWindows
                windows={usageWindows}
                overage={usageOverage}
              />
            </View>
          </View>
        )}

        {/* Divider */}
        <View className="h-px bg-border mx-3 my-1" />

        {/* Menu items */}
        {visibleMenuItems.map((item) => {
          const Icon = item.icon;
          return (
            <Pressable
              key={item.id}
              onPress={item.onPress}
              className={cn(
                "flex-row items-center gap-3 px-4 active:bg-muted",
                isNative ? "min-h-12 py-3" : "py-2.5",
              )}
            >
              <Icon
                size={isNative ? 20 : 16}
                className="text-muted-foreground"
              />
              <Text
                className={
                  isNative
                    ? "text-base text-foreground flex-1"
                    : "text-sm text-foreground flex-1"
                }
              >
                {item.label}
              </Text>
              {item.trailing}
            </Pressable>
          );
        })}

        {canvasThemeSupported !== false && (
          <>
            <View className="h-px bg-border mx-3 my-1" />
            <AppearanceMenu inline={isSheet} />
          </>
        )}
      </View>
    </>
  );
}
