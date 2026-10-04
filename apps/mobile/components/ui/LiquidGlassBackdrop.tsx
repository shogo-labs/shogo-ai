// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The see-through backdrop behind floating phone chrome (composer pill, dock,
 * header buttons). Render it as the first child of a rounded,
 * `overflow-hidden` container with a transparent background.
 *
 * - iOS 26+: native Liquid Glass (`GlassView`).
 * - Older iOS: `BlurView` material.
 * - Web: `WebLiquidGlass` (frost and rim light, plus refraction on Chromium).
 * - Android 12+: `BlurView` sampling the screen's `GlassBlurTarget`; with no
 *   target (or on Android 11 and below) a near-opaque tint instead.
 */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { BlurTargetView, BlurView } from "expo-blur";
import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from "expo-glass-effect";
import { useResolvedTheme } from "../../contexts/theme";
import { WebLiquidGlass } from "./WebLiquidGlass";

const TINT = {
  // Over real blur the tint only needs to set the surface tone.
  blurred: { dark: "rgba(30,30,30,0.55)", light: "rgba(255,255,255,0.6)" },
  // Without blur, content would show through unreadably; stay near-opaque.
  flat: { dark: "rgba(30,30,30,0.94)", light: "rgba(255,255,255,0.94)" },
} as const;
// Without blur, a flat pill needs an edge to separate it from what it covers.
const EDGE = { dark: "rgba(255,255,255,0.10)", light: "rgba(0,0,0,0.08)" } as const;

let nativeGlass: boolean | null = null;
function nativeLiquidGlass(): boolean {
  if (Platform.OS !== "ios") return false;
  if (nativeGlass === null) {
    try {
      nativeGlass = isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
    } catch {
      nativeGlass = false;
    }
  }
  return nativeGlass;
}

// Android blurs a `BlurTargetView` it is not inside of, so the screen that
// owns the scrolling content registers it here for chrome drawn above it.
type Target = RefObject<View | null>;
let currentTarget: Target | null = null;
const listeners = new Set<() => void>();
function setTarget(target: Target | null) {
  currentTarget = target;
  listeners.forEach((l) => l());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const InsideTarget = createContext(false);

/** Wrap the content that floating chrome should blur (Android only). */
export function GlassBlurTarget({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const ref = useRef<View | null>(null);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    setTarget(ref);
    return () => {
      if (currentTarget === ref) setTarget(null);
    };
  }, []);
  if (Platform.OS !== "android") {
    return <View style={[{ flex: 1 }, style]}>{children}</View>;
  }
  return (
    <InsideTarget.Provider value={true}>
      <BlurTargetView ref={ref} style={[{ flex: 1 }, style]}>
        {children}
      </BlurTargetView>
    </InsideTarget.Provider>
  );
}

export function LiquidGlassBackdrop({
  style,
  tintColor,
}: {
  style?: StyleProp<ViewStyle>;
  tintColor?: string;
}) {
  const isDark = useResolvedTheme() === "dark";
  const insideTarget = useContext(InsideTarget);
  const target = useSyncExternalStore(
    subscribe,
    () => currentTarget,
    () => null
  );
  const scheme = isDark ? "dark" : "light";

  if (nativeLiquidGlass()) {
    return (
      <GlassView
        pointerEvents="none"
        glassEffectStyle="regular"
        colorScheme={scheme}
        tintColor={tintColor}
        style={[StyleSheet.absoluteFill, style]}
      />
    );
  }

  if (Platform.OS === "web") return <WebLiquidGlass style={style} />;

  if (
    Platform.OS === "android" &&
    (!target || insideTarget || (Platform.Version as number) < 31)
  ) {
    return (
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: TINT.flat[scheme],
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: EDGE[scheme],
          },
          style,
        ]}
      />
    );
  }

  return (
    <BlurView
      pointerEvents="none"
      intensity={75}
      tint={scheme}
      blurTarget={Platform.OS === "android" ? target ?? undefined : undefined}
      blurMethod="dimezisBlurViewSdk31Plus"
      style={[
        StyleSheet.absoluteFill,
        Platform.OS === "ios" && !tintColor
          ? undefined
          : { backgroundColor: tintColor ?? TINT.blurred[scheme] },
        style,
      ]}
    />
  );
}
