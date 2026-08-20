// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Testing Library preload. Runs after `dom-setup.ts` (see bunfig.toml).
 *
 * Three jobs:
 *   1. Stub `react-native`. Bun can't parse the Flow types in
 *      `react-native/index.js`, and `Bun.plugin onResolve` doesn't fire
 *      for runtime imports (oven-sh/bun#21380). The components we test
 *      under happy-dom are web-mode, so `Platform.OS === 'web'` is the
 *      only RN surface they need. `./react-native-mock` provides a
 *      comprehensive shim covering `Platform`, `StyleSheet`, and the
 *      primitive components used across the app; non-trivial RN behavior
 *      (Animated, gesture handlers, …) is intentionally absent —
 *      components that need those should be tested via extracted pure
 *      logic, not under RTL. Per-file `mock.module('react-native', ...)`
 *      overrides should build on `createReactNativeMock()` rather than
 *      replacing the module outright — see that file's header comment.
 *   2. Extend Bun's `expect` with jest-dom matchers.
 *   3. Register an RTL `cleanup()` hook so `render()` results don't leak
 *      between tests.
 */
import { afterEach, expect, mock } from 'bun:test'
import * as matchers from '@testing-library/jest-dom/matchers'
import { cleanup } from '@testing-library/react'
import { reactNativeMockBase } from './react-native-mock'

mock.module('react-native', () => reactNativeMockBase)

// `lucide-react-native` pulls in `react-native-svg`, which in turn does
// real native module resolution that we can't satisfy in happy-dom. The
// IDE Terminal only uses these icons for visual decoration, so swap
// every export for a tiny passthrough. Names are enumerated in the stub
// so ESM static `import { X, Y } from 'lucide-react-native'` resolves.
import * as lucideStub from './stubs/lucide-react-native'
import * as svgStub from './stubs/react-native-svg'
mock.module('lucide-react-native', () => lucideStub)
// Also key the mock on the resolved file. A bare specifier only matches
// importers that resolve it exactly as this preload does; anything reaching
// the same package by another route (a workspace package with its own
// node_modules link) would otherwise load the real CJS build, whose named
// exports Bun's ESM interop cannot see — surfacing as a bogus
// "Export named 'Plus' not found".
mock.module(require.resolve('lucide-react-native'), () => lucideStub)

// The real `react-native-svg` cannot be evaluated here: it imports Flow-typed
// React Native internals that Bun's parser rejects. A dozen app components
// import it directly, so an unstubbed copy failed suites that render no SVG at
// all.
mock.module('react-native-svg', () => svgStub)

// `expo-secure-store` and the better-auth Expo plugin trigger native
// module resolution at module-load time. Tests don't exercise auth, so
// stub them out to avoid pulling in `expo-modules-core` etc.
mock.module('expo-secure-store', () => ({
  getItemAsync: () => Promise.resolve(null),
  setItemAsync: () => Promise.resolve(),
  deleteItemAsync: () => Promise.resolve(),
  WHEN_UNLOCKED: 0,
  AFTER_FIRST_UNLOCK: 1,
}))
mock.module('@better-auth/expo/client', () => ({
  expoClient: () => ({}),
}))
mock.module('expo-modules-core', () => ({
  EventEmitter: class {
    addListener() { return { remove: () => {} } }
    removeAllListeners() {}
    emit() {}
  },
  NativeModulesProxy: {},
  requireNativeModule: () => ({}),
  requireOptionalNativeModule: () => null,
  requireNativeViewManager: () => null,
  registerWebModule: () => ({}),
  Platform: { OS: 'web' },
  SharedObject: class {},
  SharedRef: class {},
  CodedError: class extends Error {},
  UnavailabilityError: class extends Error {},
  NativeModule: class {
    addListener() {}
    removeListeners() {}
  },
  uuid: { v4: () => 'test-uuid' },
}))

// Replace `agent-fetch` with a global handler ref. Tests assign a
// handler via `installAgentFetchMock(handler)`. The default handler
// throws so missing setup fails loudly instead of leaking real
// requests. We resolve the module path absolutely so Bun's
// mock.module matches every relative-import variant in the SUT.
type AgentFetchHandler = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
g.__shogoAgentFetchHandler ??= async () => {
  throw new Error('agentFetch called without a test handler installed')
}
const agentFetchPath = require.resolve('../lib/agent-fetch')
mock.module(agentFetchPath, () => ({
  agentFetch: (input: RequestInfo | URL, init?: RequestInit) =>
    (g.__shogoAgentFetchHandler as AgentFetchHandler)(input, init),
}))

// `authed-event-source` transitively loads `auth-client` → `better-auth`
// which trips on `EXPO_PUBLIC_API_URL` being unset under test. The hook
// always lets callers override the EventSource constructor for tests, so
// the only thing we lose by stubbing this is the production cookie path —
// which we don't exercise here.
const authedEventSourcePath = require.resolve('../lib/authed-event-source')
mock.module(authedEventSourcePath, () => ({
  createAuthedEventSource: (url: string) => new EventSource(url),
}))

expect.extend(matchers as never)

afterEach(() => {
  cleanup()
})
