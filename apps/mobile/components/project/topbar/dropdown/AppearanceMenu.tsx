// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import React, { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { Check, ChevronRight, SunMoon } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { useTheme } from "../../../../contexts/theme";
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from "../../../ui/popover";
import { THEME_CHOICES } from "../../../../lib/theme-choices";

export function AppearanceMenu({ inline = false }: { inline?: boolean }) {
  const { theme, setTheme } = useTheme();
  const [popoverOpen, setPopoverOpen] = useState(false);

  if (inline) {
    return (
      <View>
        <View className="flex-row items-center gap-3 px-4 py-3">
          <SunMoon size={20} className="text-muted-foreground" />
          <Text className="text-base text-foreground flex-1">Appearance</Text>
        </View>
        {THEME_CHOICES.map(({ value, label }) => (
          <Pressable
            key={value}
            onPress={() => setTheme(value)}
            className="flex-row items-center min-h-12 gap-2 px-4 py-2.5 pl-14 active:bg-muted"
          >
            <Text
              className={cn(
                "text-base flex-1",
                theme === value
                  ? "text-foreground font-medium"
                  : "text-muted-foreground",
              )}
            >
              {label}
            </Text>
            {theme === value ? (
              <Check size={18} className="text-primary flex-shrink-0" />
            ) : null}
          </Pressable>
        ))}
      </View>
    );
  }

  return (
    <Popover
      placement={Platform.OS === "web" ? "right" : "top"}
      isOpen={popoverOpen}
      onOpen={() => setPopoverOpen(true)}
      onClose={() => setPopoverOpen(false)}
      trigger={(triggerProps) => (
        <Pressable
          {...triggerProps}
          className={cn(
            "flex-row items-center gap-3 px-4 active:bg-muted",
            Platform.OS === "web" ? "py-2.5" : "min-h-12 py-3",
          )}
        >
          <SunMoon
            size={Platform.OS === "web" ? 16 : 20}
            className="text-muted-foreground"
          />
          <Text
            className={
              Platform.OS === "web"
                ? "text-sm text-foreground flex-1"
                : "text-base text-foreground flex-1"
            }
          >
            Appearance
          </Text>
          <ChevronRight
            size={Platform.OS === "web" ? 14 : 18}
            className="text-muted-foreground"
          />
        </Pressable>
      )}
    >
      <PopoverBackdrop />
      <PopoverContent
        className={cn(
          "p-0",
          Platform.OS === "web"
            ? "min-w-[160px]"
            : "min-w-0 w-[180px] max-w-[220px] shrink-0",
        )}
      >
        <PopoverBody>
          {THEME_OPTIONS.map(({ value, label }) => (
            <Pressable
              key={value}
              onPress={() => {
                setTheme(value);
                setPopoverOpen(false);
              }}
              className={cn(
                "flex-row items-center active:bg-muted",
                Platform.OS === "web"
                  ? "gap-3 px-4 py-3"
                  : "min-h-12 gap-2 px-4 py-3",
              )}
            >
              <Text
                className={cn(
                  Platform.OS === "web" ? "text-sm flex-1" : "text-base flex-1",
                  theme === value
                    ? "text-foreground font-medium"
                    : "text-foreground",
                )}
                numberOfLines={1}
              >
                {label}
              </Text>
              {theme === value && (
                <Check
                  size={Platform.OS === "web" ? 16 : 18}
                  className="text-foreground flex-shrink-0"
                />
              )}
            </Pressable>
          ))}
        </PopoverBody>
      </PopoverContent>
    </Popover>
  );
}
