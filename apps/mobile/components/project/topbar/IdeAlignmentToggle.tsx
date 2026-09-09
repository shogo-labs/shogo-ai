// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useRef } from "react";
import { Platform, Pressable, View } from "react-native";
import {
  IDE_ALIGNMENT_TOGGLE_TEST_ID,
  ideAlignmentLabel,
} from "../../../lib/project-topbar-layout";
import type { IdePrimarySideBarPosition } from "./types";

export function IdeAlignmentToggle({
  position,
  nextPosition,
  onPress,
}: {
  position: IdePrimarySideBarPosition;
  nextPosition: IdePrimarySideBarPosition;
  onPress: () => void;
}) {
  const title = ideAlignmentLabel(nextPosition);
  const tipRef = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS === "web" && tipRef.current) {
      (tipRef.current as unknown as HTMLElement).title = title;
    }
  }, [title]);
  const leftActive = position === "left";

  return (
    <Pressable
      ref={tipRef}
      onPress={onPress}
      className="h-7 w-7 items-center justify-center rounded-md active:bg-muted web:hover:bg-muted/70"
      accessibilityRole="button"
      accessibilityLabel={title}
      testID={IDE_ALIGNMENT_TOGGLE_TEST_ID}
    >
      <View className="h-[17px] w-[17px] flex-row overflow-hidden rounded-[4px] border border-muted-foreground/80 bg-background">
        {leftActive && <View className="w-[6px] bg-muted-foreground" />}
        <View className="flex-1 bg-transparent" />
        {!leftActive && <View className="w-[6px] bg-muted-foreground" />}
      </View>
    </Pressable>
  );
}
