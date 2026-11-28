// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-609 QA acceptance — the registration actually applies a `className`.
 *
 * `theme-colors.guard.test.ts` only reads source text, and
 * `ShimmerLabel.color.rtl.test.tsx` renders a mocked `Animated.Text`, so
 * neither of them proves that `cssInterop(Animated.Text, …)` turns a
 * `className` into a style. If the registration were dropped, mis-keyed or
 * never loaded, both of those suites would still pass and the label would go
 * black again — exactly the failure mode the card is about.
 *
 * This suite runs the real `react-native-web` and NativeWind's real JSX
 * wrapper (the same `interopComponents` lookup the app's `nativewind` JSX
 * pragma performs), so it asks the question the others cannot: does a
 * `className` on an animated primitive survive once `lib/animated-interop` has
 * been loaded, and does an animated `opacity` still drive the frame?
 */
import { describe, expect, mock, test } from 'bun:test'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import * as ReactNativeWeb from 'react-native-web'
import { wrapJSX } from 'react-native-css-interop'

mock.module('react-native', () => ReactNativeWeb)

// Side-effect import: this is what `app/_layout.tsx` does.
await import('../../lib/animated-interop')

const jsx = wrapJSX(createElement as never) as (
  type: unknown,
  props: Record<string, unknown> | null,
  ...children: unknown[]
) => ReturnType<typeof createElement>

function html(element: Element | null): string {
  return (element as HTMLElement).outerHTML
}

describe('Animated primitives are wired into NativeWind (SHO-609)', () => {
  test('a primitive nobody registered still drops its className', () => {
    // The origin/main state for every `Animated.*` node: no interop entry, so
    // the class never becomes a style and the node renders without it.
    const { container } = render(
      jsx(ReactNativeWeb.Animated.Image, { className: 'w-4 h-4', source: { uri: 'x' } }),
    )
    expect(html(container.firstElementChild)).not.toContain('w-4')
  })

  test('the registered Animated.Text applies the muted-foreground class', () => {
    const { container } = render(
      jsx(ReactNativeWeb.Animated.Text, { className: 'text-xs text-muted-foreground' }, 'Planning'),
    )
    const markup = html(container.firstElementChild)
    expect(markup).toContain('text-muted-foreground')
    expect(markup).toContain('text-xs')
  })

  test('the registered Animated.View applies its class and keeps an animated opacity', () => {
    const opacity = new ReactNativeWeb.Animated.Value(0.25)
    const { container } = render(
      jsx(ReactNativeWeb.Animated.View, {
        className: 'w-2.5 h-2.5 rounded-full bg-white',
        style: [{ opacity }],
      }),
    )
    const element = container.firstElementChild as HTMLElement
    expect(element.className).toContain('bg-white')
    expect(element.getAttribute('style')).toContain('opacity')
  })
})
