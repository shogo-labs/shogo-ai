// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace identity, usage, and switcher. Native Account and the web
 * popover share this tree; `isNative` only switches density and grouping.
 */

import { useCallback, type ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { Check, Plus, Settings, Users, Zap } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { usePostHogSafe } from "../../../contexts/posthog";
import { getPlanDisplayName } from "../../../lib/billing-config";
import { EVENTS, trackEvent } from "../../../lib/analytics";
import { CompactUsageWindows } from "../../billing/UsageWindows";
import { densityFor } from "../../../lib/phone-density";
import { AccountSettingsGroup } from "./AccountSettingsGroup";

export interface WorkspaceMenuSectionProps {
  workspaces: any[];
  currentWorkspace: any;
  billingData: any;
  workspacePlan: { planId: string; status: string | null } | null;
  allPlans: Record<string, { planId: string; status: string | null }>;
  showBilling: boolean;
  onNavigate: (href: string) => void;
  onSwitchWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
  localMode?: boolean;
  onClose: () => void;
  includePlan?: boolean;
  /** Native Account group rows (Profile, API Keys) rendered with Usage. */
  accountItems?: ReactNode;
  /** Native Settings rows (Workspace, People, …) between identity and Account. */
  settingsItems?: ReactNode;
  isNative?: boolean;
}

function workspaceListPlanBadge(
  wsId: string,
  allPlans: Record<string, { planId: string; status: string | null }>,
  currentWorkspaceId: string | undefined,
  subscriptionPlanId: string | undefined,
): { isPaid: boolean; label: string } {
  const wsPlanId =
    (allPlans[wsId]?.planId ??
      (wsId === currentWorkspaceId && subscriptionPlanId)) ||
    "free";
  const isPaid = wsPlanId !== "free";
  return {
    isPaid,
    label: isPaid
      ? wsPlanId.charAt(0).toUpperCase() + wsPlanId.slice(1)
      : "Free",
  };
}

export function WorkspaceMenuSection({
  workspaces,
  currentWorkspace,
  billingData,
  workspacePlan,
  allPlans,
  showBilling,
  onNavigate,
  onSwitchWorkspace,
  onCreateWorkspace,
  localMode,
  onClose,
  isNative = false,
  includePlan = true,
  accountItems,
  settingsItems,
}: WorkspaceMenuSectionProps) {
  const posthog = usePostHogSafe();
  const density = densityFor(isNative);

  const wsInitial = currentWorkspace?.name?.[0]?.toUpperCase() ?? "W";
  const resolvedPlanId =
    (billingData.hasActiveSubscription && billingData.subscription?.planId) ||
    workspacePlan?.planId ||
    "free";
  const planType = getPlanDisplayName(
    resolvedPlanId !== "free" ? resolvedPlanId : undefined,
  );

  const openWorkspaceSettings = useCallback(() => {
    onNavigate("/(app)/settings");
    onClose();
  }, [onNavigate, onClose]);
  const openInvite = useCallback(() => {
    onNavigate("/(app)/settings?tab=people");
    onClose();
  }, [onNavigate, onClose]);

  const identityHeader = currentWorkspace ? (
    <View className={cn("px-4", isNative ? "py-4" : "py-3")}>
      <View className="flex-row items-start gap-3">
        <View
          className={cn(
            "rounded-lg bg-primary/10 items-center justify-center",
            isNative ? density.hitSize : "h-10 w-10",
          )}
        >
          <Text
            className={cn(
              "font-medium text-primary",
              isNative ? density.text.body : "text-sm",
            )}
          >
            {wsInitial}
          </Text>
        </View>
        <View className="flex-1 min-w-0">
          <Text
            className={cn(
              "font-medium text-foreground",
              density.text.title,
            )}
            numberOfLines={1}
          >
            {currentWorkspace.name}
          </Text>
          {showBilling && (
            <Text
              className={cn(
                "text-muted-foreground",
                density.text.label,
                "mt-0.5",
              )}
            >
              {planType} Plan {"\u00B7"} 1 member
            </Text>
          )}
        </View>
      </View>
    </View>
  ) : null;

  const identityPills = currentWorkspace ? (
    <View className="flex-row gap-2 px-3 pb-2">
      <Pressable
        onPress={openWorkspaceSettings}
        className="h-8 flex-1 flex-row items-center justify-center gap-1.5 rounded-md border border-border active:bg-muted"
      >
        <Settings size={14} className="text-muted-foreground" />
        <Text className="text-xs text-foreground">Settings</Text>
      </Pressable>
      {!localMode && (
        <Pressable
          onPress={openInvite}
          className="h-8 flex-1 flex-row items-center justify-center gap-1.5 rounded-md border border-border active:bg-muted"
        >
          <Users size={14} className="text-muted-foreground" />
          <Text className="text-xs text-foreground">Invite</Text>
        </Pressable>
      )}
    </View>
  ) : null;

  const plan = includePlan && showBilling && currentWorkspace ? (
    <>
      {!isNative && <View className="h-px bg-border" />}
      <View className={cn("px-4 gap-2", isNative ? "py-3.5" : "py-3")}>
        <Text className={cn("text-muted-foreground", density.text.body)}>
          Usage
        </Text>
        <CompactUsageWindows
          windows={billingData.usageWindows}
          overage={
            billingData.effectiveBalance
              ? {
                  enabled: billingData.effectiveBalance.overageEnabled,
                  active: billingData.effectiveBalance.overageActive,
                  accumulatedUsd:
                    billingData.effectiveBalance.overageAccumulatedUsd,
                }
              : undefined
          }
          comfortable={isNative}
        />
      </View>
      {planType === "Free" && (
        <View className="px-3 py-2">
          <Pressable
            onPress={() => {
              trackEvent(posthog, EVENTS.UPGRADE_CLICKED);
              onNavigate("/(app)/billing");
              onClose();
            }}
            className={cn(
              "flex-row items-center justify-center gap-2 rounded-md",
              isNative ? "h-11" : "h-9",
            )}
            style={
              Platform.OS === "web"
                ? ({
                    backgroundImage:
                      "linear-gradient(to right, #3b82f6, #9333ea)",
                  } as any)
                : { backgroundColor: "#7c3aed" }
            }
          >
            <Zap
              size={isNative ? density.icon.md : 16}
              className="text-white"
            />
            <Text className={cn("font-medium text-white", density.text.body)}>
              Upgrade to Pro
            </Text>
          </Pressable>
        </View>
      )}
    </>
  ) : null;

  const workspaceRows = (
    <>
      {workspaces.map((ws: any, index: number) => {
        const isCurrent = ws.id === currentWorkspace?.id;
        const isLast = index === workspaces.length - 1 && localMode;
        const badge = showBilling
          ? workspaceListPlanBadge(
              ws.id,
              allPlans,
              currentWorkspace?.id,
              billingData.subscription?.planId,
            )
          : null;
        return (
          <Pressable
            key={ws.id}
            onPress={() => {
              if (!isCurrent) {
                onSwitchWorkspace(ws.id);
              }
              onClose();
            }}
            className={cn(
              "flex-row items-center gap-2 px-4 active:bg-muted",
              isNative ? "py-3.5" : "py-2",
              isNative && !isLast && "border-b border-border",
            )}
          >
            <View
              className={cn(
                "rounded bg-primary/10 items-center justify-center",
                isNative ? "h-7 w-7" : "h-6 w-6",
              )}
            >
              <Text
                className={cn("font-medium text-primary", density.text.caption)}
              >
                {ws.name?.[0]?.toUpperCase() ?? "W"}
              </Text>
            </View>
            <Text
              className={cn("text-foreground flex-1", density.text.body)}
              numberOfLines={1}
            >
              {ws.name}
            </Text>
            {badge ? (
              <View
                className={cn(
                  "rounded px-1.5 py-0.5",
                  badge.isPaid ? "bg-primary/10" : "bg-muted",
                )}
              >
                <Text
                  className={cn(
                    density.text.caption,
                    badge.isPaid
                      ? "text-primary font-medium"
                      : "text-muted-foreground",
                  )}
                >
                  {badge.label}
                </Text>
              </View>
            ) : null}
            {isCurrent && <Check size={16} className="text-primary" />}
          </Pressable>
        );
      })}
      {!localMode && (
        <Pressable
          onPress={() => {
            onClose();
            onCreateWorkspace();
          }}
          className={cn(
            "flex-row items-center gap-2 px-4 active:bg-muted",
            isNative ? "py-3.5" : "py-2",
            !isNative && "rounded-md",
          )}
        >
          <Plus size={isNative ? 18 : 16} className="text-muted-foreground" />
          <Text className={cn("text-foreground", density.text.body)}>
            Create new workspace
          </Text>
        </Pressable>
      )}
    </>
  );

  if (isNative) {
    return (
      <>
        {identityHeader ? (
          <AccountSettingsGroup className="mt-2">{identityHeader}</AccountSettingsGroup>
        ) : null}
        {settingsItems}
        {plan || accountItems ? (
          <AccountSettingsGroup title="Account">
            {accountItems}
            {plan}
          </AccountSettingsGroup>
        ) : null}
        <AccountSettingsGroup title="Workspaces">
          {workspaceRows}
        </AccountSettingsGroup>
      </>
    );
  }

  return (
    <>
      {identityHeader}
      {identityPills}
      {plan}
      <View className="h-px bg-border" />
      <View className="py-1">
        <Text
          className={cn(
            "px-4 py-1.5 font-semibold uppercase tracking-wider text-muted-foreground",
            density.text.label,
          )}
        >
          All workspaces
        </Text>
        {workspaceRows}
      </View>
    </>
  );
}
