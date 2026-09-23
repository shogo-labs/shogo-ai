// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import {
  Platform,
  StyleSheet,
  useColorScheme,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { BlurView } from "expo-blur";

export function supportsLiquidGlass(): boolean {
  // Keep the existing iOS-only presentation; Android and web retain their
  // opaque fallback chrome instead of taking on a new visual treatment.
  return Platform.OS === "ios";
}

export function LiquidGlassBackdrop({
  style,
  tintColor,
}: {
  style?: StyleProp<ViewStyle>;
  tintColor?: string;
}) {
  const colorScheme = useColorScheme();
  if (!supportsLiquidGlass()) return null;

  return (
    <BlurView
      pointerEvents="none"
      intensity={75}
      tint={colorScheme === "dark" ? "dark" : "light"}
      style={[
        StyleSheet.absoluteFill,
        tintColor ? { backgroundColor: tintColor } : undefined,
        style,
      ]}
    />
  );
}
