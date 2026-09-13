// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `CanvasIframe` must not depend *solely* on the bridge's `canvas-ready`
 * postMessage to dismiss its "Loading preview…" overlay.
 *
 * Regression (Sept 2026, Desktop): the packaged agent-runtime served the
 * `canvas-bridge.js missing` stub, so no `canvas-ready` was ever posted.
 * The iframe had fully loaded the app (the same URL worked in a browser
 * tab), but the overlay sat on top of it with `opacity: 0` forever. The
 * iframe's own `load` event is the fallback readiness signal: once the
 * document has loaded and the handshake still hasn't arrived within a
 * short grace, reveal the document anyway.
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

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

const { CanvasWebView, CANVAS_READY_GRACE_AFTER_LOAD_MS } = await import('../CanvasWebView')

// happy-dom would otherwise really fetch the iframe `src` (and fire its own
// `load`/`error` events on a schedule we don't control). The `load` event is
// the signal under test, so we drive it by hand with `fireEvent.load`. With
// loading disabled happy-dom logs one "Iframe page loading is disabled"
// DOMException per mount via its virtual console — expected noise, not a
// failure.
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

afterEach(() => {
  cleanup()
})

describe('CanvasIframe loading overlay', () => {
  test('starts hidden behind the "Loading preview…" overlay', () => {
    renderCanvas()
    expect(screen.getByText('Loading preview…')).toBeInTheDocument()
    expect(getIframe().style.opacity).toBe('0')
    expect(getIframe().src.startsWith(`${CANVAS_BASE_URL}/`)).toBe(true)
  })

  test('canvas-ready from the bridge dismisses the overlay immediately', async () => {
    renderCanvas()
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'canvas-ready' } }))
    })
    expect(screen.queryByText('Loading preview…')).not.toBeInTheDocument()
    expect(getIframe().style.opacity).toBe('1')
  })

  test('iframe `load` without canvas-ready reveals the document after the grace period (missing bridge)', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      renderCanvas()
      const started = Date.now()
      fireEvent.load(getIframe())
      // Still waiting right after load — the grace gives a slow bridge a chance.
      expect(screen.getByText('Loading preview…')).toBeInTheDocument()

      await waitFor(
        () => expect(screen.queryByText('Loading preview…')).not.toBeInTheDocument(),
        { timeout: CANVAS_READY_GRACE_AFTER_LOAD_MS + 2_000 },
      )
      expect(Date.now() - started).toBeGreaterThanOrEqual(CANVAS_READY_GRACE_AFTER_LOAD_MS - 50)
      expect(getIframe().style.opacity).toBe('1')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('canvas-ready never arrived')
    } finally {
      warn.mockRestore()
    }
  })

  test('canvas-ready arriving inside the grace window cancels the fallback (no warning)', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      renderCanvas()
      fireEvent.load(getIframe())
      await act(async () => {
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'canvas-ready' } }))
      })
      expect(screen.queryByText('Loading preview…')).not.toBeInTheDocument()
      // Let the (cancelled) grace timer's deadline pass and make sure it
      // didn't fire.
      await new Promise((r) => setTimeout(r, CANVAS_READY_GRACE_AFTER_LOAD_MS + 200))
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
