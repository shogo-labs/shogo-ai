// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A frame that says `ready` late must still get the deck (SHO-383).
 *
 * The viewer page posts `ready` once, at the end of its own inline script, and
 * the host answers with the bytes. The host also posts once on a 250 ms timer,
 * for a frame that was already ready before the bytes arrived (a cached page
 * never repeats `ready`).
 *
 * That blind post used to latch the "already sent" flag. On a loaded machine
 * the 2.4 MB page takes longer than 250 ms to parse, so the blind post landed
 * before the page had registered its listener, was dropped, and the real
 * `ready` that followed was ignored because the flag was already set. The frame
 * then never reported `rendered` and the host showed "Could not render … within
 * Ns" for a deck that was fine. This is the regression: a `ready` that arrives
 * after the blind post must still send the deck.
 */

import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render, waitFor } from "@testing-library/react"
import React from "react"
import * as lucideStub from "../../../../../test/stubs/lucide-react-native"

const realProtocol = await import("../slides-viewer-protocol")

mock.module("lucide-react-native", () => lucideStub)
mock.module("../slides-viewer-protocol", () => ({
  ...realProtocol,
  // The deck arrives at once; the frame is the slow half.
  fetchSlidesBytes: () => Promise.resolve(new ArrayBuffer(8)),
  // Long enough that the render cap cannot be what ends this test.
  SLIDES_RENDER_TIMEOUT_MS: 60_000,
}))

const { SlidesPreview } = await import("../SlidesPreview")

afterEach(() => cleanup())

describe("SlidesPreview ready handshake", () => {
  test("a ready that arrives after the blind post still sends the deck", async () => {
    const { container } = render(
      <SlidesPreview url="http://localhost:8002/api/f/deck" name="deck.pptx" path="deck.pptx" />,
    )

    const iframe = container.querySelector("iframe") as HTMLIFrameElement
    expect(iframe).toBeTruthy()

    // Stand in for the frame's window: it records what the host posts in, and
    // it detaches a transferred buffer the way a real `postMessage` does. A
    // stub that ignores the transfer list hides the bug this test is for: the
    // blind post spends the deck's only buffer, so the `ready` that follows has
    // nothing left to send.
    const posted: unknown[] = []
    const frameWindow = {
      postMessage: (message: unknown, _target?: string, transfer?: Transferable[]) => {
        for (const item of transfer ?? []) {
          if (item instanceof ArrayBuffer) {
            if (item.byteLength === 0) throw new DOMException("detached", "DataCloneError")
            structuredClone(item, { transfer: [item] })
          }
        }
        posted.push(message)
      },
    }
    Object.defineProperty(iframe, "contentWindow", { value: frameWindow, configurable: true })

    // The blind post fires at 250 ms. Let it happen, and let it be lost: the
    // frame has no listener yet, which is exactly the loaded-machine case.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(posted).toHaveLength(1)

    // Now the page finishes parsing and says it is listening.
    window.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "ready" }),
        source: frameWindow as unknown as MessageEventSource,
      }),
    )

    await waitFor(() => expect(posted).toHaveLength(2), { timeout: 2_000 })
    expect((posted[1] as { type?: string }).type).toBe("load")
  })
})
