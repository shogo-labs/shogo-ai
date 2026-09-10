// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useState, type ElementType, type ReactNode } from "react";
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
  Mail,
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
import { densityFor, PHONE_DENSITY } from "../../../lib/phone-density";
import { isNativePlatform } from "../../../lib/native-phone-layout";
import {
  AccountSettingsGroup,
  AccountSettingsRow,
} from "./AccountSettingsGroup";
import { NativeAccountSettingsSection } from "./NativeAccountSettingsSection";
import type { AccountSettingsSheetTab } from "../../settings/account-settings-sheets";

const DOCS_URL = "https://docs.shogo.ai/";
const CHANGELOG_URL = "https://docs.shogo.ai/changelog";

const THEME_CHOICES = [
  { value: "light" as const, label: "Light", Icon: Sun },
  { value: "dark" as const, label: "Dark", Icon: Moon },
  { value: "system" as const, label: "System", Icon: Monitor },
];

function themeDisplayName(theme: string): string {
  return THEME_CHOICES.find((choice) => choice.value === theme)?.label ?? "System";
}

function noopNativeSettingsTab(_tab: AccountSettingsSheetTab) {}

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
            {THEME_CHOICES.map(({ value, label, Icon }) => (
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
  includePlan?: boolean;
  /** Native Account group rows (Profile, API Keys) rendered with Usage. */
  accountItems?: ReactNode;
  /** Native Settings rows (Workspace, People, …) between identity and Account. */
  settingsItems?: ReactNode;
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
  const density = densityFor(isNative);
  const rowClass = `flex-row items-center gap-3 ${density.rowPad} active:bg-muted`;
  const rowText = `${density.text.body} text-foreground`;
  const rowIcon = isNative ? density.icon.lg : 18;
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
          className={rowClass}
        >
          <Icon size={rowIcon} className="text-muted-foreground" />
          <Text className={rowText}>
            {label}
          </Text>
        </Pressable>
      ))}
      <Pressable
        onPress={() => {
          Linking.openURL(DOCS_URL);
          onClose();
        }}
        role="menuitem"
        accessibilityLabel="Docs"
        className={rowClass}
      >
        <ExternalLink
          size={rowIcon}
          className="text-muted-foreground"
        />
        <Text className={rowText}>
          Docs
        </Text>
      </Pressable>
      <Pressable
        onPress={() => {
          Linking.openURL(CHANGELOG_URL);
          onClose();
        }}
        role="menuitem"
        accessibilityLabel="What's New"
        className={rowClass}
      >
        <Sparkles size={rowIcon} className="text-muted-foreground" />
        <Text className={rowText}>
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

