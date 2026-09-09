// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { StyleProp, ViewStyle } from "react-native";

export interface ComposerModelPickerPropsOptions {
  currentModelId: string;
  effectiveIsPro: boolean;
  disabled: boolean;
  nativeSheet: boolean;
  triggerClassName: string;
  triggerStyle?: StyleProp<ViewStyle>;
  labelClassName: string;
  chevronSize: number;
  chevronColor?: string;
  chevronStrokeWidth?: number;
  hitSlop?: number;
  label: string;
  menuWidth: number;
  onSelect: (modelId: string) => void;
}

/**
 * Shared prop assembly keeps the Home and project composers' model trigger
 * behavior aligned while leaving ModelPickerMenu as the rendering boundary.
 */
export function composerModelPickerProps({
  currentModelId,
  effectiveIsPro,
  disabled,
  nativeSheet,
  triggerClassName,
  triggerStyle,
  labelClassName,
  chevronSize,
  chevronColor,
  chevronStrokeWidth,
  hitSlop,
  label,
  menuWidth,
  onSelect,
}: ComposerModelPickerPropsOptions) {
  return {
    currentModelId,
    effectiveIsPro,
    disabled,
    nativeSheet,
    triggerClassName,
    triggerStyle,
    labelClassName,
    chevronSize,
    chevronColor,
    chevronStrokeWidth,
    hitSlop,
    label,
    menuWidth,
    onSelect,
  };
}
