// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * NativeWind `className` → `style` for the animated primitives (SHO-609).
 *
 * `react-native-css-interop` registers `Text`, `View`, `Pressable`, … but not
 * `Animated.Text` / `Animated.View`. Those come from `createAnimatedComponent`,
 * so the JSX runtime finds no interop entry for them and drops the class
 * silently — react-native's default black text then wins wherever the class was
 * the only source of colour ("Planning next moves" on the dark theme, after
 * SHO-544 removed the grey literal it used to carry).
 *
 * One registration here covers every existing call site. The class style is
 * merged ahead of the `style` prop, so an animated `opacity` in `style` still
 * drives the frame. Imported once for its side effect from `app/_layout.tsx`,
 * the same way `lib/icon-interop` is.
 */
import { Animated } from "react-native"
import { cssInterop } from "nativewind"

cssInterop(Animated.Text, { className: "style" })
cssInterop(Animated.View, { className: "style" })

export {}
