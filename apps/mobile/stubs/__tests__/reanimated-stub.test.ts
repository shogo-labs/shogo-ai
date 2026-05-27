// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pins the shape of the `react-native-reanimated` / `react-native-worklets`
 * no-op shims that Metro aliases into the production bundle (see
 * `apps/mobile/metro.config.js` and the banners on each stub file).
 *
 * Why this exists
 * ---------------
 * The TestFlight v1.0.8 / App Review build crashed on every project entry
 * with `Cannot read property 'makeMutable' of undefined` because
 * `react-native-css-interop` (under NativeWind) does an unconditional
 * top-level destructure:
 *
 *     const { makeMutable, withTiming, withDelay, withRepeat, withSequence,
 *             Easing, cancelAnimation } =
 *       require("react-native-reanimated") as typeof import(...)
 *
 * and we ship the binary with Reanimated + Worklets autolink-excluded
 * (no native pod, no new architecture). The Metro alias points those
 * imports at our stubs instead so the destructure resolves to no-op
 * functions instead of `undefined`.
 *
 * This test locks the contract — if anyone removes a member from the
 * stub, css-interop crashes the renderer in production again. We also
 * lock the surfaces a couple of other libraries probe (`isReanimated3`
 * exists; `useSharedValue` deliberately does NOT exist so
 * gesture-handler picks its JS fallback path; etc.).
 *
 * Run: bun test apps/mobile/stubs/__tests__/reanimated-stub.test.ts
 */

import { describe, test, expect } from 'bun:test'

import * as Reanimated from '../react-native-reanimated.js'
import * as Worklets from '../react-native-worklets.js'

describe('react-native-reanimated stub', () => {
  test('exports the exact surface css-interop destructures', () => {
    // Locked by react-native-css-interop@0.2.x at
    //   src/runtime/native/native-interop.ts (lines ~556, ~701, ~741)
    const required = [
      'makeMutable',
      'withTiming',
      'withDelay',
      'withRepeat',
      'withSequence',
      'cancelAnimation',
      'Easing',
    ] as const
    for (const name of required) {
      expect(typeof (Reanimated as any)[name]).not.toBe('undefined')
    }
  })

  test('makeMutable returns a mutable value object', () => {
    const sv = (Reanimated as any).makeMutable(7)
    expect(sv.value).toBe(7)
    sv.value = 12
    expect(sv.value).toBe(12)
    expect(typeof sv.addListener).toBe('function')
    expect(typeof sv.modify).toBe('function')
  })

  test('animation primitives resolve to final value synchronously', () => {
    expect((Reanimated as any).withTiming(100)).toBe(100)
    expect((Reanimated as any).withSpring(50)).toBe(50)
    expect((Reanimated as any).withSequence('a', 'b', 'c')).toBe('c')
    expect((Reanimated as any).withDelay(500, 42)).toBe(42)
    expect((Reanimated as any).withRepeat(99)).toBe(99)
  })

  test('animation callbacks fire with finished=true', () => {
    let timingFinished: unknown = null
    ;(Reanimated as any).withTiming(0, undefined, (ok: boolean) => {
      timingFinished = ok
    })
    expect(timingFinished).toBe(true)
  })

  test('Easing functions exist and are callable', () => {
    const E = (Reanimated as any).Easing
    expect(typeof E.linear).toBe('function')
    expect(typeof E.ease).toBe('function')
    expect(typeof E.bezier).toBe('function')
    const cubic = E.bezier(0.2, 0.8, 0.2, 1)
    expect(typeof cubic).toBe('function')
    expect(cubic(0.5)).toBe(0.5)
  })

  test('useSharedValue is INTENTIONALLY missing — gesture-handler fallback', () => {
    // react-native-gesture-handler's `reanimatedWrapper.js` resets
    // `Reanimated = undefined` when `useSharedValue` isn't present, which
    // routes gestures through the pure-JS path. We must preserve that.
    expect((Reanimated as any).useSharedValue).toBeUndefined()
  })

  test('exports JS-only animated hooks required by css-interop', () => {
    // NativeWind's react-native-css-interop calls `useAnimatedStyle` when
    // rendering animate/transition classes such as `animate-spin`.
    expect(typeof (Reanimated as any).useAnimatedStyle).toBe('function')
    expect((Reanimated as any).useAnimatedStyle(() => ({ opacity: 0.5 }))).toEqual({ opacity: 0.5 })
    expect(typeof (Reanimated as any).useAnimatedProps).toBe('function')
    expect(typeof (Reanimated as any).useDerivedValue).toBe('function')
  })

  test('introspection helpers return safe negative values', () => {
    expect((Reanimated as any).isReanimated3()).toBe(false)
    expect((Reanimated as any).isConfigured()).toBe(false)
  })

  test('cancelAnimation does not throw on a shared value or unknown input', () => {
    const sv = (Reanimated as any).makeMutable(3)
    expect(() => (Reanimated as any).cancelAnimation(sv)).not.toThrow()
    expect(() => (Reanimated as any).cancelAnimation(null)).not.toThrow()
    expect(() => (Reanimated as any).cancelAnimation(undefined)).not.toThrow()
  })
})

describe('react-native-worklets stub', () => {
  test('exports the helpers reanimated 4 internals require()', () => {
    // Reanimated 4's `lib/module/core.js` does
    //   `import { createSerializable } from 'react-native-worklets'`
    // and worklet-transformed callbacks reach for `runOnJS` / `runOnUI`.
    expect(typeof (Worklets as any).createSerializable).toBe('function')
    expect(typeof (Worklets as any).runOnJS).toBe('function')
    expect(typeof (Worklets as any).runOnUI).toBe('function')
  })

  test('worklet wrappers invoke the underlying function', () => {
    let calls = 0
    const fn = () => { calls += 1 }
    ;(Worklets as any).runOnJS(fn)()
    ;(Worklets as any).runOnUI(fn)()
    expect(calls).toBe(2)
  })

  test('createSerializable is identity', () => {
    const obj = { a: 1 }
    expect((Worklets as any).createSerializable(obj)).toBe(obj)
  })

  test('isWorkletFunction always reports false (no real worklet runtime)', () => {
    expect((Worklets as any).isWorkletFunction()).toBe(false)
  })
})
