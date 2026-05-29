// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for chat image copy/download actions.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import {
  copyImageToClipboard,
  downloadImage,
} from "../chatImageActions"

// `agentFetch` is replaced by the test preload (apps/mobile/test/testing-library.ts)
// with a façade that delegates to `globalThis.__shogoAgentFetchHandler`. Image
// actions go through `agentFetch` so the session cookie travels with the
// request, so we drive that handler here rather than stubbing global fetch.
type AgentFetchHandler = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const globalAny = globalThis as any
const originalAgentFetchHandler = globalAny.__shogoAgentFetchHandler
const originalClipboardItem = globalThis.ClipboardItem
const originalCreateObjectUrl = URL.createObjectURL
const originalRevokeObjectUrl = URL.revokeObjectURL
const originalAnchorClick = HTMLAnchorElement.prototype.click

function setAgentFetch(handler: AgentFetchHandler): void {
  globalAny.__shogoAgentFetchHandler = handler
}

function setClipboard(clipboard: Partial<Clipboard>): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: clipboard,
  })
}

beforeEach(() => {
  setClipboard({})
  setAgentFetch(async () => (
    new Response(new Blob(["png"], { type: "image/png" }), { status: 200 })
  ))
})

afterEach(() => {
  globalAny.__shogoAgentFetchHandler = originalAgentFetchHandler
  globalThis.ClipboardItem = originalClipboardItem
  URL.createObjectURL = originalCreateObjectUrl
  URL.revokeObjectURL = originalRevokeObjectUrl
  HTMLAnchorElement.prototype.click = originalAnchorClick
  setClipboard({})
  mock.restore()
})

describe("copyImageToClipboard", () => {
  test("writes an image blob fetched via the credentialed agent fetch", async () => {
    const agentFetchSpy = mock(async () => (
      new Response(new Blob(["png"], { type: "image/png" }), { status: 200 })
    ))
    setAgentFetch(agentFetchSpy as unknown as AgentFetchHandler)

    const write = mock(async () => undefined)
    setClipboard({ write } as unknown as Clipboard)

    class TestClipboardItem {
      constructor(public readonly items: Record<string, Blob | Promise<Blob>>) {}
    }
    globalThis.ClipboardItem = TestClipboardItem as unknown as typeof ClipboardItem

    await expect(copyImageToClipboard("https://api.test/agent/workspace/download/x.png", "image/png"))
      .resolves.toBe("copied")

    // Root-cause guard: image bytes must be retrieved through the
    // credential-aware agent fetch, not a bare unauthenticated fetch.
    expect(agentFetchSpy).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledTimes(1)
    const item = (write.mock.calls[0]?.[0] as TestClipboardItem[])[0]
    expect(Object.keys(item.items)).toEqual(["image/png"])
    // Electron-safety guard: the clipboard value must be a resolved Blob,
    // not a Promise (Electron's Chromium fails to write promise-valued
    // image clipboard items). `await` on a Blob yields the Blob itself.
    const value = item.items["image/png"]
    expect(value).toBeInstanceOf(Blob)
    expect(value instanceof Promise).toBe(false)
  })

  test("decodes data: URLs locally instead of fetching them", async () => {
    // Root-cause guard: routing a `data:` URL through fetch/agentFetch is
    // refused by the desktop CSP `connect-src` rule, so pasted screenshots
    // must be decoded directly without touching the network.
    const agentFetchSpy = mock(async () => (
      new Response(new Blob(["should-not-run"], { type: "image/png" }), { status: 200 })
    ))
    setAgentFetch(agentFetchSpy as unknown as AgentFetchHandler)

    const write = mock(async () => undefined)
    setClipboard({ write } as unknown as Clipboard)

    class TestClipboardItem {
      constructor(public readonly items: Record<string, Blob | Promise<Blob>>) {}
    }
    globalThis.ClipboardItem = TestClipboardItem as unknown as typeof ClipboardItem

    // 1x1 transparent PNG.
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQDFI6cVAAAAAElFTkSuQmCC"

    await expect(copyImageToClipboard(dataUrl, "image/png")).resolves.toBe("copied")

    expect(agentFetchSpy).not.toHaveBeenCalled()
    expect(write).toHaveBeenCalledTimes(1)
    const item = (write.mock.calls[0]?.[0] as TestClipboardItem[])[0]
    expect(item.items["image/png"]).toBeInstanceOf(Blob)
  })

  test("does not fall back to copying image URLs as text", async () => {
    const write = mock(async () => {
      throw new Error("clipboard image write failed")
    })
    const writeText = mock(async () => undefined)
    setClipboard({ write, writeText } as unknown as Clipboard)

    class TestClipboardItem {
      constructor(public readonly items: Record<string, Blob | Promise<Blob>>) {}
    }
    globalThis.ClipboardItem = TestClipboardItem as unknown as typeof ClipboardItem

    await expect(copyImageToClipboard("https://example.test/image.png", "image/png"))
      .resolves.toBe("failed")

    expect(write).toHaveBeenCalledTimes(1)
    expect(writeText).not.toHaveBeenCalled()
  })
})

describe("downloadImage", () => {
  test("downloads fetched image blobs with the image filename", async () => {
    let clickedAnchor: HTMLAnchorElement | null = null
    const click = mock(function (this: HTMLAnchorElement) {
      clickedAnchor = this
    })
    const createObjectURL = mock(() => "blob:download-url")
    const revokeObjectURL = mock(() => undefined)
    HTMLAnchorElement.prototype.click = click as unknown as typeof HTMLAnchorElement.prototype.click
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL

    await downloadImage("https://example.test/generated/result.png", "generated-image", "image/png")

    expect(click).toHaveBeenCalledTimes(1)
    expect(clickedAnchor?.href).toBe("blob:download-url")
    expect(clickedAnchor?.download).toBe("result.png")
    expect(document.querySelector("a")).toBeNull()
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })
})
