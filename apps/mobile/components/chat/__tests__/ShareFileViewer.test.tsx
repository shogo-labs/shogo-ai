// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A dead link says what went wrong in the viewer: the API's `code`, in words.
 * It never shows the user raw JSON, and it never navigates anywhere (SHO-80).
 */

import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render, waitFor } from "@testing-library/react"
import React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "web", select: (options: Record<string, unknown>) => options.web },
    useWindowDimensions: () => ({ width: 900, height: 700, scale: 1, fontScale: 1 }),
  }),
)
const Icon = () => null
mock.module("lucide-react-native", () => ({ Download: Icon, RotateCcw: Icon, X: Icon }))
mock.module("../FileTypeIcon", () => ({ FileTypeIcon: Icon }))

const { ShareFileView } = await import("../ShareFileViewer")

const target = { kind: "share" as const, href: "/api/f/signed-token", name: "q4-report.pdf" }
const originalFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

function respondWith(body: unknown, init: ResponseInit) {
  globalThis.fetch = mock(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), init),
  ) as unknown as typeof fetch
}

describe("a file the API refuses", () => {
  test("shows the API code in words, not its JSON", async () => {
    respondWith({ error: { code: "expired", message: "This download link has expired" } }, {
      status: 404,
      headers: { "content-type": "application/json" },
    })

    render(<ShareFileView target={target} onClose={() => {}} />)

    const error = await waitFor(() => {
      const node = document.querySelector('[data-rn-shim="share-file-error"]')
      expect(node).toBeTruthy()
      return node!
    })
    expect(error.textContent).toBe("Link expired — ask for a new one")
    expect(error.textContent).not.toContain("{")
    expect(document.body.textContent).toContain("expired")
    expect(document.querySelector('[data-rn-shim="share-file-download"]')).toBeNull()
  })

  test("says so when the file is gone, and offers a retry", async () => {
    respondWith({ error: { code: "file_not_found", message: "File not found" } }, { status: 404 })

    render(<ShareFileView target={target} />)

    const error = await waitFor(() => {
      const node = document.querySelector('[data-rn-shim="share-file-error"]')
      expect(node).toBeTruthy()
      return node!
    })
    expect(error.textContent).toBe("File not found")
    expect(document.querySelector('[data-rn-shim="share-file-retry"]')).toBeTruthy()
  })
})

describe("a file the API serves", () => {
  test("renders the text and offers a download", async () => {
    globalThis.fetch = mock(async () =>
      new Response("hello from the workspace", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    ) as unknown as typeof fetch

    render(<ShareFileView target={{ ...target, name: "notes.txt", href: "/api/f/abc" }} />)

    await waitFor(() => expect(document.body.textContent).toContain("hello from the workspace"))
    expect(document.querySelector('[data-rn-shim="share-file-download"]')).toBeTruthy()
  })
})
