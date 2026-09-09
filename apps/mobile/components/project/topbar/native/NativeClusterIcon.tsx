// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import React from "react";
import { Pressable } from "react-native";
import {
  NATIVE_PHONE_CONTROL_SIZE,
  useNativePhoneIconChrome,
} from "../../../../lib/native-phone-layout";

export const NATIVE_CLUSTER_SLOT = 36;

export function NativeClusterIcon({
  icon: Icon,
  onPress,
  accessibilityLabel,
  testID,
}: {
  icon: React.ElementType;
  onPress: () => void;
  accessibilityLabel: string;
  testID?: string;
}) {
  const iconChrome = useNativePhoneIconChrome();
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      className="items-center justify-center"
      style={{ width: NATIVE_CLUSTER_SLOT, height: NATIVE_PHONE_CONTROL_SIZE }}
    >
      <Icon
        size={20}
        color={iconChrome.color}
        strokeWidth={iconChrome.strokeWidth}
      />
    </Pressable>
  );
}
