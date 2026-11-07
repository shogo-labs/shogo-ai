// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The canvas "Update available" bar must never cover the preview.
 *
 * Before SHO-357 the bridge drew a glowing pill pinned to the bottom of the
 * preview document, on top of the user's app. Now the host draws a slim bar in
 * normal layout ABOVE the preview: this suite pins the host side of that
 * contract — the iframe is told it must not draw its own bar, a rebuild event
 * raises the host bar, Refresh reloads the preview inside the iframe and
 * clears it, and × hides it.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

// The shared RN shim renders TouchableOpacity as a <button> but leaves
// `onPress` on the DOM node, where React ignores it. Map it to onClick so the
// bar's buttons are actually clickable.
mock.module('react-native', () =>
  createReactNativeMock({
    TouchableOpacity: ({ onPress, children, testID, ...props }: any) =>
      createElement('button', { ...props, 'data-testid': testID, onClick: onPress }, children),
  }),
)

// The theme context pulls in nativewind + the app theme provider; the
// component treats a missing provider as "no theme sync", which is exactly
// the surface this suite cares about.
mock.module(require.resolve('../CanvasThemeContext'), () => ({
  useCanvasThemeOptional: () => null,
}))
// auth-client transitively loads better-auth / expo; only the native
// WebView path reads it, and we render the web iframe here.
mock.module(require.resolve('../../../lib/auth-client'), () => ({
  authClient: {},
}))

const { CanvasWebView, CANVAS_HOST_UPDATE_BAR_MESSAGE } = await import('../CanvasWebView')

// happy-dom would otherwise really fetch the iframe `src` (and fire its own
// `load`/`error` events on a schedule we don't control). With loading disabled
// happy-dom also leaves `contentWindow` null, so we stub it below — the
// component posts every host message through it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(window as any).happyDOM.settings.disableIframePageLoading = true

const AGENT_URL = 'http://localhost:8002/api/projects/p1/agent-proxy'
const CANVAS_BASE_URL = 'http://preview.invalid'

function renderCanvas() {
  return render(<CanvasWebView agentUrl={AGENT_URL} canvasBaseUrl={CANVAS_BASE_URL} />)
}

function getIframe(): HTMLIFrameElement {
  return screen.getByTestId('canvas-preview-iframe') as HTMLIFrameElement
}

/** Capture what the component posts into the iframe. */
function captureIframeMessages(): unknown[] {
  const posted: unknown[] = []
  const fakeWindow = {
    postMessage: (msg: unknown) => {
      posted.push(msg)
    },
  }
  Object.defineProperty(getIframe(), 'contentWindow', {
    configurable: true,
    get: () => fakeWindow,
  })
  return posted
}

async function dispatchFromBridge(data: unknown) {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data }))
  })
}

function barVisible(): boolean {
  return screen.queryByText('Update available') !== null
}

function clickRefresh() {
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
}

afterEach(() => {
  cleanup()
})

describe('CanvasIframe update bar', () => {
  test('tells the bridge on canvas-ready that the host draws the bar', async () => {
    renderCanvas()
    const posted = captureIframeMessages()

    await dispatchFromBridge({ type: 'canvas-ready' })

    expect(CANVAS_HOST_UPDATE_BAR_MESSAGE).toEqual({ type: 'canvas-host', updateBar: true })
    expect(posted).toContainEqual(CANVAS_HOST_UPDATE_BAR_MESSAGE)
  })

  test('a canvas-update-available from the bridge raises the host bar', async () => {
    renderCanvas()
    await dispatchFromBridge({ type: 'canvas-ready' })

    expect(barVisible()).toBe(false)

    await dispatchFromBridge({ type: 'canvas-update-available' })

    expect(barVisible()).toBe(true)
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
  })

  test('Refresh reloads the preview inside the iframe and clears the bar', async () => {
    renderCanvas()
    await dispatchFromBridge({ type: 'canvas-ready' })
    await dispatchFromBridge({ type: 'canvas-update-available' })
    const posted = captureIframeMessages()

    await act(async () => {
      clickRefresh()
    })

    expect(posted).toContainEqual({ type: 'canvas-reload' })
    expect(barVisible()).toBe(false)
  })

  test('× dismisses the bar without reloading', async () => {
    renderCanvas()
    await dispatchFromBridge({ type: 'canvas-ready' })
    await dispatchFromBridge({ type: 'canvas-update-available' })
    const posted = captureIframeMessages()

    await act(async () => {
      fireEvent.click(screen.getByText('\u00d7'))
    })

    expect(posted).not.toContainEqual({ type: 'canvas-reload' })
    expect(barVisible()).toBe(false)
  })

  test('a later rebuild raises the bar again after a dismiss', async () => {
    renderCanvas()
    await dispatchFromBridge({ type: 'canvas-ready' })
    await dispatchFromBridge({ type: 'canvas-update-available' })
    await act(async () => {
      fireEvent.click(screen.getByText('\u00d7'))
    })
    expect(barVisible()).toBe(false)

    await dispatchFromBridge({ type: 'canvas-update-available' })

    expect(barVisible()).toBe(true)
  })

  test('the next canvas-ready (a reloaded document) clears a stale bar', async () => {
    renderCanvas()
    await dispatchFromBridge({ type: 'canvas-ready' })
    await dispatchFromBridge({ type: 'canvas-update-available' })
    expect(barVisible()).toBe(true)

    await dispatchFromBridge({ type: 'canvas-ready' })

    expect(barVisible()).toBe(false)
  })
})
