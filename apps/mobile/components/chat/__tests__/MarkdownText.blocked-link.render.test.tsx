// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chat must never print `[blocked]` (SHO-413).
 *
 * Streamdown runs `rehype-harden` on every body. Its default `linkBlockPolicy`
 * is `"indicator"`, which replaces a link it refuses to open with
 * `<span title="Blocked URL: …">text [blocked]</span>`. The app now asks for
 * `"text-only"`: a refused link renders as its own text and stays
 * non-clickable, and a refused image renders as its alt text.
 *
 * The pre-pass also stops writing links the hardener would refuse: `arr[0]()`
 * parses as a link with an empty target, and a link whose text contains
 * brackets (`[see [SHO-1]](plans/x.md)`) used to slip past
 * `resolveRelativeLinks` and reach the hardener as a relative path.
 */

import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, fireEvent, render } from "@testing-library/react"
import React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    useWindowDimensions: () => ({ width: 900, height: 700, scale: 1, fontScale: 1 }),
  }),
)

const { MarkdownText } = await import("../MarkdownText.web")

afterEach(cleanup)

function renderBody(body: string, props: Record<string, unknown> = {}) {
  return render(
    <MarkdownText isStreaming={false} {...props}>
      {body}
    </MarkdownText>,
  ).container
}

function expectNoBlocked(container: HTMLElement) {
  expect(container.textContent).not.toContain("[blocked]")
  expect(container.textContent).not.toContain("[Image blocked")
  expect(container.querySelector("[title^='Blocked URL']")).toBeNull()
}

describe("a link the hardener refuses", () => {
  test("renders as its plain text, not `[blocked]`", () => {
    const container = renderBody("[x](javascript:alert(1))")
    expectNoBlocked(container)
    expect(container.textContent).toBe("x")
    expect(container.querySelector("a")).toBeNull()
  })

  test("a `file:` link becomes the app's own local-file href, never `[blocked]`", () => {
    const container = renderBody("[x](file:///etc/passwd)")
    expectNoBlocked(container)
    expect(container.textContent).toBe("x")
    // SHO-302 parks the absolute path in the app's own href; the `file:` scheme
    // never reaches the browser.
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/shogo-local-file?path=%2Fetc%2Fpasswd",
    )
  })

  test("a relative target that is not a file is plain text", () => {
    const container = renderBody("[x](SHO-12)")
    expectNoBlocked(container)
    expect(container.textContent).toBe("x")
    expect(container.querySelector("a")).toBeNull()
  })

  test("a reference-style link to a relative path is plain text", () => {
    const container = renderBody("[the plan][1]\n\n[1]: plans/x.md")
    expectNoBlocked(container)
    expect(container.textContent).toContain("the plan")
    expect(container.querySelector("a")).toBeNull()
  })

  test("a blocked image shows no `[Image blocked` text", () => {
    const container = renderBody("![a shot](javascript:x)")
    expectNoBlocked(container)
    expect(container.textContent).toContain("a shot")
  })
})

describe("code that looks like a link", () => {
  test("`arr[0]()` renders exactly as typed", () => {
    const container = renderBody("Call arr[0]() first.")
    expectNoBlocked(container)
    expect(container.textContent).toBe("Call arr[0]() first.")
    expect(container.querySelector("a")).toBeNull()
  })

  test("`obj[Symbol.iterator]()` renders exactly as typed", () => {
    const container = renderBody("Use obj[Symbol.iterator]() here.")
    expectNoBlocked(container)
    expect(container.textContent).toBe("Use obj[Symbol.iterator]() here.")
    expect(container.querySelector("a")).toBeNull()
  })

  test("inside backticks and fences it is untouched", () => {
    const container = renderBody("`arr[0]()`\n\n```\nobj[Symbol.iterator]()\n```")
    expectNoBlocked(container)
    expect(container.textContent).toContain("arr[0]()")
    expect(container.textContent).toContain("obj[Symbol.iterator]()")
  })
})

describe("a link whose text contains brackets", () => {
  const BODY = "[see [SHO-1]](plans/x.md)"

  test("opens the file when the host can open files", () => {
    const opened: string[] = []
    const container = renderBody(BODY, { onFilePress: (path: string) => opened.push(path) })
    expectNoBlocked(container)
    const link = container.querySelector('[data-testid="chat-file-link"]')
    expect(link?.textContent).toBe("see [SHO-1]")
    fireEvent.click(link!)
    expect(opened).toEqual(["plans/x.md"])
  })

  test("is plain text when nothing can open it", () => {
    const container = renderBody(BODY)
    expectNoBlocked(container)
    expect(container.querySelector("a")).toBeNull()
    expect(container.textContent).toContain("see [SHO-1]")
  })
})

describe("links that already worked", () => {
  test("an http link is still an anchor", () => {
    const container = renderBody("[docs](https://example.com/a)")
    expectNoBlocked(container)
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/a")
  })

  test("a bare url is still linkified", () => {
    const container = renderBody("Read example.com today.")
    expectNoBlocked(container)
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/")
  })

  test("a mention is still a mention", () => {
    const container = renderBody("[@Planner](/shogo-mention/a/ws)")
    expectNoBlocked(container)
    expect(container.querySelector('[data-testid="chat-mention"]')?.textContent).toBe("@Planner")
  })

  test("a workspace file link is still a file link", () => {
    const container = renderBody("[a.md](/shogo-file?path=plans%2Fa.md)", {
      onFilePress: () => {},
    })
    expectNoBlocked(container)
    expect(container.querySelector('[data-testid="chat-file-link"]')?.textContent).toBe("a.md")
  })

  test("an image still renders", () => {
    const container = renderBody("![shot](/shogo-image?path=brand%2Fx.png)")
    expectNoBlocked(container)
    // No media provider in this test, so the image reports itself unavailable
    // rather than being blocked.
    expect(container.querySelector('[data-testid="chat-media-unavailable"]')).not.toBeNull()
  })
})
