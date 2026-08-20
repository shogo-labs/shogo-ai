// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { createElement, forwardRef } from 'react'

/**
 * Comprehensive `react-native` mock, shared by the process-wide preload
 * (`test/testing-library.ts`) and every per-file `mock.module('react-native',
 * ...)` override.
 *
 * Bun's `mock.module` *replaces* a module rather than merging with an
 * already-registered mock, so a per-file override that returns a hand-picked
 * subset (say, just `{ Platform, View, Text, TextInput }` for the one
 * component the test renders) silently strips every other export for the
 * rest of that file's module graph -- including exports the test author
 * never touched, needed by whatever else the component under test happens
 * to pull in transitively. That has broken ChatInput's tests three separate
 * times, each on a different, unrelated member:
 *   - `Appearance`  (read by `react-native-css-interop`'s color-scheme code)
 *   - `Easing` + `Animated.{View,Text,FlatList,Image,ScrollView,SectionList}`
 *     (read by `@legendapp/motion`, which `@gluestack-ui`'s Modal uses)
 *   - `Keyboard` + `AccessibilityInfo` (read directly by
 *     `@gluestack-ui/core`'s `ModalContent`)
 * All three crashed at MODULE LOAD time -- before any test assertion runs --
 * as an "Unhandled error between tests", not a normal test failure.
 *
 * `createReactNativeMock(overrides)` is the fix: start from this full
 * surface and layer a file's specific needs (`Platform.OS`, a custom
 * `TextInput`, …) on top, instead of replacing the whole module. New
 * transitive dependencies only need to be added once, here.
 */

const passthroughHost = (tag: string) =>
  forwardRef(function HostShim(props: Record<string, unknown>, ref: React.Ref<HTMLDivElement>) {
    const { children, style, ...rest } = props as {
      children?: React.ReactNode
      style?: unknown
    }
    return createElement(tag, { ...rest, ref, 'data-rn-shim': props['testID'] ?? undefined }, children)
  })

