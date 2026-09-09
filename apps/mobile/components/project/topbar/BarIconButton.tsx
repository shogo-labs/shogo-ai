// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import React, { useEffect, useRef } from "react";
import { Platform, Pressable, type View } from "react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { useNativePhoneIconChrome } from "../../../lib/native-phone-layout";

/** Set the native HTML `title` tooltip on the DOM element via ref. */
function useWebTitle(title?: string) {
  const ref = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS === "web" && ref.current) {
      (ref.current as unknown as HTMLElement).title = title ?? "";
    }
  }, [title]);
  return ref;
}

export function BarIconButton({
  icon: Icon,
  onPress,
  onHoverIn,
  active,
  title,
  size = 12,
  testID,
}: {
  icon: React.ElementType;
  onPress: () => void;
  /** Intent signal — fires on hover (web) and on press-in (touch). */
  onHoverIn?: () => void;
  active?: boolean;
  title?: string;
  size?: number;
  testID?: string;
}) {
  const tipRef = useWebTitle(title);
  const isNative = Platform.OS !== "web";
  const iconChrome = useNativePhoneIconChrome();

  return (
    <Pressable
      ref={tipRef}
      onPress={onPress}
      onHoverIn={onHoverIn}
      onPressIn={onHoverIn}
      hitSlop={isNative ? 4 : undefined}
      testID={testID}
      className={cn(
        "items-center justify-center rounded-md",
        isNative ? "h-9 w-9" : "h-6 w-6",
        active ? "bg-primary" : "active:bg-muted",
      )}
      accessibilityLabel={title}
    >
      <Icon
        size={isNative ? Math.max(size, 18) : size}
        color={isNative && !active ? iconChrome.color : undefined}
        strokeWidth={isNative ? iconChrome.strokeWidth : undefined}
        className={cn(
          active
            ? "text-primary-foreground"
            : !isNative && "text-muted-foreground",
        )}
      />
    </Pressable>
  );
}
