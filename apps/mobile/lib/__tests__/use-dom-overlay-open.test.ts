// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { hasVisibleOverlay, useDomOverlayOpen } from '../use-dom-overlay-open'

// happy-dom has no layout engine, so getClientRects() is empty. Give every
// element a rect unless it opts out via data-no-layout.
const proto = (globalThis as any).HTMLElement.prototype
const originalGetClientRects = proto.getClientRects
proto.getClientRects = function () {
  return this.hasAttribute('data-no-layout') ? [] : [{ width: 10, height: 10 }]
}

function mount(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  return host
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

// Restore after the file's tests (bun runs files in isolation, but be tidy).
process.on('exit', () => {
  proto.getClientRects = originalGetClientRects
})

describe('hasVisibleOverlay', () => {
  test('false on an empty page', () => {
    expect(hasVisibleOverlay(document.body)).toBe(false)
  })

  test.each([
    '<div role="dialog"></div>',
    '<div role="alertdialog"></div>',
    '<div aria-modal="true"></div>',
    '<div role="menu"></div>',
    '<div data-suppress-native-preview="true"></div>',
  ])('detects %s', (html) => {
    mount(html)
    expect(hasVisibleOverlay(document.body)).toBe(true)
  })

  test('ignores overlays with no layout box or inside a hidden ancestor', () => {
    mount('<div role="dialog" data-no-layout></div>')
    mount('<div hidden><div role="dialog"></div></div>')
    expect(hasVisibleOverlay(document.body)).toBe(false)
  })

  test('ignores overlays inside the excluded subtree', () => {
    const host = mount('<div role="menu"></div>')
    expect(hasVisibleOverlay(document.body, host)).toBe(false)
  })
})

describe('useDomOverlayOpen', () => {
  test('goes true when a dialog is added and false when it is removed', async () => {
    const { result } = renderHook(() => useDomOverlayOpen())
    expect(result.current).toBe(false)

    let host!: HTMLElement
    act(() => {
      host = mount('<div role="dialog"></div>')
    })
    await waitFor(() => expect(result.current).toBe(true))

    act(() => {
      host.remove()
    })
    await waitFor(() => expect(result.current).toBe(false))
  })

  test('goes false when the dialog is hidden via the hidden attribute', async () => {
    let host!: HTMLElement
    act(() => {
      host = mount('<div role="dialog"></div>')
    })
    const { result } = renderHook(() => useDomOverlayOpen())
    expect(result.current).toBe(true)

    act(() => {
      host.setAttribute('hidden', '')
    })
    await waitFor(() => expect(result.current).toBe(false))
  })
})
