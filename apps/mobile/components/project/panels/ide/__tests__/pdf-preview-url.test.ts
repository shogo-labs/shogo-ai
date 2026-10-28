// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The PDF iframe cannot be sandboxed (Chromium refuses its PDF viewer in any
 * sandboxed frame — SHO-224), so the helper is the only thing keeping a live
 * document out of it: a `blob:` URL passes through, anything else is fetched
 * and re-wrapped as `application/pdf`.
 */
import { afterEach, describe, expect, test } from "bun:test"
import {
  PdfPreviewFetchError,
  pdfPreviewErrorText,
  resolvePdfPreviewUrl,
} from "../pdf-preview-url"

const realCreateObjectURL = URL.createObjectURL
const realRevokeObjectURL = URL.revokeObjectURL
let created: Blob[] = []

function spyOnObjectUrls() {
  created = []
  URL.createObjectURL = ((value: Blob) => {
    created.push(value)
    return realCreateObjectURL.call(URL, value)
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = ((value: string) => realRevokeObjectURL.call(URL, value)) as typeof URL.revokeObjectURL
}

afterEach(() => {
  URL.createObjectURL = realCreateObjectURL
  URL.revokeObjectURL = realRevokeObjectURL
})

function fakeResponse(body: Blob, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    blob: async () => body,
  } as unknown as Response
}

describe("resolvePdfPreviewUrl", () => {
  test("a caller's blob URL is used as-is, and never fetched", async () => {
    const calls: unknown[][] = []
    const fetchImpl = (async (...args: unknown[]) => {
      calls.push(args)
      throw new Error("a blob URL must not be fetched")
    }) as unknown as typeof fetch

    const source = await resolvePdfPreviewUrl("blob:http://localhost/9f3c", fetchImpl)

    expect(source).toEqual({ url: "blob:http://localhost/9f3c", owned: false })
    expect(calls).toHaveLength(0)
  })

  test("an http URL is fetched with credentials and re-typed application/pdf", async () => {
    spyOnObjectUrls()
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      // The server says HTML: framing these bytes unframed would run them.
      return fakeResponse(new Blob(["<script>alert(1)</script>"], { type: "text/html" }))
    }) as unknown as typeof fetch

    const source = await resolvePdfPreviewUrl("https://api.example.com/api/files/q3", fetchImpl)

    expect(calls).toEqual([
      { url: "https://api.example.com/api/files/q3", init: { credentials: "include" } },
    ])
    expect(source.owned).toBe(true)
    expect(source.url.startsWith("blob:")).toBe(true)
    expect(created).toHaveLength(1)
    expect(created[0].type).toBe("application/pdf")
  })

  test("a non-2xx answer throws with the status and mints no object URL", async () => {
    spyOnObjectUrls()
    const fetchImpl = (async () =>
      fakeResponse(new Blob([]), { ok: false, status: 404 })) as unknown as typeof fetch

    const error = await resolvePdfPreviewUrl("https://api.example.com/api/files/gone", fetchImpl).catch(
      (cause) => cause,
    )

    expect(error).toBeInstanceOf(PdfPreviewFetchError)
    expect((error as PdfPreviewFetchError).status).toBe(404)
    expect(created).toHaveLength(0)
  })
})

describe("pdfPreviewErrorText", () => {
  test("names the file and the status", () => {
    expect(pdfPreviewErrorText(new PdfPreviewFetchError(404), "q3.pdf")).toBe(
      "Could not open q3.pdf · HTTP 404",
    )
    expect(pdfPreviewErrorText(new PdfPreviewFetchError(503), "q3.pdf")).toBe(
      "Could not open q3.pdf · HTTP 503",
    )
  })

  test("a network failure still names the file, without inventing a status", () => {
    expect(pdfPreviewErrorText(new TypeError("Failed to fetch"), "q3.pdf")).toBe("Could not open q3.pdf")
  })
})
