// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// react-native-reanimated NoOp shim
// =================================
//
// Why this file exists
// --------------------
// We ship the mobile app without the Reanimated 4 native binding (the iOS
// project's autolinking `exclude` list — apps/mobile/package.json — pulls
// both `react-native-reanimated` and `react-native-worklets` out of the
// CocoaPods install, and `newArchEnabled: false` in app.json forbids the
// Fabric/Turbo runtime Reanimated 4 needs). Reanimated and the worklets
// runtime are deliberately not part of this build's surface area.
//
// However NativeWind's underlying interop package (`react-native-css-interop`
// 0.2.x) lazy-`require()`s `react-native-reanimated` whenever any styled
// element has a `transition-*` / `animate-*` / `duration-*` class — which is
// hundreds of components in this codebase. Without a Reanimated module to
// load, the destructured top-level statement
//
//     const { makeMutable, withTiming, … } = require("react-native-reanimated")
//
// resolved to `undefined` in the production iOS bundle and crashed the
// renderer with "Cannot read property 'makeMutable' of undefined" — that's
// the App Review / TestFlight error users see on the project entry screen.
//
// What this shim does
// -------------------
// Provides a self-contained, dependency-free JS module that exports the same
// surface css-interop (and a handful of other libs that probe Reanimated at
// runtime) destructures. Mutables become a plain `{ value }` object and
// every animation primitive (`withTiming`, `withDelay`, `withRepeat`,
// `withSequence`, `withSpring`, `withDecay`, `cancelAnimation`) returns the
// final value synchronously — i.e. animations land at their end-state
// instantly instead of throwing. Easing matches the runtime's named-table
// shape with identity bezier functions so a `cubicBezier(...)` lookup on
// the stub still returns a callable.
//
// Metro is wired to alias both `react-native-reanimated` and
// `react-native-worklets` to this directory in `metro.config.js`; that's
// the only place these stubs are reachable from. Removing the alias (or
// installing the real Reanimated/Worklets pods) makes this file a no-op.
//
// This shim must remain importable from any RN environment — it has no
// dependencies, makes no native calls, and never throws.

function noopMutable(value) {
  return {
    _isReanimatedSharedValue: true,
    value,
    get: function () { return this.value },
    set: function (v) { this.value = v },
    addListener: function () {},
    removeListener: function () {},
    modify: function (modifier) {
      if (typeof modifier === 'function') {
        try { this.value = modifier(this.value) } catch (_) {}
      }
      return this.value
    },
  }
}

function makeMutable(value) {
  return noopMutable(value)
}

function makeShareable(value) {
  return value
}

function makeShareableCloneRecursive(value) {
  return value
}

// All animation helpers resolve to the *final* value synchronously.
// CSS-interop only reads `.value` off the result, so returning the
// resolved value (or a callback that resolves to it) avoids both the
// "missing native module" error and any animation-in-flight state.

function withTiming(toValue, _config, callback) {
  if (typeof callback === 'function') {
    try { callback(true) } catch (_) {}
  }
  return toValue
}

function withSpring(toValue, _config, callback) {
  if (typeof callback === 'function') {
    try { callback(true) } catch (_) {}
  }
  return toValue
}

function withDecay(_config, callback) {
  if (typeof callback === 'function') {
    try { callback(true) } catch (_) {}
  }
  return 0
}

function withDelay(_delayMs, animation) {
  return animation
}

function withRepeat(animation, _numberOfReps, _reverse, callback) {
  if (typeof callback === 'function') {
    try { callback(true) } catch (_) {}
  }
  return animation
}

function withSequence(...args) {
  return args[args.length - 1]
}

function cancelAnimation(sharedValue) {
  if (sharedValue && typeof sharedValue === 'object' && 'value' in sharedValue) {
    return sharedValue.value
  }
  return undefined
}

function runOnUI(fn) {
  return function () {
    try { return fn.apply(null, arguments) } catch (_) {}
  }
}

function runOnJS(fn) {
  return function () {
    try { return fn.apply(null, arguments) } catch (_) {}
  }
}

const identityBezier = function (t) { return t }
function bezier() { return identityBezier }
function bezierFn() { return identityBezier }

const Easing = {
  linear: identityBezier,
  ease: identityBezier,
  quad: identityBezier,
  cubic: identityBezier,
  poly: function () { return identityBezier },
  sin: identityBezier,
  circle: identityBezier,
  exp: identityBezier,
  elastic: function () { return identityBezier },
  back: function () { return identityBezier },
  bounce: identityBezier,
  bezier,
  bezierFn,
  in: function (fn) { return typeof fn === 'function' ? fn : identityBezier },
  out: function (fn) { return typeof fn === 'function' ? fn : identityBezier },
  inOut: function (fn) { return typeof fn === 'function' ? fn : identityBezier },
  steps: function () { return identityBezier },
}

