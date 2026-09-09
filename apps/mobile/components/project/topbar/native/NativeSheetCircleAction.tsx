// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import React from "react";
import { Pressable, Text, View } from "react-native";
import { useNativePhoneIconChrome } from "../../../../lib/native-phone-layout";

export function NativeSheetCircleAction({
  icon: Icon,
  label,
  onPress,
  active,
}: {
  icon: React.ElementType;
  label: string;
  onPress: () => void;
  active?: boolean;
}) {
  const iconChrome = useNativePhoneIconChrome();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityLabel={label}
      accessibilityRole="button"
      className="min-w-[64px] items-center gap-1.5 py-1"
    >
      <View className="h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Icon
          size={20}
          color={active ? undefined : iconChrome.color}
          strokeWidth={iconChrome.strokeWidth}
          className={active ? "text-primary" : undefined}
        />
      </View>
      <Text className="text-[11px] text-muted-foreground">{label}</Text>
    </Pressable>
  );
}
