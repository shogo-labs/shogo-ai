// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Platform, useWindowDimensions } from "react-native";
import { useResolvedTheme } from "../../../contexts/theme";
import {
  isPhoneLayout,
  NATIVE_PHONE_SECTION_INSET,
  usePhoneLayoutOverride,
} from "../../../lib/native-phone-layout";
import { CHATGPT_COMPOSER } from "../../../lib/composer-phone";
import { prominentModelTriggerMaxWidth } from "../useProminentComposerExpansion";

export type ComposerVariant = "web" | "native" | "prominent";

export const COMPOSER_SIZES = {
  web: {
    minHeight: 48,
    maxHeight: 160,
    inputMinHeight: 48,
    inputMaxHeight: 160,
  },
  native: {
    minHeight: 52,
    maxHeight: 160,
    inputMinHeight: 52,
    inputMaxHeight: 160,
  },
  prominent: {
    minHeight: 24,
    maxHeight: 132,
    inputMinHeight: 24,
    inputMaxHeight: 132,
  },
} as const satisfies Record<
  ComposerVariant,
  {
    minHeight: number;
    maxHeight: number;
    inputMinHeight: number;
    inputMaxHeight: number;
  }
>;

function nativeModelMenuWidth(windowWidth: number): number {
  return Math.max(
    240,
    Math.min(280, Math.floor(windowWidth - NATIVE_PHONE_SECTION_INSET))
  );
}

type ComposerLayoutOptions = {
  /** Enables the phone-prominent layout when phone chrome is available. */
  prominent?: boolean;
  /** Inline edit mode intentionally stays in the regular composer layout. */
  flush?: boolean;
};

/**
 * The one place the chat composer (`ChatInput`, used by agent chats, Home,
 * and team chat) decides between phone and desktop layout, so a screen can't
 * end up with the desktop input on a phone. `PhoneLayoutOverrideProvider`
 * forces the answer for a subtree.
 */
export function useComposerLayoutMode({
  prominent = false,
  flush = false,
}: ComposerLayoutOptions = {}) {
  const { width, height } = useWindowDimensions();
  const resolvedTheme = useResolvedTheme();
  const phoneOverride = usePhoneLayoutOverride();
  const isNative = Platform.OS !== "web";
  const isPhoneChrome = phoneOverride ?? isPhoneLayout(width, height);
  const useProminentComposer = isPhoneChrome && prominent && !flush;
  const variant: ComposerVariant = useProminentComposer
    ? "prominent"
    : isNative
    ? "native"
    : "web";

  const sizes = COMPOSER_SIZES[variant];

  const chatgptComposer =
    resolvedTheme === "light" ? CHATGPT_COMPOSER.light : CHATGPT_COMPOSER.dark;

  const modelTriggerMaxWidth = useProminentComposer
    ? prominentModelTriggerMaxWidth(width)
    : Math.max(64, Math.min(96, Math.floor(width * 0.22)));

  return {
    isNative,
    isPhoneChrome,
    useProminentComposer,
    chatgptComposer,
    variant,
    sizes,
    modelTriggerMaxWidth,
    nativeModelMenuWidth: nativeModelMenuWidth(width),
    windowHeight: height,
    /** Alias of `isPhoneChrome` for callers that used the old name. */
    isPhoneViewport: isPhoneChrome,
  };
}
