// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Dev-client compatibility shim.
//
// Expo Modules Core 3 imports `./sweet/NativeJSLogger` from
// `setUpJsLogger.fx.ts` in development and expects the native module to
// expose `addListener`. On this local simulator build the optional native
// module exists but doesn't provide that event-emitter method, which aborts
// module evaluation before AppRegistry registers the app:
//
//   NativeJSLogger.default.addListener is not a function
//
// Production bundles don't execute this path (`__DEV__` only), but simulator
// testing does. Metro aliases the NativeJSLogger import to this no-op emitter
// so the dev logger setup can't break app launch.

const logger = {
  addListener() {
    return { remove() {} }
  },
  removeListeners() {},
}

module.exports = {
  __esModule: true,
  default: logger,
  ...logger,
}
