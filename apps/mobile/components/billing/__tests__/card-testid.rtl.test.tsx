// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `Card` must forward `testID` to the host element (SHO-451 QA round 1).
 *
 * The billing redesign put `testID="billing-summary"` and
 * `testID="plan-comparison"` on `Card`, but `CardProps` had no `testID` and
 * `Card` destructured only `className` and `children`, so the attribute was
 * silently dropped. react-native-web only emits `data-testid` for a `testID`
 * that actually lands on a host component, so neither attribute reached the
 * DOM: the staging e2e suite failed on its first `getByTestId`, and `tsc`
 * reported TS2322 at both call sites.
 *
 * `billing-redesign.rtl.test.tsx` could not catch it — it mocks
 * `@shogo/shared-ui/primitives` with a passthrough `Card`, so the real
 * primitive never ran. This file deliberately does NOT mock the primitives: it
 * renders the real `Card` and asserts the attribute reaches the host element.
 *
 * Run: bun test apps/mobile/components/billing/__tests__/card-testid.rtl.test.tsx
 */

import { describe, expect, mock, test } from 'bun:test'
import { createRequire } from 'node:module'
import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

// Map `testID` to `data-testid` the way react-native-web does, so the assertion
// below is about `Card` forwarding the prop — not about the shim's naming.
const rnMock = createReactNativeMock({
  View: ({ testID, children, ...rest }: any) =>
    createElement('div', { ...rest, 'data-testid': testID }, children),
  Text: ({ testID, children, ...rest }: any) =>
    createElement('span', { ...rest, 'data-testid': testID }, children),
} as any)

mock.module('react-native', () => rnMock)

// `packages/shared-ui` resolves `react-native` to its own copy (a different
// `.bun` hash than the app's), so the bare-specifier mock above does not cover
// the import `Card` actually makes. Key the mock on that resolved file too —
// the same fix `test/testing-library.ts` applies to `lucide-react-native`.
const sharedUiRequire = createRequire(
  new URL('../../../../../packages/shared-ui/package.json', import.meta.url),
)
mock.module(sharedUiRequire.resolve('react-native'), () => rnMock)

const { Card, CardContent } = await import('@shogo/shared-ui/primitives')

describe('Card forwards testID', () => {
  test('the testID reaches the host element', () => {
    render(
      createElement(Card, {
        testID: 'billing-summary',
        children: createElement(CardContent, { children: 'You are on Business Plan' }),
      }),
    )

    // The exact query the staging e2e suite makes.
    expect(screen.getByTestId('billing-summary')).toBeTruthy()
    expect(screen.getByTestId('billing-summary').textContent).toContain('Business Plan')
  })

  test('a second card keeps its own testID', () => {
    render(
      createElement(Card, {
        testID: 'plan-comparison',
        children: createElement(CardContent, { children: 'Plans' }),
      }),
    )

    expect(screen.getByTestId('plan-comparison')).toBeTruthy()
  })

  test('a card without a testID still renders its children', () => {
    const { container } = render(
      createElement(Card, { children: createElement(CardContent, { children: 'no testID here' }) }),
    )

    expect(container.textContent).toContain('no testID here')
    expect(container.querySelector('[data-testid]')).toBeNull()
  })
})
