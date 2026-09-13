// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * User section of the wide-web Account popover. Native Account uses
 * NativeAccountPersonalGroups instead — do not add isNative chrome here.
 */

import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  ChevronDown,
  ChevronRight,
  LogOut,
  Monitor,
  Shield,
  Store,
  User,
} from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { useTheme } from "../../../contexts/theme";
import { usePlatformConfig } from "../../../lib/platform-config";
import { COMPACT_DENSITY } from "../../../lib/phone-density";
import { ThemeChoiceList } from "./ThemeChoiceList";

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
  onSignOut,
  onNavigate,
  isSuperAdmin,
  onClose,
}: UserMenuProps & { onClose: () => void }) {
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const { localMode, shogoKeyConnected } = usePlatformConfig();
  const density = COMPACT_DENSITY;
  // The Creator hub (marketplace publishing + referrals) is cloud-backed, so
  // it only appears in local/desktop mode once signed in to Shogo Cloud.
  const showCreator = !localMode || !!shogoKeyConnected;
  const rowClass = `flex-row items-center gap-3 ${density.rowPad} active:bg-muted`;
  const rowText = `${density.text.body} text-foreground`;
  const rowIcon = density.icon.lg;

  return (
    <>
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

        {appearanceOpen ? (
          <ThemeChoiceList
            theme={theme}
            onSelect={setTheme}
            variant="popover"
          />
        ) : null}

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
