// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    useWindowDimensions: () => ({ width: 220, height: 180, scale: 1, fontScale: 1 }),
  }),
)

const { MarkdownText } = await import("../MarkdownText.web")
const { PhoneLayoutOverrideProvider } = await import("../../../lib/native-phone-layout")

beforeAll(() => {
  const css = readFileSync(resolve(import.meta.dir, "../../../global.css"), "utf8")
  const start = css.indexOf("/* The desktop island uses")
  const end = css.indexOf("/* The companion chat is", start)
  if (start < 0 || end < 0) throw new Error("Island markdown CSS contract is missing")

  const style = document.createElement("style")
  style.textContent = css.slice(start, end)
  document.head.appendChild(style)
})

afterEach(cleanup)

describe("MarkdownText island typography", () => {
  test("keeps body and inline markdown text at 12px when the island overrides phone layout", () => {
    const { container } = render(
      <PhoneLayoutOverrideProvider value={false}>
        <MarkdownText>
          {"Body **bold** *italic* [link](https://example.com) ~~struck~~"}
        </MarkdownText>
      </PhoneLayoutOverrideProvider>,
    )

    const markdown = container.querySelector(".chat-md-compact")
    expect(markdown).not.toBeNull()

    const textElements = Array.from(markdown?.querySelectorAll("p, p *") ?? []).filter(
      (element) => element.textContent?.trim(),
    )
    expect(textElements.length).toBeGreaterThan(0)
    expect(textElements.map((element) => getComputedStyle(element).fontSize)).toEqual(
      textElements.map(() => "12px"),
    )
    expect(textElements.map((element) => getComputedStyle(element).lineHeight)).toEqual(
      textElements.map(() => "18px"),
    )
  })

})
