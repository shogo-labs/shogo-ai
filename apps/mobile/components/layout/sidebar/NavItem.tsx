// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, type ElementType } from "react";
import { Linking, Platform, Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { cn } from "@shogo/shared-ui/primitives";
import { densityFor } from "../../../lib/phone-density";
import { useNativePhoneIconChrome } from "../../../lib/native-phone-layout";

// ─── NavItem ───────────────────────────────────────────────

interface NavItemProps {
  icon: ElementType;
  label: string;
  href?: string;
  externalHref?: string;
  active?: boolean;
  collapsed?: boolean;
  onPress?: () => void;
  shortcut?: string;
  onNavPress?: () => void;
}

export function NavItem({
  icon: Icon,
  label,
  href,
  externalHref,
  active,
  collapsed,
  onPress,
  shortcut,
  onNavPress,
}: NavItemProps) {
  const router = useRouter();
  const isNative = Platform.OS !== "web";
  const density = densityFor(isNative);
  const iconChrome = useNativePhoneIconChrome();

  const handlePress = useCallback(() => {
    if (onPress) {
      onPress();
      return;
    }
    if (externalHref) {
      Linking.openURL(externalHref);
      return;
    }
    if (href) {
      router.push(href as any);
      onNavPress?.();
    }
  }, [href, externalHref, onPress, router, onNavPress]);

  return (
    <Pressable
      onPress={handlePress}
      role={href || externalHref ? "link" : "button"}
      accessibilityLabel={label}
      className={cn(
        "flex-row items-center rounded-md",
        isNative ? `${density.rowMin} gap-3 px-3 py-2` : "gap-2 px-2 py-1",
        active ? "bg-accent" : "active:bg-accent/50",
        collapsed && "justify-center px-2",
      )}
    >
      <Icon
        size={isNative ? density.icon.nav : 12}
        color={isNative ? iconChrome.color : undefined}
        strokeWidth={isNative ? iconChrome.strokeWidth : undefined}
        className={cn(
          !isNative && (active ? "text-foreground" : "text-muted-foreground"),
        )}
      />
      {!collapsed && (
        <Text
          className={cn(
            isNative ? `${density.text.body} flex-1` : "text-xs flex-1",
            active ? "text-foreground" : "text-muted-foreground",
          )}
          numberOfLines={1}
        >
          {label}
        </Text>
      )}
      {!collapsed && shortcut && Platform.OS === "web" && (
        <View className="ml-auto rounded border border-border bg-muted py-0.5">
          <Text className="text-[10px] font-mono text-muted-foreground">
            {shortcut}
          </Text>
        </View>
      )}
    </Pressable>
  );
}