function NativeAccountPersonalGroups({
  onSignOut,
  onNavigate,
  isSuperAdmin,
  localMode,
  onClose,
  onOpenAppearance,
}: {
  onSignOut: () => void;
  onNavigate: (href: string) => void;
  isSuperAdmin?: boolean;
  localMode?: boolean;
  onClose: () => void;
  onOpenAppearance?: () => void;
}) {
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const { shogoKeyConnected } = usePlatformConfig();
  const showCreator = !localMode || !!shogoKeyConnected;
  const density = PHONE_DENSITY;
  const iconClass = "text-muted-foreground";
  const iconSize = density.icon.lg;
  const appearanceOpensSheet = !!onOpenAppearance;

  return (
    <>
      <AccountSettingsGroup title="Theme">
        <AccountSettingsRow
          icon={<Monitor size={iconSize} className={iconClass} />}
          label="Appearance"
          accessibilityState={appearanceOpensSheet ? undefined : { expanded: appearanceOpen }}
          trailing={
            <Text className={cn("text-muted-foreground", density.text.body)}>
              {themeDisplayName(theme)}
            </Text>
          }
          showChevron={appearanceOpensSheet || !appearanceOpen}
          separator={!appearanceOpensSheet && appearanceOpen}
          onPress={() => {
            if (onOpenAppearance) onOpenAppearance()
            else setAppearanceOpen((open) => !open)
          }}
        />
        {appearanceOpen
          ? THEME_CHOICES.map(({ value, label, Icon }, index) => (
              <Pressable
                key={value}
                onPress={() => setTheme(value)}
                accessibilityRole="radio"
                accessibilityLabel={label}
                accessibilityState={{ checked: theme === value }}
                className={cn(
                  "flex-row items-center gap-3 px-4 py-3.5 active:bg-muted/60",
                  density.rowMin,
                  index < THEME_CHOICES.length - 1 && "border-b border-border",
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
            ))
          : null}
      </AccountSettingsGroup>

      <AccountSettingsGroup title="Resources">
        <AccountSettingsRow
          icon={<ExternalLink size={iconSize} className={iconClass} />}
          label="Docs"
          onPress={() => {
            Linking.openURL(DOCS_URL);
            onClose();
          }}
        />
        <AccountSettingsRow
          icon={<Sparkles size={iconSize} className={iconClass} />}
          label="What's New"
          separator={false}
          onPress={() => {
            Linking.openURL(CHANGELOG_URL);
            onClose();
          }}
        />
      </AccountSettingsGroup>

      {(showCreator || isSuperAdmin) && (
        <AccountSettingsGroup title="More">
          {showCreator && (
            <AccountSettingsRow
              icon={<Store size={iconSize} className={iconClass} />}
              label="Creator"
              separator={!!isSuperAdmin}
              onPress={() => {
                onNavigate("/(app)/creator");
                onClose();
              }}
            />
          )}
          {isSuperAdmin && (
            <AccountSettingsRow
              icon={<Shield size={iconSize} className="text-primary" />}
              label="Admin"
              accessibilityLabel="Admin panel"
              separator={false}
              onPress={() => {
                onNavigate("/(admin)");
                onClose();
              }}
            />
          )}
        </AccountSettingsGroup>
      )}

      {!localMode && (
        <View className="mb-6">
          <AccountSettingsGroup>
            <AccountSettingsRow
              icon={<LogOut size={iconSize} className={iconClass} />}
              label="Sign Out"
              accessibilityLabel="Sign out"
              showChevron={false}
              separator={false}
              onPress={() => {
                onSignOut();
                onClose();
              }}
            />
          </AccountSettingsGroup>
        </View>
      )}
    </>
  );
}

function NativeAccountItems({
  user,
  onNavigate,
  onClose,
  localMode,
  showBilling,
  onOpenProfile,
}: {
  user: UserMenuProps["user"];
  onNavigate: (href: string) => void;
  onClose: () => void;
  localMode?: boolean;
  showBilling: boolean;
  onOpenProfile?: () => void;
}) {
  const density = PHONE_DENSITY;
  const iconSize = density.icon.lg;
  const showKeys = !localMode;
  const muted = "text-muted-foreground";
  return (
    <>
      {user?.email ? (
        <AccountSettingsRow
          icon={<Mail size={iconSize} className={muted} />}
          label="Email"
          trailing={
            <Text
              className={cn("max-w-[52%] text-right text-muted-foreground", density.text.body)}
              numberOfLines={1}
            >
              {user.email}
            </Text>
          }
          showChevron={false}
          separator
        />
      ) : null}
      <AccountSettingsRow
        icon={<User size={iconSize} className={muted} />}
        label="Profile"
        separator={showKeys || showBilling}
        onPress={() => {
          if (onOpenProfile) onOpenProfile()
          else {
            onNavigate("/(app)/profile");
            onClose();
          }
        }}
      />
      {showKeys ? (
        <AccountSettingsRow
          icon={<Key size={iconSize} className={muted} />}
          label="API Keys"
          separator={showBilling}
          onPress={() => {
            onNavigate("/(app)/api-keys");
            onClose();
          }}
        />
      ) : null}
    </>
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
        isNative={false}
      />
      <View className="h-px bg-border" />
      <UserMenuContent
        user={user}
        onSignOut={onSignOut}
        onNavigate={onNavigate}
        isSuperAdmin={isSuperAdmin}
        onClose={onClose}
        isNative={false}
      />
    </>
  );
}
