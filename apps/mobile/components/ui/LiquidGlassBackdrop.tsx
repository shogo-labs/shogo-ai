// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import {
  Platform,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from "expo-glass-effect";

export function supportsLiquidGlass(): boolean {
  if (Platform.OS !== "ios") return false;
  try {
    return isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
  } catch {
    return false;
  }
}

export function LiquidGlassBackdrop({
  style,
  tintColor,
}: {
  style?: StyleProp<ViewStyle>;
  tintColor?: string;
}) {
  if (!supportsLiquidGlass()) return null;

  return (
    <GlassView
      pointerEvents="none"
      glassEffectStyle="regular"
      tintColor={tintColor}
      style={[StyleSheet.absoluteFill, style]}
    />
  );
}
