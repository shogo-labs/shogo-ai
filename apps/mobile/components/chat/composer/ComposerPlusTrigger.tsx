// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ReactNode } from "react";
import { Pressable } from "react-native";
import { Plus } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { NATIVE_PHONE_ICON_STROKE } from "../../../lib/native-phone-layout";

export function ComposerPlusTrigger({
  onPress,
  disabled = false,
  testID,
  color,
  className,
  children,
}: {
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
  color?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      disabled={disabled}
      role="button"
      accessibilityLabel="Add"
      className={cn(
        "h-8 w-8 items-center justify-center active:opacity-70",
        disabled && "opacity-40",
        className,
      )}
      testID={testID}
    >
      {children ?? (
        <Plus color={color} size={22} strokeWidth={NATIVE_PHONE_ICON_STROKE} />
      )}
    </Pressable>
  );
}
