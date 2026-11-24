// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA round 2 regression — SHO-544: the themed spinner was still blue on web.
 *
 * `Spinner` painted itself with a `text-*` class and relied on cssInterop's
 * `nativeStyleToProp`, which is **native-only**. On web the className becomes a
 * `$$css` marker on `props.style` and react-native-web never sees a `color`, so
 * every circle kept RNW's `#1976D2` default — the exact bug the card is about.
 *
 * The source-scan guard cannot catch that (the code looks right), and 7276
 * passing tests did not either, so this spec renders the primitive and asks the
 * ActivityIndicator what colour it was actually handed.
 */
import { describe, expect, test } from 'bun:test'
import { render } from '@testing-library/react'
import { createElement } from 'react'

import { Spinner, type SpinnerTone } from '@shogo/shared-ui/spinner'

/** The colour the platform actually renders with, as RNW would receive it. */
function spinnerColor(element: HTMLElement): string | null {
  return element.getAttribute('color')
}

describe('Spinner paints a real colour on web (SHO-544)', () => {
  test('the default tone is the accent, not react-native-web blue', () => {
    const { container } = render(createElement(Spinner))
    const colour = spinnerColor(container.firstElementChild as HTMLElement)
    expect(colour).toBe('rgb(var(--color-primary))')
    expect(colour).not.toBe('#1976D2')
  })

  test('every tone resolves to its own theme var', () => {
    const expected: Record<SpinnerTone, string> = {
      primary: 'rgb(var(--color-primary))',
      onPrimary: 'rgb(var(--color-primary-foreground))',
      muted: 'rgb(var(--color-muted-foreground))',
      destructive: 'rgb(var(--color-destructive))',
      onDestructive: 'rgb(var(--color-destructive-foreground))',
      onBrand: 'rgb(255, 255, 255)',
    }
    for (const [tone, colour] of Object.entries(expected)) {
      const { container, unmount } = render(createElement(Spinner, { tone: tone as SpinnerTone }))
      expect(spinnerColor(container.firstElementChild as HTMLElement)).toBe(colour)
      unmount()
    }
  })

  test('the escape hatch still wins for a genuinely external colour', () => {
    const { container } = render(createElement(Spinner, { color: 'rgb(1, 2, 3)' }))
    expect(spinnerColor(container.firstElementChild as HTMLElement)).toBe('rgb(1, 2, 3)')
  })

  test('the tone class survives, so native keeps resolving through cssInterop', () => {
    const { container } = render(createElement(Spinner, { tone: 'onPrimary' }))
    const html = (container.firstElementChild as HTMLElement).outerHTML
    expect(html).toContain('text-primary-foreground')
  })
})
