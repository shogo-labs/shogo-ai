// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Testing Library preload. Runs after `dom-setup.ts` (see bunfig.toml).
 *
 * Three jobs:
 *   1. Stub `react-native`. Bun can't parse the Flow types in
 *      `react-native/index.js`, and `Bun.plugin onResolve` doesn't fire
 *      for runtime imports (oven-sh/bun#21380). The components we test
 *      under happy-dom are web-mode, so `Platform.OS === 'web'` is the
 *      only RN surface they need. We provide a minimal shim covering
 *      `Platform`, `StyleSheet`, and the primitive components used in
 *      the IDE drawer code path.
 *   2. Extend Bun's `expect` with jest-dom matchers.
 *   3. Register an RTL `cleanup()` hook so `render()` results don't leak
 *      between tests.
 */
import { afterEach, expect, mock } from 'bun:test'
import * as matchers from '@testing-library/jest-dom/matchers'
import { cleanup } from '@testing-library/react'
import { createElement, forwardRef } from 'react'

mock.module('react-native', () => {
  // Minimal RN shim. Components return their children inside a div so
  // happy-dom can render them; non-trivial RN behavior (Animated,
  // gesture handlers, …) is intentionally absent — components that need
  // those should be tested via extracted pure logic, not under RTL.
  const passthroughHost = (tag: string) =>
    forwardRef(function HostShim(
      props: Record<string, unknown>,
      ref: React.Ref<HTMLDivElement>,
    ) {
      const { children, style, ...rest } = props as {
        children?: React.ReactNode
        style?: unknown
      }
      return createElement(
        tag,
        { ...rest, ref, 'data-rn-shim': props['testID'] ?? undefined },
        children,
      )
    })

  return {
    Platform: {
      OS: 'web',
      Version: 0,
      isPad: false,
      isTV: false,
      select: <T,>(spec: { web?: T; default?: T }) =>
        spec.web !== undefined ? spec.web : spec.default,
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
      Value: class {
        setValue() {}
        addListener() { return 'id' }
        removeListener() {}
        removeAllListeners() {}
        interpolate() { return this }
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
      addListener() { return { remove: () => {} } }
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
    // `react-native-svg` (transitive dep of `lucide-react-native`)
    // destructures `Touchable.Mixin` at module load. Provide an empty
    // mixin so its module evaluation doesn't throw.
    Touchable: {
      Mixin: {},
      TOUCH_TARGET_DEBUG: false,
      renderDebugView: () => null,
    },
    StatusBar: passthroughHost('div'),
    // Misc named exports referenced by Expo / RN-svg / lucide
    // transitively at module-load time.
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
    UIIManager: {},
  }
})

// `lucide-react-native` pulls in `react-native-svg`, which in turn does
// real native module resolution that we can't satisfy in happy-dom. The
// IDE Terminal only uses these icons for visual decoration, so swap
// every export for a tiny passthrough. Names are enumerated in the stub
// so ESM static `import { X, Y } from 'lucide-react-native'` resolves.
import * as lucideStub from './stubs/lucide-react-native'
mock.module('lucide-react-native', () => lucideStub)

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
