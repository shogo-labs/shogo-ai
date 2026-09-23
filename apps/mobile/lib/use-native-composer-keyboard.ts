// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useRef } from 'react'
import { Animated, Dimensions, Easing, Keyboard, Platform } from 'react-native'
import {
  nativeComposerDockBottomPad,
  nativeComposerKeyboardDuration,
  nativeComposerKeyboardOpenFromSource,
  nativeComposerKeyboardOverlap,
  NATIVE_COMPOSER_KEYBOARD_EASING,
  type NativeComposerKeyboardEvent,
  type NativeComposerKeyboardSource,
} from './native-composer-keyboard'

const nativeComposerKeyboardEasingFn = Easing.bezier(
  NATIVE_COMPOSER_KEYBOARD_EASING[0],
  NATIVE_COMPOSER_KEYBOARD_EASING[1],
  NATIVE_COMPOSER_KEYBOARD_EASING[2],
  NATIVE_COMPOSER_KEYBOARD_EASING[3],
)

export function nativeComposerKeyboardEasing() {
  return nativeComposerKeyboardEasingFn
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

/**
 * Web has no `Keyboard` bridge — RN-Web's `Keyboard.addListener` never fires.
 * The virtual keyboard's presence instead shows up as the browser's
 * `visualViewport` shrinking or shifting (RN-Web's own `Dimensions`/
 * `useWindowDimensions` already reads `visualViewport` on web for the same
 * reason — see react-native-web#2430/#2438). Synthesize a
 * `NativeComposerKeyboardEvent` from it so callers can reuse the exact same
 * overlap/pad math as native (`nativeComposerKeyboardOverlap` etc.) instead
 * of a parallel implementation.
 *
 * Both `resize` and `scroll` are needed: most browsers shrink
 * `visualViewport.height` when the keyboard opens, but iOS Safari can
 * instead (or additionally) shift `visualViewport.offsetTop` — scrolling the
 * visual viewport down without a height change — which only fires `scroll`.
 */
function subscribeWebViewportKeyboard(
  listener: (event: NativeComposerKeyboardEvent, source: NativeComposerKeyboardSource) => void,
): () => void {
  if (
    Platform.OS !== 'web' ||
    typeof window === 'undefined' ||
    !window.visualViewport
  ) {
    return () => {}
  }
  const viewport = window.visualViewport

  const handle = () => {
    // How much of the full layout viewport is now covered by the keyboard
    // (or address-bar chrome resize) — the visible area's bottom edge,
    // reported as `screenY`, so `nativeComposerKeyboardOverlap` computes the
    // same "viewportHeight - screenY" overlap it does from native coordinates.
    const visibleBottom = viewport.height + viewport.offsetTop
    listener(
      {
        duration: 200,
        endCoordinates: { screenY: visibleBottom },
      },
      'change',
    )
  }

  viewport.addEventListener('resize', handle)
  viewport.addEventListener('scroll', handle)
  return () => {
    viewport.removeEventListener('resize', handle)
    viewport.removeEventListener('scroll', handle)
  }
}

function subscribeComposerKeyboard(
  listener: (event: NativeComposerKeyboardEvent, source: NativeComposerKeyboardSource) => void,
): () => void {
  if (Platform.OS === 'web') return subscribeWebViewportKeyboard(listener)
  return subscribeNativeComposerKeyboard(listener)
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
    return subscribeComposerKeyboard((event, source) => {
      onFrameRef.current(event, source)
    })
  }, [enabled])
}

/**
 * Shared home / project / search dock pad. One Animated.Value, one keyboard
 * subscription, and the same rest-pad resync when safe-area insets change.
 */
export function useNativeComposerDockPad({
  enabled,
  restPad,
  safeAreaBottom = 0,
  iosKeyboardAvoiding,
  onOpenChange,
}: {
  enabled: boolean
  restPad: number
  safeAreaBottom?: number
  iosKeyboardAvoiding: boolean
  onOpenChange?: (open: boolean) => void
}): Animated.Value {
  const pad = useRef(new Animated.Value(restPad)).current
  const restPadRef = useRef(restPad)
  const avoidingRef = useRef(iosKeyboardAvoiding)
  const openRef = useRef(false)
  const onOpenChangeRef = useRef(onOpenChange)
  restPadRef.current = restPad
  avoidingRef.current = iosKeyboardAvoiding
  onOpenChangeRef.current = onOpenChange

  useNativeComposerKeyboard(enabled, (event, source) => {
    const rest = restPadRef.current
    const overlap = nativeComposerKeyboardOverlapFromEvent(event)
    const keyboardOpen = nativeComposerKeyboardOpenFromSource(source, overlap, rest)
    if (keyboardOpen == null) return
    openRef.current = keyboardOpen
    onOpenChangeRef.current?.(keyboardOpen)
    Animated.timing(pad, {
      toValue: nativeComposerDockBottomPad({
        keyboardOpen,
        overlap,
        restPad: rest,
        safeAreaBottom,
        iosKeyboardAvoiding: avoidingRef.current,
      }),
      duration: nativeComposerKeyboardDuration(event.duration),
      easing: nativeComposerKeyboardEasing(),
      useNativeDriver: false,
    }).start()
  })

  useEffect(() => {
    if (!openRef.current) {
      pad.setValue(restPad)
    }
  }, [pad, restPad])

  return pad
}
