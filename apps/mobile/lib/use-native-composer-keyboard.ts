// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useRef } from 'react'
import { Dimensions, Easing, Keyboard, Platform } from 'react-native'
import {
  nativeComposerKeyboardOverlap,
  NATIVE_COMPOSER_KEYBOARD_EASING,
  type NativeComposerKeyboardEvent,
  type NativeComposerKeyboardSource,
} from './native-composer-keyboard'

export function nativeComposerKeyboardEasing() {
  return Easing.bezier(
    NATIVE_COMPOSER_KEYBOARD_EASING[0],
    NATIVE_COMPOSER_KEYBOARD_EASING[1],
    NATIVE_COMPOSER_KEYBOARD_EASING[2],
    NATIVE_COMPOSER_KEYBOARD_EASING[3],
  )
}

export function nativeComposerKeyboardOverlapFromEvent(
  event: NativeComposerKeyboardEvent,
): number {
  return nativeComposerKeyboardOverlap(event.endCoordinates, Dimensions.get('window').height)
}

export function subscribeNativeComposerKeyboard(
  listener: (event: NativeComposerKeyboardEvent, source: NativeComposerKeyboardSource) => void,
): () => void {
  const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
  const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
  const showSub = Keyboard.addListener(showEvent, (event) => listener(event, 'show'))
  const hideSub = Keyboard.addListener(hideEvent, (event) => listener(event, 'hide'))
  const changeSub =
    Platform.OS === 'ios'
      ? Keyboard.addListener('keyboardWillChangeFrame', (event) => listener(event, 'change'))
      : undefined
  return () => {
    showSub.remove()
    hideSub.remove()
    changeSub?.remove()
  }
}

/** Subscribe once; the latest `onFrame` is read from a ref so callers can close over rest pads. */
export function useNativeComposerKeyboard(
  enabled: boolean,
  onFrame: (event: NativeComposerKeyboardEvent, source: NativeComposerKeyboardSource) => void,
): void {
  const onFrameRef = useRef(onFrame)
  onFrameRef.current = onFrame
  useEffect(() => {
    if (!enabled) return
    return subscribeNativeComposerKeyboard((event, source) => {
      onFrameRef.current(event, source)
    })
  }, [enabled])
}
