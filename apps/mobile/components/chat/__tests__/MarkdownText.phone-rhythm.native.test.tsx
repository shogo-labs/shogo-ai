// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The native-phone chat type scale and paragraph rhythm (SHO-296).
 *
 * `react-native-marked` pulls a second copy of React Native that Bun cannot
 * parse, so the native path is mocked down to the `styles` prop it receives —
 * that prop is exactly what decides the type scale and the vertical rhythm.
 * Before this change one assistant turn mixed 11, 12, 15, 16 and 18px text and
 * the paragraph gap came from the library's 8px default.
 */
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import * as React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

type Captured = { styles: Record<string, Record<string, unknown>>; value: string }
let captured: Captured | null = null

mock.module("react-native-marked", () => ({
  default: (props: Captured) => {
    captured = props
    return React.createElement("div", { "data-testid": "native-markdown" }, props.value)
  },
  Renderer: class Renderer {},
}))

mock.module("react-native", () =>
  createReactNativeMock({
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  }),
)
mock.module("nativewind", () => ({ useColorScheme: () => ({ colorScheme: "light" }) }))
mock.module(resolve(import.meta.dir, "../../layout/MobileWorkspaceChromeContext"), () => ({
  useMobileWorkspaceChrome: () => false,
}))
// A handset: an unset variant renders the phone chat scale here.
mock.module(resolve(import.meta.dir, "../../../lib/native-phone-layout"), () => ({
  usePhoneLayout: () => true,
}))
mock.module(resolve(import.meta.dir, "../../../contexts/theme"), () => ({
  useResolvedTheme: () => "light",
}))
mock.module(resolve(import.meta.dir, "../FileTypeIcon"), () => ({ FileTypeIcon: () => null }))
mock.module(resolve(import.meta.dir, "../MarkdownMediaNative"), () => ({
  MarkdownMediaNative: () => null,
}))

const { MarkdownText } = await import("../MarkdownText")

function phoneStyles(): Record<string, Record<string, unknown>> {
  captured = null
  render(
    <MarkdownText>{"# Head\n\n## Head\n\n### Head\n\n#### Head\n\nbody `code`"}</MarkdownText>,
  )
  if (!captured) throw new Error("react-native-marked was not rendered")
  return (captured as Captured).styles
}

beforeEach(() => {
  captured = null
})
afterEach(cleanup)

describe("MarkdownText phone type scale (native)", () => {
  test("body copy, list items and inline markdown stay at 16/24", () => {
    const styles = phoneStyles()

    for (const key of ["text", "strong", "em", "link", "strikethrough", "li"]) {
      expect(styles[key]).toMatchObject({ fontSize: 16, lineHeight: 24 })
    }
  })

  test("headings differ by weight, not size, and carry no rule under them", () => {
    const styles = phoneStyles()

    expect(styles.h1).toMatchObject({ fontSize: 17, lineHeight: 24, fontWeight: "bold" })
    expect(styles.h2).toMatchObject({ fontSize: 17, lineHeight: 24, fontWeight: "bold" })
    expect(styles.h3).toMatchObject({ fontSize: 16, lineHeight: 24, fontWeight: "600" })
    expect(styles.h4).toMatchObject({ fontSize: 16, lineHeight: 24, fontWeight: "600" })

    for (const key of ["h1", "h2"]) {
      expect(styles[key].paddingBottom).toBe(0)
      expect(styles[key].borderBottomWidth).toBe(0)
    }
  })

  test("a heading sits 8px under the block above it and 4px over the one below", () => {
    const styles = phoneStyles()

    for (const key of ["h1", "h2", "h3", "h4"]) {
      expect(styles[key].marginTop).toBe(8)
      expect(styles[key].marginBottom).toBe(4)
    }
  })

  test("paragraphs are 12px apart instead of the library default 16px", () => {
    const styles = phoneStyles()

    // 6 + 6 between two paragraphs; the library's own default is 8 + 8.
    expect(styles.paragraph).toMatchObject({ paddingVertical: 6 })
    // List items sit 4px apart, and the block's 2px inset keeps a list on the
    // same 8–12px block gap as a paragraph.
    expect(styles.li).toMatchObject({ marginBottom: 4 })
    expect(styles.list).toMatchObject({ marginVertical: 2 })
  })

  test("inline code is one step under the body, not four", () => {
    const styles = phoneStyles()

    expect(styles.codespan).toMatchObject({ fontFamily: "monospace", fontSize: 14 })
  })
})

describe("MarkdownText phone rhythm leaves the other scales alone", () => {
  test("a card body and a thinking body keep the library paragraph rhythm", () => {
    for (const variant of ["card", "thinking"] as const) {
      captured = null
      render(<MarkdownText variant={variant}>{"one\n\ntwo"}</MarkdownText>)
      if (!captured) throw new Error("react-native-marked was not rendered")
      const styles = (captured as Captured).styles

      // No paragraph override: the library's 8px default still applies.
      expect(styles.paragraph).toBeUndefined()
    }
  })
})
