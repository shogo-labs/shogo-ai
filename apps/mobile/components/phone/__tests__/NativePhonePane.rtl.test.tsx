// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, mock, test } from 'bun:test'
import { render } from '@testing-library/react'
import { createReactNativeMock } from '../../../test/react-native-mock'

mock.module('react-native', () => createReactNativeMock())

const { NativePhonePane } = await import('../NativePhonePane')

describe('NativePhonePane', () => {
  test('pins the pane to the viewport width on phone layouts', () => {
    const { container } = render(
      <NativePhonePane pageWidth={390} comfortable testID="phone-pane">
        <span>Phone</span>
      </NativePhonePane>,
    )

    const root = container.querySelector('[data-rn-shim="phone-pane"]')
    expect(root).toBeTruthy()
    expect((root as HTMLElement).style.width).toBe('390px')
  })

  test('leaves the web pane width to its parent layout', () => {
    const { container } = render(
      <NativePhonePane pageWidth={390} comfortable={false} testID="web-pane">
        <span>Web</span>
      </NativePhonePane>,
    )

    const root = container.querySelector('[data-rn-shim="web-pane"]')
    expect(root).toBeTruthy()
    expect((root as HTMLElement).style.width).toBe('')
  })
})
