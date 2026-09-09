// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { ArrowUp, Loader2 } from "lucide-react-native";
import { Pressable, View } from "react-native";
import { cn } from "@shogo/shared-ui/primitives";

export function ComposerSendButton({
  canSend,
  onPress,
  disabled = false,
  loading = false,
  prominent = false,
  sizeClassName,
  iconSize,
  fillClassName = "bg-primary",
  iconClassName = "text-primary-foreground",
  fillColor,
  iconColor,
  accessibilityLabel = "Send message",
  testID,
}: {
  canSend: boolean;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  prominent?: boolean;
  sizeClassName?: string;
  iconSize?: number;
  fillClassName?: string;
  iconClassName?: string;
  fillColor?: string;
  iconColor?: string;
  accessibilityLabel?: string;
  testID?: string;
}) {
  if (loading) {
    return (
      <View
        className={cn(
          "rounded-full items-center justify-center",
          fillClassName,
          prominent ? "h-8 w-8" : (sizeClassName ?? "h-9 w-9"),
        )}
        style={
          fillColor
            ? { backgroundColor: fillColor, opacity: 0.5 }
            : { opacity: 0.5 }
        }
      >
        <Loader2
          className={cn("animate-spin", iconClassName)}
          color={iconColor}
          size={iconSize ?? (prominent ? 14 : 18)}
        />
      </View>
    );
  }

  if (!canSend) return null;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      role="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      className={cn(
        "rounded-full items-center justify-center",
        fillClassName,
        prominent ? "h-8 w-8" : (sizeClassName ?? "h-9 w-9"),
        disabled && "opacity-50",
      )}
      style={fillColor ? { backgroundColor: fillColor } : undefined}
    >
      <ArrowUp
        className={iconClassName}
        color={iconColor}
        size={iconSize ?? (prominent ? 14 : 18)}
      />
    </Pressable>
  );
}
