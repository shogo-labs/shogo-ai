// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import React from "react";
import { Pressable } from "react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { NATIVE_ACTIVE_PILL_SHADOW } from "../../../../lib/native-active-shadow";
import { GlassButton } from "../../../team-chat/FloatingChrome";
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
  // A plain circle is the same glass button the phone chrome uses, so the app
  // has one glass circle rather than a copy per surface.
  if (glass) {
    return (
      <GlassButton label={accessibilityLabel} onPress={onPress} testID={testID}>
        <Icon
          size={NATIVE_CIRCLE_ICON_SIZE}
          color={icon.color}
          strokeWidth={icon.strokeWidth}
        />
      </GlassButton>
    );
  }
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
      )}
      style={[
        {
          width: NATIVE_PHONE_CONTROL_SIZE,
          height: NATIVE_PHONE_CONTROL_SIZE,
        },
        active || flat ? NATIVE_ACTIVE_PILL_SHADOW : undefined,
      ]}
    >
      <Icon
        size={NATIVE_CIRCLE_ICON_SIZE}
        color={active ? undefined : icon.color}
        strokeWidth={icon.strokeWidth}
        className={active ? "text-primary-foreground" : undefined}
      />
    </Pressable>
  );
}
