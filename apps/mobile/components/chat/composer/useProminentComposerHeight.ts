// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useRef } from "react";
import { Animated } from "react-native";
import {
  PROMINENT_COMPOSER_HEIGHT_ANIMATION_DURATION,
  PROMINENT_COMPOSER_HEIGHT_EASING,
  PROMINENT_COMPOSER_MIN_HEIGHT,
  useProminentComposerExpansion,
} from "../useProminentComposerExpansion";

type UseProminentComposerHeightOptions = {
  enabled: boolean;
  empty: boolean;
  text: string;
  inputHeight: number;
  minHeight?: number;
  lineHeight: number;
  paddingTop: number;
  paddingHorizontal: number;
  paddingBottom: number;
  duration?: number;
  easing?: (value: number) => number;
  inputHeightAnimation?: Animated.Value;
  setInputHeight?: (height: number) => void;
  animate?: (
    value: Animated.Value,
    toValue: number,
    duration: number,
    easing: (value: number) => number,
  ) => void;
};

/**
 * Shared wrapper for the prominent field's height animation and the
 * stacked-to-compact reset. Keeping these effects here prevents Home and
 * project composers from developing subtly different transition behavior.
 */
export function useProminentComposerHeight({
  enabled,
  empty,
  text,
  inputHeight,
  minHeight = PROMINENT_COMPOSER_MIN_HEIGHT,
  lineHeight,
  paddingTop,
  paddingHorizontal,
  paddingBottom,
  duration = PROMINENT_COMPOSER_HEIGHT_ANIMATION_DURATION,
  easing = PROMINENT_COMPOSER_HEIGHT_EASING,
  inputHeightAnimation: providedAnimation,
  setInputHeight,
  animate,
}: UseProminentComposerHeightOptions) {
  const ownAnimation = useRef(new Animated.Value(inputHeight)).current;
  const inputHeightAnimation = providedAnimation ?? ownAnimation;
  const previousEnabledRef = useRef(enabled);
  const skipNextHeightAnimationRef = useRef(false);
  const wasStackedRef = useRef(false);

  const expansion = useProminentComposerExpansion({
    enabled,
    empty,
    text,
    inputHeight,
    minHeight,
    lineHeight,
    paddingTop,
    paddingHorizontal,
    paddingBottom,
    duration,
    easing,
  });

  useEffect(() => {
    const modeChanged = previousEnabledRef.current !== enabled;
    previousEnabledRef.current = enabled;
    if (!modeChanged || !enabled) return;

    skipNextHeightAnimationRef.current = true;
    inputHeightAnimation.setValue(minHeight);
    setInputHeight?.(minHeight);
  }, [enabled, inputHeightAnimation, minHeight, setInputHeight]);

  useEffect(() => {
    if (!enabled) return;
    if (skipNextHeightAnimationRef.current) {
      skipNextHeightAnimationRef.current = false;
      return;
    }

    if (animate) {
      animate(inputHeightAnimation, inputHeight, duration, easing);
    } else {
      Animated.timing(inputHeightAnimation, {
        toValue: inputHeight,
        duration,
        easing,
        useNativeDriver: false,
      }).start();
    }
  }, [animate, duration, easing, enabled, inputHeight, inputHeightAnimation]);

  useEffect(() => {
    if (!enabled) {
      wasStackedRef.current = false;
      return;
    }
    if (wasStackedRef.current && !expansion.stacked) {
      setInputHeight?.(minHeight);
    }
    wasStackedRef.current = expansion.stacked;
  }, [enabled, expansion.stacked, minHeight, setInputHeight]);

  return {
    ...expansion,
    inputHeightAnimation,
  };
}