export const reactNativeMockBase = {
  Platform: {
    OS: 'web',
    Version: 0,
    isPad: false,
    isTV: false,
    select: <T,>(spec: { web?: T; default?: T }) => (spec.web !== undefined ? spec.web : spec.default),
  },
  StyleSheet: {
    create: <T,>(s: T) => s,
    flatten: (s: unknown) => s,
    hairlineWidth: 1,
    absoluteFill: {},
    absoluteFillObject: {},
  },
  Dimensions: {
    get: () => ({ width: 1024, height: 768, scale: 1, fontScale: 1 }),
    addEventListener: () => ({ remove: () => {} }),
  },
  Appearance: {
    getColorScheme: () => 'light',
    addChangeListener: () => ({ remove: () => {} }),
  },
  Easing: {
    linear: (t: number) => t,
    ease: (t: number) => t,
    circle: (t: number) => t,
    back:
      (_s = 1.5) =>
      (t: number) =>
        t,
    inOut:
      (fn: (t: number) => number) =>
      (t: number) =>
        fn(t),
    out:
      (fn: (t: number) => number) =>
      (t: number) =>
        1 - fn(1 - t),
  },
  Keyboard: {
    addListener: () => ({ remove: () => {} }),
    dismiss: () => {},
  },
  PixelRatio: {
    get: () => 1,
    getFontScale: () => 1,
    getPixelSizeForLayoutSize: (n: number) => n,
    roundToNearestPixel: (n: number) => n,
  },
  View: passthroughHost('div'),
  Text: passthroughHost('span'),
  TextInput: passthroughHost('input'),
  ScrollView: passthroughHost('div'),
  Pressable: passthroughHost('button'),
  TouchableOpacity: passthroughHost('button'),
  TouchableHighlight: passthroughHost('button'),
  TouchableWithoutFeedback: passthroughHost('div'),
  FlatList: passthroughHost('div'),
  SafeAreaView: passthroughHost('div'),
  KeyboardAvoidingView: passthroughHost('div'),
  Modal: passthroughHost('div'),
  ActivityIndicator: passthroughHost('div'),
  Image: passthroughHost('img'),
  Animated: {
    View: passthroughHost('div'),
    Text: passthroughHost('span'),
    Image: passthroughHost('img'),
    ScrollView: passthroughHost('div'),
    FlatList: passthroughHost('div'),
    SectionList: passthroughHost('div'),
    Value: class {
      setValue() {}
      addListener() {
        return 'id'
      }
      removeListener() {}
      removeAllListeners() {}
      interpolate() {
        return this
      }
    },
    timing: () => ({ start: (cb?: () => void) => cb?.() }),
    spring: () => ({ start: (cb?: () => void) => cb?.() }),
    sequence: () => ({ start: (cb?: () => void) => cb?.() }),
    parallel: () => ({ start: (cb?: () => void) => cb?.() }),
    loop: () => ({ start: () => {} }),
    createAnimatedComponent: <T,>(c: T) => c,
  },
  NativeModules: {},
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => {} }
    }
    removeAllListeners() {}
  },
  DeviceEventEmitter: {
    addListener: () => ({ remove: () => {} }),
    emit: () => {},
  },
  Linking: {
    openURL: () => Promise.resolve(),
    canOpenURL: () => Promise.resolve(false),
    addEventListener: () => ({ remove: () => {} }),
  },
  InteractionManager: {
    runAfterInteractions: (cb: () => void) => {
      cb()
      return { cancel: () => {} }
    },
  },
  UIManager: {
    measureInWindow: () => {},
    measure: () => {},
    setLayoutAnimationEnabledExperimental: () => {},
  },
  // `react-native-svg` (transitive dep of `lucide-react-native`) destructures
  // `Touchable.Mixin` at module load. Provide an empty mixin so its module
  // evaluation doesn't throw.
  Touchable: {
    Mixin: {},
    TOUCH_TARGET_DEBUG: false,
    renderDebugView: () => null,
  },
  // Same story as `Touchable` above: `react-native-svg` reads the key set of
  // `PanResponder.create({}).panHandlers` at module load, so this has to
  // return the real handler names rather than a bare object.
  PanResponder: {
    create: () => ({
      panHandlers: {
        onStartShouldSetResponder: () => false,
        onMoveShouldSetResponder: () => false,
        onResponderGrant: () => {},
        onResponderMove: () => {},
        onResponderRelease: () => {},
        onResponderTerminate: () => {},
        onResponderTerminationRequest: () => true,
        onStartShouldSetResponderCapture: () => false,
        onMoveShouldSetResponderCapture: () => false,
        onResponderReject: () => {},
        onResponderStart: () => {},
        onResponderEnd: () => {},
      },
    }),
  },
  StatusBar: passthroughHost('div'),
  // Misc named exports referenced by Expo / RN-svg / lucide transitively at
  // module-load time.
  TurboModuleRegistry: {
    getEnforcing: () => ({}),
    get: () => null,
  },
  NativeAppEventEmitter: {
    addListener: () => ({ remove: () => {} }),
  },
  findNodeHandle: () => null,
  requireNativeComponent: () => passthroughHost('div'),
  processColor: (c: unknown) => c,
  LayoutAnimation: {
    configureNext: () => {},
    Presets: { spring: {}, easeInEaseOut: {}, linear: {} },
    Types: {},
    Properties: {},
    create: () => ({}),
  },
  AppRegistry: {
    registerComponent: () => {},
    runApplication: () => {},
  },
  AppState: {
    currentState: 'active',
    addEventListener: () => ({ remove: () => {} }),
  },
  BackHandler: {
    addEventListener: () => ({ remove: () => {} }),
    removeEventListener: () => {},
    exitApp: () => {},
  },
  AccessibilityInfo: {
    addEventListener: () => ({ remove: () => {} }),
    isScreenReaderEnabled: () => Promise.resolve(false),
    isReduceMotionEnabled: () => Promise.resolve(false),
  },
  PermissionsAndroid: {
    PERMISSIONS: {},
    RESULTS: {},
    request: () => Promise.resolve('granted'),
    check: () => Promise.resolve(true),
  },
  Alert: { alert: () => {} },
  Share: { share: () => Promise.resolve({ action: 'dismissed' }) },
  Settings: {
    get: () => undefined,
    set: () => {},
    watchKeys: () => 0,
    clearWatch: () => {},
  },
  Vibration: { vibrate: () => {}, cancel: () => {} },
  I18nManager: {
    isRTL: false,
    doLeftAndRightSwapInRTL: true,
    allowRTL: () => {},
    forceRTL: () => {},
    swapLeftAndRightInRTL: () => {},
    getConstants: () => ({ isRTL: false, doLeftAndRightSwapInRTL: true }),
  },
  UIIManager: {},
}

/**
 * Layer per-file overrides on top of the full mock instead of replacing it.
 *
 * `Platform` and `Animated` get their own shallow merge on top of the
 * top-level one: a caller overriding `Platform: { OS: "ios" }` wants a
 * different OS, not to strip `Platform.select`/`Platform.Version` — the
 * same "replace instead of merge" trap this file exists to avoid, one
 * level down.
 */
export function createReactNativeMock(overrides: Partial<typeof reactNativeMockBase> & Record<string, unknown> = {}) {
  return {
    ...reactNativeMockBase,
    ...overrides,
    Platform: { ...reactNativeMockBase.Platform, ...(overrides.Platform as object | undefined) },
    Animated: { ...reactNativeMockBase.Animated, ...(overrides.Animated as object | undefined) },
  }
}
