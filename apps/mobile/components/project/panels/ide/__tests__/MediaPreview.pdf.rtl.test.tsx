// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-224: Chrome will not render a PDF inside a sandboxed iframe, so the
 * preview frames nothing but a `blob:` URL typed `application/pdf`. These
 * tests pin the three things that make that safe and working: no `sandbox`
 * attribute, a blob `src` even when the caller handed over an http URL, and
 * object-URL ownership (ours is revoked on unmount, a caller's never is).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { PdfPreview } from "../MediaPreview"

const realCreateObjectURL = URL.createObjectURL
const realRevokeObjectURL = URL.revokeObjectURL
const realFetch = globalThis.fetch

let created: Blob[] = []
let revoked: string[] = []
let minted = 0

/** happy-dom cannot navigate to a `blob:` frame and logs a load failure for
 *  every render; the preview's own `src` is what these tests assert. */
const happyDom = (globalThis as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean } } })
  .happyDOM
const consoleError = console.error
let iframeLoadingWasDisabled = false

beforeEach(() => {
  if (happyDom) {
    iframeLoadingWasDisabled = happyDom.settings.disableIframePageLoading
    happyDom.settings.disableIframePageLoading = true
  }
  console.error = (...args: unknown[]) => {
    if (String(args[0] ?? "").toLowerCase().includes("iframe page")) return
    consoleError(...args)
  }
  created = []
  revoked = []
  minted = 0
  URL.createObjectURL = ((value: Blob) => {
    created.push(value)
    minted += 1
    return `blob:http://localhost/minted-${minted}`
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = ((value: string) => {
    revoked.push(value)
  }) as typeof URL.revokeObjectURL
})

afterEach(() => {
  cleanup()
  console.error = consoleError
  if (happyDom) happyDom.settings.disableIframePageLoading = iframeLoadingWasDisabled
  URL.createObjectURL = realCreateObjectURL
  URL.revokeObjectURL = realRevokeObjectURL
  globalThis.fetch = realFetch
})

function serveBytes(bytes: Blob, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return { ok: status >= 200 && status < 300, status, blob: async () => bytes } as unknown as Response
  }) as unknown as typeof fetch
  return calls
}

describe("PdfPreview", () => {
  test("an http URL becomes an unsandboxed iframe over a typed blob", async () => {
    const calls = serveBytes(new Blob(["<h1>not a pdf</h1>"], { type: "text/html" }))

    render(<PdfPreview url="https://api.example.com/api/files/q3" name="q3.pdf" path="q3.pdf" />)

    const frame = await waitFor(() => screen.getByTestId("pdf-preview-frame"))
    expect(frame.hasAttribute("sandbox")).toBe(false)
    expect(frame.getAttribute("src")).toBe("blob:http://localhost/minted-1")
    expect(calls).toEqual([
      { url: "https://api.example.com/api/files/q3", init: { credentials: "include" } },
    ])
    // The bytes the server called HTML leave as a PDF document, so the frame
    // has nothing it could execute.
    expect(created).toHaveLength(1)
    expect(created[0].type).toBe("application/pdf")
  })

  test("the object URL it minted is revoked on unmount", async () => {
    serveBytes(new Blob(["%PDF-1.7"], { type: "application/pdf" }))

    const view = render(<PdfPreview url="https://api.example.com/api/files/q3" name="q3.pdf" path="q3.pdf" />)
    await waitFor(() => screen.getByTestId("pdf-preview-frame"))
    expect(revoked).toEqual([])

    view.unmount()
    expect(revoked).toEqual(["blob:http://localhost/minted-1"])
  })

  test("a caller's blob URL is framed as-is and never revoked by the preview", async () => {
    const calls = serveBytes(new Blob(["must not be fetched"]))

    const view = render(
      <PdfPreview url="blob:http://localhost/caller-owned" name="q3.pdf" path="q3.pdf" />,
    )

    const frame = await waitFor(() => screen.getByTestId("pdf-preview-frame"))
    expect(frame.getAttribute("src")).toBe("blob:http://localhost/caller-owned")
    expect(frame.hasAttribute("sandbox")).toBe(false)
    expect(calls).toHaveLength(0)

    view.unmount()
    expect(revoked).toEqual([])
  })

  test("a non-2xx answer shows the status and Open in new tab, never a blank frame", async () => {
    serveBytes(new Blob([]), 503)

    render(<PdfPreview url="https://api.example.com/api/files/q3" name="q3.pdf" path="q3.pdf" />)

    await waitFor(() => expect(screen.getByText("Could not open q3.pdf · HTTP 503")).toBeTruthy())
    expect(screen.getByText("Open in new tab")).toBeTruthy()
    expect(screen.queryByTestId("pdf-preview-frame")).toBeNull()
  })
})