const ReduceMotion = { System: 'system', Always: 'always', Never: 'never' }

function unwrapMaybeMutable(value) {
  if (value && typeof value === 'object' && value._isReanimatedSharedValue && 'value' in value) {
    return value.value
  }
  return value
}

function normalizeAnimatedStyle(value) {
  value = unwrapMaybeMutable(value)
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(normalizeAnimatedStyle)

  const output = {}
  for (const [key, raw] of Object.entries(value)) {
    let next = normalizeAnimatedStyle(raw)
    if (
      (key === 'rotate' || key === 'rotateZ' || key === 'rotateX' || key === 'rotateY' || key === 'skewX' || key === 'skewY') &&
      typeof next === 'number'
    ) {
      // react-native-svg's transform extractor expects angle values to be
      // strings with units (`deg`/`rad`). CSS animations from NativeWind
      // reach this shim as numbers, so normalize them before Svg/Path
      // calls `angle.endsWith(...)`.
      next = `${next}deg`
    }
    output[key] = next
  }
  return output
}

function useAnimatedStyle(factory) {
  try { return normalizeAnimatedStyle(typeof factory === 'function' ? factory() || {} : {}) }
  catch (_) { return {} }
}

function useAnimatedProps(factory) {
  try { return normalizeAnimatedStyle(typeof factory === 'function' ? factory() || {} : {}) }
  catch (_) { return {} }
}

function useDerivedValue(factory) {
  try { return noopMutable(typeof factory === 'function' ? factory() : undefined) }
  catch (_) { return noopMutable(undefined) }
}

function useAnimatedReaction() {}
function useAnimatedScrollHandler() { return function () {} }
function useAnimatedGestureHandler() { return function () {} }
function useAnimatedRef() { return { current: null } }

// NOTE — `useSharedValue` is intentionally OMITTED from the export list.
// Several libraries in the dep tree (notably `react-native-gesture-handler`
// in `reanimatedWrapper.js`) probe for "real Reanimated" using
//
//     if (!Reanimated?.useSharedValue) Reanimated = undefined
//
// and switch to a pure-JS fallback path when the hook is missing. We want
// that fallback: it routes gestures through the JS bridge instead of the
// (non-existent) worklets runtime. Other hooks, especially
// `useAnimatedStyle`, are still exported because NativeWind's
// css-interop requires them for `animate-*` classes such as the loading
// spinner in CompactChatInput.

const View = require('react-native').View
const ScrollView = require('react-native').ScrollView
const Image = require('react-native').Image
const Text = require('react-native').Text
const FlatList = require('react-native').FlatList

function createAnimatedComponent(Component) { return Component }

const Animated = {
  View,
  ScrollView,
  Image,
  Text,
  FlatList,
  createAnimatedComponent,
}

function isReanimated3() { return false }
function isConfigured() { return false }
function getViewProp() { return Promise.resolve(undefined) }
function enableLayoutAnimations() {}
function configureReanimatedLogger() {}

const LayoutAnimationConfig = function (props) { return props && props.children ? props.children : null }
const FadeIn = {}
const FadeOut = {}
const SlideInRight = {}
const SlideOutRight = {}
const SlideInLeft = {}
const SlideOutLeft = {}
const ZoomIn = {}
const ZoomOut = {}
const Layout = {}
const LinearTransition = {}

module.exports = {
  default: Animated,
  __esModule: true,
  // Animation primitives
  makeMutable,
  makeShareable,
  makeShareableCloneRecursive,
  withTiming,
  withSpring,
  withDecay,
  withDelay,
  withRepeat,
  withSequence,
  cancelAnimation,
  runOnUI,
  runOnJS,
  Easing,
  ReduceMotion,
  // Hooks: intentionally omit `useSharedValue`, but keep the JS-only
  // hooks css-interop destructures for animate/transition classes.
  useAnimatedStyle,
  useAnimatedProps,
  useDerivedValue,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedGestureHandler,
  useAnimatedRef,
  // Animated components
  createAnimatedComponent,
  View,
  ScrollView,
  Image,
  Text,
  FlatList,
  // Configuration / introspection
  isReanimated3,
  isConfigured,
  getViewProp,
  enableLayoutAnimations,
  configureReanimatedLogger,
  // Layout animations
  LayoutAnimationConfig,
  FadeIn, FadeOut, SlideInRight, SlideOutRight, SlideInLeft, SlideOutLeft,
  ZoomIn, ZoomOut, Layout, LinearTransition,
}
