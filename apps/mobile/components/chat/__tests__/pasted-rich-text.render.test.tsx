// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Renders the shapes a rich-text paste actually produces, through the real
 * web markdown renderer, and asserts on the elements that come out. The unit
 * tests cover the rewrite; these cover what a reader sees.
 */

import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    useWindowDimensions: () => ({ width: 900, height: 700, scale: 1, fontScale: 1 }),
  }),
)

const { MarkdownText } = await import("../MarkdownText.web")

afterEach(cleanup)

function renderBody(text: string) {
  return render(<MarkdownText isStreaming={false}>{text}</MarkdownText>).container
}

describe("a pasted bullet list", () => {
  test("renders as list items rather than one line of bullet glyphs", () => {
    const container = renderBody("•\tItem one\n•\tItem two")

    const items = Array.from(container.querySelectorAll("li"))
    expect(items.map((item) => item.textContent)).toEqual(["Item one", "Item two"])
    expect(container.textContent).not.toContain("•")
  })

  test("keeps the nesting a rich-text copy expresses with a tab", () => {
    const container = renderBody("•\tParent\n\t•\tChild one\n\t•\tChild two")

    expect(container.querySelectorAll("li")).toHaveLength(3)
    expect(container.textContent).toContain("Parent")
    // One list, nested inside the parent item, rather than a flat run.
    const nested = container.querySelector("li > ul")
    expect(nested).not.toBeNull()
    expect(Array.from(nested!.querySelectorAll("li")).map((item) => item.textContent)).toEqual([
      "Child one",
      "Child two",
    ])
  })
})

describe("a pasted numbered list", () => {
  test("an indented copy renders as an ordered list, not a code block", () => {
    const container = renderBody("\t1. one\n\t2. two")

    expect(Array.from(container.querySelectorAll("ol li")).map((li) => li.textContent)).toEqual([
      "one",
      "two",
    ])
    expect(container.querySelector("pre")).toBeNull()
  })

  test("four spaces of copy indent is rescued the same way", () => {
    const container = renderBody("    1. one\n    2. two")

    expect(Array.from(container.querySelectorAll("ol li")).map((li) => li.textContent)).toEqual([
      "one",
      "two",
    ])
    expect(container.querySelector("pre")).toBeNull()
  })
})

describe("a pasted spreadsheet block", () => {
  test("renders as a table instead of one run-on line", () => {
    const container = renderBody("Name\tQty\tPrice\nWidget\t2\t9.99")

    const table = container.querySelector("table")
    expect(table).not.toBeNull()
    expect(Array.from(table!.querySelectorAll("th")).map((th) => th.textContent)).toEqual([
      "Name",
      "Qty",
      "Price",
    ])
    expect(Array.from(table!.querySelectorAll("tbody td")).map((td) => td.textContent)).toEqual([
      "Widget",
      "2",
      "9.99",
    ])
  })
})

describe("a typed plus sign", () => {
  test("stays a plus instead of turning into a bullet", () => {
    const container = renderBody("+ @Adhihariharan AU")

    expect(container.querySelector("ul")).toBeNull()
    expect(container.textContent).toBe("+ @Adhihariharan AU")
  })

  test("a list written with plus markers is still a list", () => {
    const container = renderBody("+ a\n+ b")

    expect(Array.from(container.querySelectorAll("li")).map((li) => li.textContent)).toEqual([
      "a",
      "b",
    ])
  })
})

describe("markdown that was already correct", () => {
  test("is rendered unchanged", () => {
    const container = renderBody("- one\n- two\n\n**bold** and a [link](https://example.com)")

    expect(Array.from(container.querySelectorAll("li")).map((li) => li.textContent)).toEqual([
      "one",
      "two",
    ])
    expect(container.querySelector('[data-streamdown="strong"]')?.textContent).toBe("bold")
    expect(container.querySelector("a")?.getAttribute("href")).toContain("example.com")
  })

  test("keeps a fenced code block verbatim", () => {
    const container = renderBody("```\n•\tnot a list\n```")

    expect(container.querySelector("pre")?.textContent).toContain("•\tnot a list")
    expect(container.querySelector("li")).toBeNull()
  })
})
