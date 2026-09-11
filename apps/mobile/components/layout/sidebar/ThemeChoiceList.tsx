// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Theme radios shared by the web Account popover and native Account groups.
 * Variants keep the shipped spacing; do not mix them.
 */

import { Pressable, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { COMPACT_DENSITY, PHONE_DENSITY } from "../../../lib/phone-density";
import { THEME_CHOICES } from "./account-theme";

export function ThemeChoiceList({
  theme,
  onSelect,
  variant,
}: {
  theme: string;
  onSelect: (value: (typeof THEME_CHOICES)[number]["value"]) => void;
  /** Popover = web AccountMenu. Grouped = native Account cards. */
  variant: "popover" | "grouped";
}) {
  const density = variant === "grouped" ? PHONE_DENSITY : COMPACT_DENSITY;
  const rows = THEME_CHOICES.map(({ value, label, Icon }, index) => (
    <Pressable
      key={value}
      onPress={() => onSelect(value)}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: theme === value }}
      className={
        variant === "grouped"
          ? cn(
              "flex-row items-center gap-3 px-4 py-3.5 active:bg-muted/60",
              density.rowMin,
              index < THEME_CHOICES.length - 1 && "border-b border-border",
            )
          : "flex-row items-center rounded-md px-2 active:bg-muted gap-3 py-2.5"
      }
    >
      <Icon
        size={density.icon.md}
        className={theme === value ? "text-primary" : "text-muted-foreground"}
      />
      <Text
        className={cn(
          "flex-1",
          density.text.body,
          theme === value ? "text-primary font-medium" : "text-foreground",
        )}
      >
        {label}
      </Text>
      {theme === value && (
        <Check size={density.icon.md} className="text-primary" />
      )}
    </Pressable>
  ));

  if (variant === "popover") {
    return (
      <View accessibilityLabel="Theme options" className="pr-4 py-1 pl-11">
        {rows}
      </View>
    );
  }

  return <>{rows}</>;
}
