// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ReactNode } from "react";
import { Animated, View } from "react-native";
import { cn } from "@shogo/shared-ui/primitives";
import {
  chatComposerDockStyle,
  NATIVE_COMPOSER_KEYBOARD_GAP,
} from "../../../lib/native-composer-keyboard";
import {
  NATIVE_PHONE_COMPOSER_PILL_HEIGHT,
  NATIVE_PHONE_DOCK_FADE,
} from "../../../lib/native-phone-layout";
import { useResolvedTheme } from "../../../contexts/theme";
import { NativePhoneBottomFade } from "../../phone/NativePhoneBottomFade";

/**
 * Project chat composer column.
 *
 * Keyboard pad is an Animated.Value, so the padded shell must be
 * Animated.View. NativeWind className on that node never applied (web
 * input went full-bleed); keep alignment classes on the regular Views.
 */
export function ProjectComposerDock({
  columnWidth,
  maxWidth,
  keyboardPad,
  keyboardOpen,
  restPad,
  applyKeyboardPad,
  native,
  phoneViewport,
  children,
}: {
  columnWidth?: number;
  maxWidth?: number;
  keyboardPad: Animated.Value;
  keyboardOpen: boolean;
  restPad: number;
  applyKeyboardPad: boolean;
  native: boolean;
  /** Narrow web uses the same transcript-to-composer dissolve as native. */
  phoneViewport?: boolean;
  children: ReactNode;
}) {
  const isDark = useResolvedTheme() === "dark";
  const showPhoneFade = native || phoneViewport;
  // Separate the focused composer from the system keyboard by one compact
  // line while keeping the dock anchored to the same keyboard frame.
  const keyboardGap = keyboardOpen ? NATIVE_COMPOSER_KEYBOARD_GAP : 0;

  return (
    <View className="w-full items-center">
      <Animated.View
        testID="project-composer-dock"
        style={chatComposerDockStyle({
          // Phone web and native share the same transcript column. Applying a
          // second native-only gutter here made the composer narrower than
          // the mobile-web reference at the same viewport width.
          measuredWidth: columnWidth,
          maxWidth,
          // Only use the measured keyboard overlap while the keyboard is
          // actually visible. A stale keyboard frame must never leave the
          // composer floating in the middle of the chat after dismissal.
          keyboardPad: applyKeyboardPad
            ? keyboardOpen
              ? keyboardPad
              : restPad
            : undefined,
          webOverflowVisible: applyKeyboardPad && !native,
        })}
      >
        {showPhoneFade ? (
          <NativePhoneBottomFade
            isDark={isDark}
            height={
              NATIVE_PHONE_DOCK_FADE +
              NATIVE_PHONE_COMPOSER_PILL_HEIGHT +
              16 +
              keyboardGap
            }
            endOpacity={1}
            style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
          />
        ) : null}
        <View
          className={cn("bg-transparent w-full mt-1", !native && "relative")}
          style={{ marginBottom: keyboardGap }}
        >
          {children}
        </View>
      </Animated.View>
    </View>
  );
}
