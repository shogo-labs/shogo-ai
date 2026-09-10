// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ChatGPT-style grouped settings cards for the native Account screen.
 * Wide web AccountMenu popover does not use these.
 */

import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { PHONE_DENSITY } from "../../../lib/phone-density";

export function AccountSettingsGroup({
  title,
  children,
  className,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <View className={cn("mt-5 px-4", className)}>
      {title ? (
        <Text
          accessibilityRole="header"
          className={cn(
            "mb-2.5 px-1 font-semibold text-muted-foreground",
            PHONE_DENSITY.text.title,
          )}
        >
          {title}
        </Text>
      ) : null}
      <View className="overflow-hidden rounded-2xl bg-card">{children}</View>
    </View>
  );
}

export function AccountSettingsRow({
  icon,
  label,
  onPress,
  trailing,
  accessibilityLabel,
  accessibilityState,
  separator = true,
  showChevron = true,
}: {
  icon?: ReactNode;
  label: string;
  onPress?: () => void;
  trailing?: ReactNode;
  accessibilityLabel?: string;
  accessibilityState?: { expanded?: boolean; checked?: boolean };
  separator?: boolean;
  showChevron?: boolean;
}) {
  const content = (
    <>
      {icon}
      <Text className={cn("flex-1 text-foreground", PHONE_DENSITY.text.body)}>
        {label}
      </Text>
      {trailing}
      {onPress && showChevron ? (
        <ChevronRight
          size={PHONE_DENSITY.icon.md}
          className="text-muted-foreground"
        />
      ) : null}
    </>
  );
  const rowClass = cn(
    "flex-row items-center gap-3 px-4",
    PHONE_DENSITY.rowMin,
    "py-3.5",
    separator && "border-b border-border",
    onPress && "active:bg-muted/60",
  );
  if (!onPress) {
    return (
      <View
        accessibilityLabel={accessibilityLabel ?? label}
        className={rowClass}
      >
        {content}
      </View>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      role="menuitem"
      accessibilityRole="menuitem"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={accessibilityState}
      className={rowClass}
    >
      {content}
    </Pressable>
  );
}
