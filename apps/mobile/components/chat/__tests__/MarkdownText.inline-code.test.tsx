// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () => createReactNativeMock())

const { MarkdownText } = await import("../MarkdownText.web")

/**
 * The markdown palette lives in `global.css` and is consumed by streamdown's
 * DOM. happy-dom executes the real stylesheet, so the assertions below run
 * against the same custom properties the app ships rather than a copy.
 */
beforeAll(() => {
  const css = readFileSync(resolve(import.meta.dir, "../../../global.css"), "utf8")
  const start = css.indexOf("/* Semantic markdown palette.")
  const end = css.indexOf(".chat-md a.chat-file-chip {", start)
  if (start < 0 || end < 0) throw new Error("Chat markdown palette is missing from global.css")

  const style = document.createElement("style")
  style.textContent = css.slice(start, end)
  document.head.appendChild(style)
})

afterEach(() => {
  cleanup()
  document.documentElement.classList.remove("dark")
})

// The retired amber accent, in both the hex and rgb() notations a computed
// style may hand back.
const OLD_ORANGE = ["#b45309", "rgb(180, 83, 9)", "#fb923c", "rgb(251, 146, 60)"]

function renderInlineCode(dark: boolean) {
  if (dark) document.documentElement.classList.add("dark")

  const { container } = render(
    <div className="chat-md">
      <MarkdownText>{"Run `bun test` before you push."}</MarkdownText>
    </div>,
  )

  const paragraph = container.querySelector("p")
  const code = container.querySelector<HTMLElement>('[data-streamdown="inline-code"]')
  if (!paragraph || !code) throw new Error("Streamdown did not render a paragraph and inline code")

  return { surface: container.querySelector<HTMLElement>(".chat-md")!, paragraph, code }
}

describe("MarkdownText inline code palette", () => {
  test("light: inline code uses the body color on a distinct neutral chip", () => {
    const { surface, paragraph, code } = renderInlineCode(false)

    const bodyColor = getComputedStyle(paragraph).color
    expect(bodyColor).toBeTruthy()
    expect(getComputedStyle(code).color).toBe(bodyColor)

    const chip = getComputedStyle(code).backgroundColor
    expect(chip).toBeTruthy()
    expect(chip).not.toBe("transparent")
    expect(chip).not.toBe("rgba(0, 0, 0, 0)")
    expect(chip).not.toBe(getComputedStyle(surface).backgroundColor)
    expect(chip).not.toBe(getComputedStyle(paragraph).color)

    expect(OLD_ORANGE).not.toContain(bodyColor)
    expect(OLD_ORANGE).not.toContain(chip)
  })

  test("dark: inline code uses the body color on a distinct neutral chip", () => {
    const { surface, paragraph, code } = renderInlineCode(true)

    const bodyColor = getComputedStyle(paragraph).color
    expect(bodyColor).toBeTruthy()
    expect(getComputedStyle(code).color).toBe(bodyColor)
    expect(bodyColor).not.toBe("rgb(31, 35, 40)")

    const chip = getComputedStyle(code).backgroundColor
    expect(chip).toBeTruthy()
    expect(chip).not.toBe("transparent")
    expect(chip).not.toBe("rgba(0, 0, 0, 0)")
    expect(chip).not.toBe(getComputedStyle(surface).backgroundColor)

    expect(OLD_ORANGE).not.toContain(bodyColor)
    expect(OLD_ORANGE).not.toContain(chip)
  })
})
