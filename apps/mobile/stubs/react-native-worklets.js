// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// react-native-worklets NoOp shim
// ===============================
//
// Companion to `react-native-reanimated.js` in this directory. See that
// file's banner for the full rationale — TL;DR: this build ships without
// the Worklets native pod (autolinking exclude + old-arch only), but the
// `react-native-worklets/plugin` Babel transform still autoworkletizes
// callbacks on gestures and animation primitives and stamps imports of
// `react-native-worklets` into the bundle. With the native binding
// missing, those imports resolved to `undefined` in production and any
// follow-on call (e.g. `createSerializable`) crashed the renderer at
// first render.
//
// This shim exports JS-only no-ops for every entry point we've observed
// css-interop, gesture-handler's worklet-autoworkletization, and the
// reanimated stub in this same folder to require. The functional impact
// is "worklet code runs on the JS thread synchronously" — not as smooth
// visually for genuine animation code paths, but the codebase only uses
// worklets transitively (no `'worklet'` directives in our own source).
//
// Wired up through `metro.config.js`'s alias map; making sure the
// require resolves to a real module is what prevents the
// "Cannot read property 'makeMutable' of undefined" crash.

function identityWorklet(fn) {
  if (typeof fn === 'function') {
    try { fn.__workletHash = 1 } catch (_) {}
    fn.__worklet = true
  }
  return fn
}

function createSerializable(value) {
  return value
}

function makeShareable(value) {
  return value
}

function makeShareableCloneRecursive(value) {
  return value
}

function runOnJS(fn) {
  return function () {
    try { return typeof fn === 'function' ? fn.apply(null, arguments) : undefined }
    catch (_) {}
  }
}

function runOnUI(fn) {
  return function () {
    try { return typeof fn === 'function' ? fn.apply(null, arguments) : undefined }
    catch (_) {}
  }
}

function executeOnUIRuntimeSync(fn) {
  try { return typeof fn === 'function' ? fn() : undefined }
  catch (_) { return undefined }
}

function scheduleOnUI(fn) {
  try { typeof fn === 'function' && fn() }
  catch (_) {}
}

function isWorkletFunction() { return false }

const WorkletsModule = {
  installValueUnpacker: function () {},
  createSerializable: createSerializable,
  scheduleOnUI: scheduleOnUI,
  executeOnUIRuntimeSync: executeOnUIRuntimeSync,
}

const SHOULD_BE_USE_WEB = false

module.exports = {
  __esModule: true,
  default: WorkletsModule,
  WorkletsModule,
  worklet: identityWorklet,
  createSerializable,
  makeShareable,
  makeShareableCloneRecursive,
  runOnJS,
  runOnUI,
  executeOnUIRuntimeSync,
  scheduleOnUI,
  isWorkletFunction,
  SHOULD_BE_USE_WEB,
}
