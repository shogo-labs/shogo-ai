// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import React from "react";
import { Pressable } from "react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { NATIVE_ACTIVE_PILL_SHADOW } from "../../../../lib/native-active-shadow";
import { LiquidGlassBackdrop } from "../../../ui/LiquidGlassBackdrop";
import {
  NATIVE_PHONE_CONTROL_SIZE,
  useNativePhoneIconChrome,
} from "../../../../lib/native-phone-layout";

const NATIVE_CIRCLE_ICON_SIZE = 22;

export function NativeCircleButton({
  icon: Icon,
  onPress,
  accessibilityLabel,
  testID,
  active,
  flat,
}: {
  icon: React.ElementType;
  onPress: () => void;
  accessibilityLabel: string;
  testID?: string;
  active?: boolean;
  /** A plain fill, for a button that already sits on a sheet or card. */
  flat?: boolean;
}) {
  const icon = useNativePhoneIconChrome();
  const glass = !active && !flat;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      className={cn(
        "items-center justify-center rounded-full",
        active && "bg-primary",
        flat && !active && "bg-muted",
        glass && "overflow-hidden bg-transparent",
      )}
      style={[
        {
          width: NATIVE_PHONE_CONTROL_SIZE,
          height: NATIVE_PHONE_CONTROL_SIZE,
        },
        glass ? NATIVE_ACTIVE_PILL_SHADOW : undefined,
      ]}
    >
      {glass ? (
        <LiquidGlassBackdrop
          style={{ borderRadius: NATIVE_PHONE_CONTROL_SIZE / 2 }}
        />
      ) : null}
      <Icon
        size={NATIVE_CIRCLE_ICON_SIZE}
        color={active ? undefined : icon.color}
        strokeWidth={icon.strokeWidth}
        className={active ? "text-primary-foreground" : undefined}
      />
    </Pressable>
  );
}
