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

// NOTE — Hooks like `useSharedValue` / `useAnimatedStyle` are intentionally
// OMITTED from the export list (and excluded from `module.exports` below).
// Several libraries in the dep tree (notably `react-native-gesture-handler`
// in `reanimatedWrapper.js`) probe for Reanimated using
//
//     if (!Reanimated?.useSharedValue) Reanimated = undefined
//
// and switch to a pure-JS fallback path when the hook is missing. We want
// that fallback: it routes gestures through the JS bridge instead of the
// (non-existent) worklets runtime, and behaves correctly without the
// native binding. Adding `useSharedValue` to the stub would have those
// libraries try to coordinate gesture state via reanimated and crash.

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
  // Hooks intentionally omitted — see comment above the (removed)
  // `useSharedValue` definition. Libraries that probe for these
  // names fall back to non-Reanimated code paths.
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
