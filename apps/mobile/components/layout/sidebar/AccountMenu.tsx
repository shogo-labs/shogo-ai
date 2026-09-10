// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useState, type ElementType } from "react";
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Key,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Settings,
  Shield,
  Sparkles,
  Store,
  Sun,
  User,
  Users,
  Zap,
} from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { Avatar } from "@shogo/shared-ui/primitives";
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from "@/components/ui/popover";
import { usePostHogSafe } from "../../../contexts/posthog";
import { useTheme } from "../../../contexts/theme";
import { usePlatformConfig } from "../../../lib/platform-config";
import { getPlanDisplayName } from "../../../lib/billing-config";
import { EVENTS, trackEvent } from "../../../lib/analytics";
import { CompactUsageWindows } from "../../billing/UsageWindows";
import { densityFor } from "../../../lib/phone-density";
import { isNativePlatform } from "../../../lib/native-phone-layout";

/** Phone/narrow web Account screen. Wide web keeps the AccountMenu popover. */
export const ACCOUNT_SCREEN_HREF = "/(app)/account";

function getInitials(name: string | null | undefined): string {
  if (!name) return "?";
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

// ─── UserMenuContent (user section of the account menu) ────

export interface UserMenuProps {
  user: {
    name?: string | null;
    email?: string | null;
    image?: string | null;
  } | null;
  onSignOut: () => void;
  onNavigate: (href: string) => void;
  isSuperAdmin?: boolean;
  isWide?: boolean;
  bottomInset?: number;
  collapsed?: boolean;
}

export function UserMenuContent({
  user,
  onSignOut,
  onNavigate,
  isSuperAdmin,
  onClose,
  isNative = false,
}: UserMenuProps & { onClose: () => void; isNative?: boolean }) {
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const { localMode, shogoKeyConnected } = usePlatformConfig();
  const density = densityFor(isNative);
  // The Creator hub (marketplace publishing + referrals) is cloud-backed, so
  // it only appears in local/desktop mode once signed in to Shogo Cloud.
  const showCreator = !localMode || !!shogoKeyConnected;
  const rowClass = `flex-row items-center gap-3 ${density.rowPad} active:bg-muted`;
  const rowText = `${density.text.body} text-foreground`;
  const rowIcon = density.icon.lg;

  return (
    <>
      {/* Menu items */}
      <View role="menu" className="py-1">
        <Pressable
          onPress={() => {
            onNavigate("/(app)/profile");
            onClose();
          }}
          role="menuitem"
          accessibilityLabel="Profile"
          className={rowClass}
        >
          <User size={rowIcon} className="text-muted-foreground" />
          <Text className={rowText}>Profile</Text>
        </Pressable>

        <Pressable
          onPress={() => setAppearanceOpen((open) => !open)}
          role="menuitem"
          accessibilityLabel="Appearance"
          accessibilityState={{ expanded: appearanceOpen }}
          className={rowClass}
        >
          <Monitor size={rowIcon} className="text-muted-foreground" />
          <Text className={cn(rowText, "flex-1")}>Appearance</Text>
          {appearanceOpen ? (
            <ChevronDown
              size={density.icon.md}
              className="text-muted-foreground"
            />
          ) : (
            <ChevronRight
              size={density.icon.md}
              className="text-muted-foreground"
            />
          )}
        </Pressable>

        {appearanceOpen && (
          <View
            accessibilityLabel="Theme options"
            className={cn("pr-4 py-1", isNative ? "pl-12" : "pl-11")}
          >
            {(
              [
                { value: "light" as const, label: "Light", Icon: Sun },
                { value: "dark" as const, label: "Dark", Icon: Moon },
                { value: "system" as const, label: "System", Icon: Monitor },
              ] as const
            ).map(({ value, label, Icon }) => (
              <Pressable
                key={value}
                onPress={() => setTheme(value)}
                accessibilityRole="radio"
                accessibilityLabel={label}
                accessibilityState={{ checked: theme === value }}
                className={cn(
                  "flex-row items-center rounded-md px-2 active:bg-muted",
                  isNative ? "min-h-12 gap-3 py-3" : "gap-3 py-2.5",
                )}
              >
                <Icon
                  size={density.icon.md}
                  className={
                    theme === value ? "text-primary" : "text-muted-foreground"
                  }
                />
                <Text
                  className={cn(
                    "flex-1",
                    density.text.body,
                    theme === value
                      ? "text-primary font-medium"
                      : "text-foreground",
                  )}
                >
                  {label}
                </Text>
                {theme === value && (
                  <Check size={density.icon.md} className="text-primary" />
                )}
              </Pressable>
            ))}
          </View>
        )}

        {showCreator && (
          <Pressable
            onPress={() => {
              onNavigate("/(app)/creator");
              onClose();
            }}
            role="menuitem"
            accessibilityLabel="Creator"
            className={rowClass}
          >
            <Store size={rowIcon} className="text-muted-foreground" />
            <Text className={rowText}>Creator</Text>
          </Pressable>
        )}

        {isSuperAdmin && (
          <Pressable
            onPress={() => {
              onNavigate("/(admin)");
              onClose();
            }}
            role="menuitem"
            accessibilityLabel="Admin panel"
            className={rowClass}
          >
            <Shield size={rowIcon} className="text-primary" />
            <Text className={rowText}>Admin</Text>
          </Pressable>
        )}
      </View>

      {!localMode && (
        <>
          <View className="h-px bg-border" />

          <View role="menu" className="py-1">
            <Pressable
              onPress={() => {
                onSignOut();
                onClose();
              }}
              role="menuitem"
              accessibilityLabel="Sign out"
              className={rowClass}
            >
              <LogOut size={rowIcon} className="text-muted-foreground" />
              <Text className={rowText}>Sign Out</Text>
            </Pressable>
          </View>
        </>
      )}
    </>
  );
}

// ─── WorkspaceMenuSection (workspace block inside the account menu) ─

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
  isNative?: boolean;
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

  return (
    <>
      {currentWorkspace && (
        <View className={cn("px-4", isNative ? "py-4" : "py-3")}>
          <View className="flex-row items-start gap-3">
            <View
              className={cn(
                "rounded-lg bg-primary/10 items-center justify-center",
                isNative ? "h-11 w-11" : "h-10 w-10",
              )}
            >
              <Text
                className={cn(
                  "font-medium text-primary",
                  isNative ? "text-base" : "text-sm",
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
      )}

      {currentWorkspace && (
        <View className="px-3 pb-2 flex-row gap-2">
          <Pressable
            onPress={() => {
              onNavigate("/(app)/settings");
              onClose();
            }}
            className={cn(
              "flex-1 flex-row items-center justify-center gap-1.5 rounded-md border border-border active:bg-muted",
              isNative ? "h-10" : "h-8",
            )}
          >
            <Settings
              size={isNative ? 16 : 14}
              className="text-muted-foreground"
            />
            <Text
              className={cn(
                "text-foreground",
                isNative ? "text-sm" : "text-xs",
              )}
            >
              Settings
            </Text>
          </Pressable>
          {!localMode && (
            <Pressable
              onPress={() => {
                onNavigate("/(app)/settings?tab=people");
                onClose();
              }}
              className={cn(
                "flex-1 flex-row items-center justify-center gap-1.5 rounded-md border border-border active:bg-muted",
                isNative ? "h-10" : "h-8",
              )}
            >
              <Users
                size={isNative ? 16 : 14}
                className="text-muted-foreground"
              />
              <Text
                className={cn(
                  "text-foreground",
                  isNative ? "text-sm" : "text-xs",
                )}
              >
                Invite
              </Text>
            </Pressable>
          )}
        </View>
      )}

      {showBilling && currentWorkspace && (
        <>
          <View className="h-px bg-border" />
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
        </>
      )}

      {showBilling && currentWorkspace && planType === "Free" && (
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
        {workspaces.map((ws: any) => {
          const isCurrent = ws.id === currentWorkspace?.id;
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
                isNative ? "py-2.5" : "py-2",
              )}
            >
              <View
                className={cn(
                  "rounded bg-primary/10 items-center justify-center",
                  isNative ? "h-7 w-7" : "h-6 w-6",
                )}
              >
                <Text
                  className={cn(
                    "font-medium text-primary",
                    density.text.caption,
                  )}
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
              {showBilling &&
                (() => {
                  const wsPlanId =
                    (allPlans[ws.id]?.planId ??
                      (ws.id === currentWorkspace?.id &&
                        billingData.subscription?.planId)) ||
                    "free";
                  const isPaid = wsPlanId !== "free";
                  const label = isPaid
                    ? wsPlanId.charAt(0).toUpperCase() + wsPlanId.slice(1)
                    : "Free";
                  return (
                    <View
                      className={cn(
                        "rounded px-1.5 py-0.5",
                        isPaid ? "bg-primary/10" : "bg-muted",
                      )}
                    >
                      <Text
                        className={cn(
                          density.text.caption,
                          isPaid
                            ? "text-primary font-medium"
                            : "text-muted-foreground",
                        )}
                      >
                        {label}
                      </Text>
                    </View>
                  );
                })()}
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
              "flex-row items-center gap-2 px-4 rounded-md active:bg-muted",
              isNative ? "py-2.5" : "py-2",
            )}
          >
            <Plus size={isNative ? 18 : 16} className="text-muted-foreground" />
            <Text className={cn("text-foreground", density.text.body)}>
              Create new workspace
            </Text>
          </Pressable>
        )}
      </View>
    </>
  );
}

// ─── AccountNavLinks (resources/links moved into the account menu) ─

export function AccountNavLinks({
  localMode,
  onNavigate,
  onClose,
  isNative = false,
}: {
  localMode?: boolean;
  onNavigate: (href: string) => void;
  onClose: () => void;
  isNative?: boolean;
}) {
  const items: Array<{ icon: ElementType; label: string; href: string }> = [
    // { icon: Star, label: 'Starred', href: '/(app)/starred' },
    // ...(!localMode ? [{ icon: Users, label: 'Shared with me', href: '/(app)/shared' }] : []),
    ...(!localMode
      ? [{ icon: Key, label: "API Keys", href: "/(app)/api-keys" }]
      : []),
  ];

  return (
    <View role="menu" className="py-1">
      {items.map(({ icon: Icon, label, href }) => (
        <Pressable
          key={label}
          onPress={() => {
            onNavigate(href);
            onClose();
          }}
          role="menuitem"
          accessibilityLabel={label}
          className={cn(
            "flex-row items-center gap-3 px-4 active:bg-muted",
            isNative ? "py-3.5" : "py-3",
          )}
        >
          <Icon size={isNative ? 20 : 18} className="text-muted-foreground" />
          <Text
            className={cn(
              "text-foreground",
              isNative ? "text-base" : "text-sm",
            )}
          >
            {label}
          </Text>
        </Pressable>
      ))}
      <Pressable
        onPress={() => {
          Linking.openURL("https://docs.shogo.ai/");
          onClose();
        }}
        role="menuitem"
        accessibilityLabel="Docs"
        className={cn(
          "flex-row items-center gap-3 px-4 active:bg-muted",
          isNative ? "py-3.5" : "py-3",
        )}
      >
        <ExternalLink
          size={isNative ? 20 : 18}
          className="text-muted-foreground"
        />
        <Text
          className={cn("text-foreground", isNative ? "text-base" : "text-sm")}
        >
          Docs
        </Text>
      </Pressable>
      <Pressable
        onPress={() => {
          Linking.openURL("https://docs.shogo.ai/changelog");
          onClose();
        }}
        role="menuitem"
        accessibilityLabel="What's New"
        className={cn(
          "flex-row items-center gap-3 px-4 active:bg-muted",
          isNative ? "py-3.5" : "py-3",
        )}
      >
        <Sparkles size={isNative ? 20 : 18} className="text-muted-foreground" />
        <Text
          className={cn("text-foreground", isNative ? "text-base" : "text-sm")}
        >
          What's New
        </Text>
      </Pressable>
    </View>
  );
}

// ─── AccountMenu (consolidated workspace + user button) ─────

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

  const triggerInner = (
    <>
      <View
        className={cn(
          "rounded bg-primary/20 items-center justify-center",
          isNative ? "h-10 w-10" : "h-7 w-7",
        )}
      >
        <Text
          className={cn(
            "font-bold text-primary",
            isNative ? "text-sm" : "text-[11px]",
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
              isNative ? "text-base font-medium" : "text-sm",
            )}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {currentWorkspace?.name || "Workspace"}
          </Text>
          <Text
            className={cn(
              "text-muted-foreground",
              isNative ? "text-sm" : "text-xs",
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
          isNative ? "min-h-12 gap-3" : "gap-2",
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
      <PopoverContent className="w-[300px] max-w-[340px] p-0">
        <PopoverBody>
          <ScrollView
            className="max-h-[520px]"
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
}: AccountMenuProps & { onClose: () => void; isNative?: boolean }) {
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
        isNative={isNative}
      />
      <View className="h-px bg-border" />
      <AccountNavLinks
        localMode={localMode}
        onNavigate={onNavigate}
        onClose={onClose}
        isNative={isNative}
      />
      <View className="h-px bg-border" />
      <UserMenuContent
        user={user}
        onSignOut={onSignOut}
        onNavigate={onNavigate}
        isSuperAdmin={isSuperAdmin}
        onClose={onClose}
        isNative={isNative}
      />
    </>
  );
}
