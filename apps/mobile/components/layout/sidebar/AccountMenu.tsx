// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Account trigger + popover/screen body. Leaves live alongside this file
 * (UserMenuContent, WorkspaceMenuSection, native groups).
 */

import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Avatar } from "@shogo/shared-ui/primitives";
import { cn } from "@shogo/shared-ui/primitives";
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from "@/components/ui/popover";
import { densityFor } from "../../../lib/phone-density";
import { isNativePlatform } from "../../../lib/native-phone-layout";
import { NativeAccountItems } from "./NativeAccountItems";
import { NativeAccountPersonalGroups } from "./NativeAccountPersonalGroups";
import { NativeAccountSettingsSection } from "./NativeAccountSettingsSection";
import { AccountNavLinks } from "./AccountNavLinks";
import { UserMenuContent, type UserMenuProps } from "./UserMenuContent";
import { WorkspaceMenuSection } from "./WorkspaceMenuSection";
import type { AccountSettingsSheetTab } from "../../settings/account-settings-sheets";

export { AccountNavLinks } from "./AccountNavLinks";
export { UserMenuContent, type UserMenuProps } from "./UserMenuContent";
export {
  WorkspaceMenuSection,
  type WorkspaceMenuSectionProps,
} from "./WorkspaceMenuSection";

function noopNativeSettingsTab(_tab: AccountSettingsSheetTab) {}

/** Phone/narrow web Account screen. Wide web keeps the AccountMenu popover. */
export const ACCOUNT_SCREEN_HREF = "/(app)/account";

const ACCOUNT_POPOVER_WIDTH_CLASS = "w-[300px] max-w-[340px] p-0";
const ACCOUNT_POPOVER_MAX_HEIGHT_CLASS = "max-h-[520px]";

