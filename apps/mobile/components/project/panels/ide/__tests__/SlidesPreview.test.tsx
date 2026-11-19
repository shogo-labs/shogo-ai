// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A frame that never reports is a dead end, and the host has to hear about it
 * from the timer — not from inside a state updater (SHO-426, QA round 1).
 *
 * React runs a `setState(current => …)` updater during render, so an `onError`
 * called from in there made the parent's update a render-phase update: the
 * `/f/` page logged "Cannot update a component (`FileViewer`) while rendering
 * a different component" and the fallback arrived a render late. This asserts
 * the callback fires once, after the cap, from the timer itself.
 */

import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render, waitFor } from "@testing-library/react"
import React, { useState } from "react"
import * as lucideStub from "../../../../../test/stubs/lucide-react-native"

const realProtocol = await import("../slides-viewer-protocol")

mock.module("lucide-react-native", () => lucideStub)
mock.module("../slides-viewer-protocol", () => ({
  ...realProtocol,
  // A 30 ms cap keeps the test quick; the deck never arrives.
  SLIDES_RENDER_TIMEOUT_MS: 30,
  fetchSlidesBytes: () => new Promise<ArrayBuffer>(() => {}),
}))

const { SlidesPreview } = await import("../SlidesPreview")

afterEach(() => cleanup())

describe("SlidesPreview render timeout", () => {
  test("reports the dead frame to the host once, outside the state updater", async () => {
    const errors: string[] = []
    const consoleError = mock((..._args: unknown[]) => {})
    const originalError = console.error
    console.error = consoleError as never
    try {
      // A host that swaps to its fallback on error, like `FileViewer` does.
      function Host() {
        const [failed, setFailed] = useState<string | null>(null)
        if (failed) return <div data-testid="fallback">{failed}</div>
        return (
          <SlidesPreview
            url="http://localhost:8002/api/f/deck"
            name="deck.pptx"
            path="deck.pptx"
            onError={(message) => {
              errors.push(message)
              setFailed(message)
            }}
          />
        )
      }

      const { getByTestId } = render(<Host />)

      await waitFor(() => expect(errors).toHaveLength(1), { timeout: 2000 })
      expect(errors[0]).toBe("Could not render deck.pptx within 0.03s.")
      expect(getByTestId("fallback").textContent).toBe(errors[0])

      const renderPhaseWarning = consoleError.mock.calls.find((call) =>
        String(call[0]).includes("Cannot update a component"),
      )
      expect(renderPhaseWarning).toBeUndefined()
    } finally {
      console.error = originalError
    }
  })
})
