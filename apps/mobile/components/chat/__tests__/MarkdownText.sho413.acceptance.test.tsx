// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-413 acceptance: chat never prints `[blocked]`, and code that merely looks
 * like a link never reaches the hardener as one.
 *
 * Written by QA from the card's acceptance criteria, independently of the
 * developer's own render test.
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

/** The whole point of the card: no indicator text, no `Blocked URL` tooltip. */
function expectNoBlocked(container: HTMLElement) {
  expect(container.textContent).not.toContain("[blocked]")
  expect(container.textContent).not.toContain("[Image blocked")
  expect(container.querySelector("[title^='Blocked URL']")).toBeNull()
  expect(container.querySelector("[title*='Blocked URL']")).toBeNull()
}

describe("AC1 — a refused link is plain text, never `[blocked]`", () => {
  const cases: Array<[string, string]> = [
    ["javascript:", "[x](javascript:alert(1))"],
    ["javascript: with a nested paren", "[x](javascript:alert(1))"],
    ["data:", "[x](data:text/html,<b>hi</b>)"],
    ["vbscript:", "[x](vbscript:msgbox(1))"],
    ["a bare ticket id", "[x](SHO-12)"],
    ["a home-relative path", "[x](~/a.md)"],
    ["a query-only target", "[x](?q=1)"],
  ]

  for (const [name, body] of cases) {
    test(`${name} renders as its text`, () => {
      const container = renderBody(body)
      expectNoBlocked(container)
      expect(container.textContent?.trim()).toBe("x")
    })
  }

  // The plan asks for the literal source here, so `arr[0]()` reads as typed.
  test("an empty or whitespace target renders as the literal source", () => {
    for (const body of ["[x]()", "[x]( )"]) {
      const container = renderBody(body)
      expectNoBlocked(container)
      expect(container.textContent?.trim()).toBe(body)
      expect(container.querySelector("a")).toBeNull()
      cleanup()
    }
  })

  test("a dangerous protocol is not clickable", () => {
    for (const body of [
      "[x](javascript:alert(1))",
      "[x](data:text/html,<b>hi</b>)",
      "[x](vbscript:msgbox(1))",
    ]) {
      const container = renderBody(body)
      expect(container.querySelector("a")).toBeNull()
      cleanup()
    }
  })

  test("a reference-style link to a relative path is plain text", () => {
    const container = renderBody("[the plan][1]\n\n[1]: plans/x.md")
    expectNoBlocked(container)
    expect(container.textContent).toContain("the plan")
    expect(container.querySelector("a")).toBeNull()
  })

  test("a `file:` link never reaches the browser as a file: navigation", () => {
    const container = renderBody("[x](file:///etc/passwd)")
    expectNoBlocked(container)
    const href = container.querySelector("a")?.getAttribute("href") ?? ""
    expect(href.startsWith("file:")).toBe(false)
  })
})

describe("AC2 — a blocked image shows no `[Image blocked` text", () => {
  test("javascript: image shows its alt text", () => {
    const container = renderBody("![a shot](javascript:x)")
    expectNoBlocked(container)
    expect(container.textContent).toContain("a shot")
  })

  test("an image with no alt text shows nothing at all", () => {
    const container = renderBody("![](javascript:x)")
    expectNoBlocked(container)
    expect(container.textContent?.trim()).toBe("")
  })
})

describe("AC3 — code that looks like a link renders exactly as typed", () => {
  const prose: Array<[string, string]> = [
    ["arr[0]()", "Call arr[0]() first."],
    ["obj[Symbol.iterator]()", "Use obj[Symbol.iterator]() here."],
    ["a[0]() and b[1]()", "Both a[0]() and b[1]() run."],
    ["map[key]()", "Then map[key]() returns."],
  ]

  for (const [name, body] of prose) {
    test(`${name} in prose`, () => {
      const container = renderBody(body)
      expectNoBlocked(container)
      expect(container.textContent).toBe(body)
      expect(container.querySelector("a")).toBeNull()
    })
  }

  test("inside backticks and fences it is untouched", () => {
    const body = "`arr[0]()`\n\n```\nobj[Symbol.iterator]()\n```"
    const container = renderBody(body)
    expectNoBlocked(container)
    expect(container.textContent).toContain("arr[0]()")
    expect(container.textContent).toContain("obj[Symbol.iterator]()")
    expect(container.textContent).not.toContain("\\[")
  })
})

describe("AC4 — a link whose text contains brackets", () => {
  const BODY = "[see [SHO-1]](plans/x.md)"

  test("opens the file when the host can open files", () => {
    const opened: string[] = []
    const container = renderBody(BODY, { onFilePress: (p: string) => opened.push(p) })
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

describe("AC5 — everything that already worked still works", () => {
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
    const container = renderBody("[a.md](/shogo-file?path=plans%2Fa.md)", { onFilePress: () => {} })
    expectNoBlocked(container)
    expect(container.querySelector('[data-testid="chat-file-link"]')?.textContent).toBe("a.md")
  })

  test("a local-file share link keeps its in-app href", () => {
    const container = renderBody("[a.md](/shogo-local-file?path=%2Ftmp%2Fa.md)", {
      onFilePress: () => {},
    })
    expectNoBlocked(container)
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/shogo-local-file?path=%2Ftmp%2Fa.md",
    )
  })

  test("an image still renders", () => {
    const container = renderBody("![shot](/shogo-image?path=brand%2Fx.png)")
    expectNoBlocked(container)
    expect(container.querySelector('[data-testid="chat-media-unavailable"]')).not.toBeNull()
  })

  test("a relative path still becomes a file link", () => {
    const opened: string[] = []
    const container = renderBody("[a.md](plans/a.md)", { onFilePress: (p: string) => opened.push(p) })
    expectNoBlocked(container)
    fireEvent.click(container.querySelector('[data-testid="chat-file-link"]')!)
    expect(opened).toEqual(["plans/a.md"])
  })
})

describe("the hardener is still armed", () => {
  test("a refused link keeps its children but loses its href", () => {
    const container = renderBody("[**bold** text](javascript:alert(1))")
    expectNoBlocked(container)
    expect(container.textContent).toContain("bold")
    expect(container.querySelector("a")).toBeNull()
  })
})