function getInitials(name: string | null | undefined): string {
  if (!name) return "?";
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export interface AccountMenuProps extends UserMenuProps {
  workspaces: any[];
  currentWorkspace: any;
  billingData: any;
  workspacePlan: { planId: string; status: string | null } | null;
  allPlans: Record<string, { planId: string; status: string | null }>;
  showBilling: boolean;
  onSwitchWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  localMode?: boolean;
  /** Native Account: open a settings tab in a sheet instead of pushing Settings. */
  onOpenNativeSettingsTab?: (tab: AccountSettingsSheetTab) => void;
}

export function AccountMenu({
  user,
  onSignOut,
  onNavigate,
  isSuperAdmin,
  isWide = true,
  collapsed,
  workspaces,
  currentWorkspace,
  billingData,
  workspacePlan,
  allPlans,
  showBilling,
  onSwitchWorkspace,
  onCreateWorkspace,
  localMode,
}: AccountMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const isNative = isNativePlatform();
  // Native and narrow web get a pushed page. Wide web keeps the popover.
  // Native never falls back to a sheet, even if `isWide` is omitted.
  const openAsFullScreen = isNative || !isWide;
  const density = densityFor(isNative);

  const triggerInner = (
    <>
      <View
        className={cn(
          "rounded bg-primary/20 items-center justify-center",
          isNative ? density.hitSize : "h-7 w-7",
        )}
      >
        <Text
          className={cn(
            "font-bold text-primary",
            isNative ? density.text.body : "text-[11px]",
          )}
        >
          {currentWorkspace?.name?.[0]?.toUpperCase() || "W"}
        </Text>
      </View>
      {!collapsed && (
        <View className="flex-1 min-w-0">
          <Text
            className={cn(
              "text-foreground",
              isNative ? `${density.text.body} font-medium` : "text-sm",
            )}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {currentWorkspace?.name || "Workspace"}
          </Text>
          <Text
            className={cn(
              "text-muted-foreground",
              isNative ? density.text.label : "text-xs",
            )}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {user?.name || "User"}
          </Text>
        </View>
      )}
      {!collapsed && !isNative && (
        <Avatar
          fallback={getInitials(user?.name)}
          src={user?.image}
          size="sm"
        />
      )}
    </>
  );

  if (openAsFullScreen) {
    return (
      <Pressable
        onPress={() => onNavigate(ACCOUNT_SCREEN_HREF)}
        role="button"
        accessibilityLabel={`${currentWorkspace?.name || "Workspace"}, ${user?.name || "User"} — open account`}
        accessibilityHint="Opens account, workspace, and billing"
        className={cn(
          "flex-row items-center active:opacity-80 flex-1 min-w-0",
          isNative ? `${density.rowMin} gap-3` : "gap-2",
          collapsed && "justify-center",
        )}
      >
        {triggerInner}
      </Pressable>
    );
  }

  return (
    <Popover
      placement="top"
      size="sm"
      className="flex-1 min-w-0 w-auto h-auto items-stretch"
      isOpen={isOpen}
      onOpen={() => setIsOpen(true)}
      onClose={close}
      trigger={(triggerProps) => (
        <Pressable
          {...triggerProps}
          role="button"
          accessibilityLabel={`${currentWorkspace?.name || "Workspace"}, ${user?.name || "User"} — open account menu`}
          accessibilityHint="Opens menu to switch workspace, navigate, and manage your account"
          accessibilityState={{ expanded: isOpen }}
          className={cn(
            "flex-row items-center gap-2 active:opacity-80 flex-1 min-w-0",
            collapsed && "justify-center",
          )}
        >
          {triggerInner}
        </Pressable>
      )}
    >
      <PopoverBackdrop />
      <PopoverContent className={ACCOUNT_POPOVER_WIDTH_CLASS}>
        <PopoverBody>
          <ScrollView
            className={ACCOUNT_POPOVER_MAX_HEIGHT_CLASS}
            showsVerticalScrollIndicator={false}
            bounces={false}
            overScrollMode="never"
          >
            <AccountMenuBody
              user={user}
              onSignOut={onSignOut}
              onNavigate={onNavigate}
              isSuperAdmin={isSuperAdmin}
              workspaces={workspaces}
              currentWorkspace={currentWorkspace}
              billingData={billingData}
              workspacePlan={workspacePlan}
              allPlans={allPlans}
              showBilling={showBilling}
              onSwitchWorkspace={onSwitchWorkspace}
              onCreateWorkspace={onCreateWorkspace}
              localMode={localMode}
              onClose={close}
              isNative={false}
            />
          </ScrollView>
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
}

export function AccountMenuBody({
  user,
  onSignOut,
  onNavigate,
  isSuperAdmin,
  workspaces,
  currentWorkspace,
  billingData,
  workspacePlan,
  allPlans,
  showBilling,
  onSwitchWorkspace,
  onCreateWorkspace,
  localMode,
  onClose,
  isNative = false,
  onOpenNativeSettingsTab,
}: AccountMenuProps & { onClose: () => void; isNative?: boolean }) {
  const openNativeTab = onOpenNativeSettingsTab ?? noopNativeSettingsTab;
  const openProfileSheet = useCallback(() => {
    onOpenNativeSettingsTab?.("account");
  }, [onOpenNativeSettingsTab]);
  const openAppearanceSheet = useCallback(() => {
    onOpenNativeSettingsTab?.("appearance");
  }, [onOpenNativeSettingsTab]);

  if (isNative) {
    return (
      <>
        <WorkspaceMenuSection
          workspaces={workspaces}
          currentWorkspace={currentWorkspace}
          billingData={billingData}
          workspacePlan={workspacePlan}
          allPlans={allPlans}
          showBilling={showBilling}
          onNavigate={onNavigate}
          onSwitchWorkspace={onSwitchWorkspace}
          onCreateWorkspace={onCreateWorkspace}
          localMode={localMode}
          onClose={onClose}
          isNative
          settingsItems={
            <NativeAccountSettingsSection
              hasWorkspace={!!currentWorkspace}
              localMode={localMode}
              showBilling={showBilling}
              onOpenTab={openNativeTab}
            />
          }
          accountItems={
            <NativeAccountItems
              user={user}
              onNavigate={onNavigate}
              onClose={onClose}
              localMode={localMode}
              showBilling={showBilling}
              onOpenProfile={
                onOpenNativeSettingsTab ? openProfileSheet : undefined
              }
            />
          }
        />
        <NativeAccountPersonalGroups
          onSignOut={onSignOut}
          onNavigate={onNavigate}
          isSuperAdmin={isSuperAdmin}
          localMode={localMode}
          onClose={onClose}
          onOpenAppearance={
            onOpenNativeSettingsTab ? openAppearanceSheet : undefined
          }
        />
      </>
    );
  }

  return (
    <>
      <WorkspaceMenuSection
        workspaces={workspaces}
        currentWorkspace={currentWorkspace}
        billingData={billingData}
        workspacePlan={workspacePlan}
        allPlans={allPlans}
        showBilling={showBilling}
        onNavigate={onNavigate}
        onSwitchWorkspace={onSwitchWorkspace}
        onCreateWorkspace={onCreateWorkspace}
        localMode={localMode}
        onClose={onClose}
        isNative={false}
      />
      <View className="h-px bg-border" />
      <AccountNavLinks
        localMode={localMode}
        onNavigate={onNavigate}
        onClose={onClose}
      />
      <View className="h-px bg-border" />
      <UserMenuContent
        user={user}
        onSignOut={onSignOut}
        onNavigate={onNavigate}
        isSuperAdmin={isSuperAdmin}
        onClose={onClose}
      />
    </>
  );
}
