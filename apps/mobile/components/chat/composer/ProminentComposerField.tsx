// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { forwardRef, useMemo, type Ref, type ComponentType } from "react";
import {
  Animated,
  Platform,
  Text,
  TextInput,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
  type TextInputKeyPressEventData,
  type TextLayoutEventData,
} from "react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { COMPOSER_KEYBOARD_PROPS } from "../../../lib/composer-phone";
import {
  PROMINENT_COMPOSER_FONT_SIZE,
  PROMINENT_COMPOSER_LINE_HEIGHT,
  PROMINENT_COMPOSER_MEASURE_TEXT_WIDTH,
  PROMINENT_COMPOSER_MIN_HEIGHT,
  ProminentAnimatedTextInput,
} from "../useProminentComposerExpansion";

type ProminentComposerFieldProps = {
  value: string;
  placeholder: string;
  empty: boolean;
  stacked: boolean;
  disabled?: boolean;
  dimWhenDisabled?: boolean;
  inputHeight: number;
  inputHeightAnimation: Animated.Value;
  slotStyle: Record<string, unknown>;
  textColor: string;
  placeholderColor: string;
  placeholderOpacity?: Animated.Value;
  testID: string;
  accessibilityLabel: string;
  selection?: { start: number; end: number };
  onChangeText: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onSubmitEditing?: () => void;
  onSelectionChange?: (event: any) => void;
  onKeyPress?: (
    event: NativeSyntheticEvent<TextInputKeyPressEventData>,
  ) => void;
  onContentSizeChange?: (
    event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>,
  ) => void;
  onMeasureTextLayout: (
    event: NativeSyntheticEvent<TextLayoutEventData>,
  ) => void;
  scrollEnabled?: boolean;
  onLayout?: (event: any) => void;
  inputComponent?: ComponentType<any>;
  children?: never;
};

export const ProminentComposerField = forwardRef<
  TextInput,
  ProminentComposerFieldProps
>(function ProminentComposerField(
  {
    value,
    placeholder,
    empty,
    stacked,
    disabled = false,
    dimWhenDisabled = true,
    inputHeight,
    inputHeightAnimation,
    slotStyle,
    textColor,
    placeholderColor,
    placeholderOpacity,
    testID,
    accessibilityLabel,
    selection,
    onChangeText,
    onFocus,
    onBlur,
    onSubmitEditing,
    onSelectionChange,
    onKeyPress,
    onContentSizeChange,
    onMeasureTextLayout,
    scrollEnabled = false,
    onLayout,
    inputComponent,
  },
  ref: Ref<TextInput>,
) {
    const FieldInput = useMemo(
      () =>
        inputComponent
          ? Animated.createAnimatedComponent(inputComponent)
          : ProminentAnimatedTextInput,
      [inputComponent],
    );
  return (
    <>
      <Text
        pointerEvents="none"
        style={{
          position: "absolute",
          opacity: 0,
          width: PROMINENT_COMPOSER_MEASURE_TEXT_WIDTH,
          height: 0,
          overflow: "hidden",
          fontSize: PROMINENT_COMPOSER_FONT_SIZE,
          lineHeight: PROMINENT_COMPOSER_LINE_HEIGHT,
        }}
        onTextLayout={onMeasureTextLayout}
      >
        {value.length === 0 ? " " : value}
      </Text>
      <Animated.View
        pointerEvents="auto"
        style={[
          slotStyle,
          {
            height: inputHeightAnimation,
          },
        ]}
        onLayout={onLayout}
      >
        <Animated.Text
          pointerEvents="none"
          numberOfLines={1}
          ellipsizeMode="tail"
          {...(Platform.OS !== "web"
            ? {
                accessibilityElementsHidden: !empty,
                importantForAccessibility: empty
                  ? "auto"
                  : "no-hide-descendants",
              }
            : {})}
          style={{
            position: "absolute",
            left: 4,
            right: 4,
            top: stacked ? 0 : 1,
            height: PROMINENT_COMPOSER_MIN_HEIGHT,
            fontSize: PROMINENT_COMPOSER_FONT_SIZE,
            lineHeight: PROMINENT_COMPOSER_LINE_HEIGHT,
            color: placeholderColor,
            // Do not let the fading placeholder paint over newly typed native
            // text. Native can composite both layers for a frame while the
            // Animated.Value transitions, which produces visible ghost text.
            opacity: empty ? (placeholderOpacity ?? 1) : 0,
          }}
        >
          {placeholder}
        </Animated.Text>
        <FieldInput
          ref={ref}
          testID={testID}
          placeholder=""
          accessibilityLabel={accessibilityLabel}
          value={value}
          selection={selection}
          onChangeText={onChangeText}
          onFocus={onFocus}
          onBlur={onBlur}
          onSubmitEditing={onSubmitEditing}
          onSelectionChange={onSelectionChange}
          onKeyPress={onKeyPress}
          editable={!disabled}
          multiline
          scrollEnabled={scrollEnabled}
          {...COMPOSER_KEYBOARD_PROPS}
          onContentSizeChange={onContentSizeChange}
          style={{
            width: "100%",
            minHeight: PROMINENT_COMPOSER_MIN_HEIGHT,
            height: inputHeightAnimation,
            color: textColor,
            fontSize: PROMINENT_COMPOSER_FONT_SIZE,
            lineHeight: PROMINENT_COMPOSER_LINE_HEIGHT,
            paddingHorizontal: stacked ? 0 : 4,
            paddingTop: stacked ? 0 : 1,
            paddingBottom: stacked ? 0 : 1,
            margin: 0,
            backgroundColor: "transparent",
            textAlignVertical: stacked
              ? "top"
              : Platform.OS === "android"
                ? "center"
                : undefined,
            ...(Platform.OS === "android"
              ? { includeFontPadding: false }
              : null),
          }}
          className={cn(
            disabled && dimWhenDisabled && "opacity-50",
            Platform.OS === "web" && "outline-none no-focus-ring",
          )}
        />
      </Animated.View>
    </>
  );
});
