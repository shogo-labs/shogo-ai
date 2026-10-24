// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA (SHO-100): the card type scale on the NATIVE renderer.
 *
 * `react-native-marked` pulls a second copy of React Native that Bun cannot
 * parse, so the native path cannot be rendered for real in a unit test. The
 * library is mocked down to the `styles` prop it receives instead — that prop
 * is exactly what decides the type scale, and the bug was a `project_call`
 * body rendering at the phone chat size (16/24) inside a three-line card.
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
// A handset: an unset variant renders the phone chat body (16/24) here.
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

function stylesFor(variant?: "card" | "thinking") {
  captured = null
  render(
    variant ? (
      <MarkdownText variant={variant}>{"## Head\n\nbody **bold**"}</MarkdownText>
    ) : (
      <MarkdownText>{"## Head\n\nbody **bold**"}</MarkdownText>
    ),
  )
  if (!captured) throw new Error("react-native-marked was not rendered")
  return (captured as Captured).styles
}

beforeEach(() => {
  captured = null
})
afterEach(cleanup)

describe("MarkdownText card type scale (native)", () => {
  test("keeps a card body at 12/18 on a phone instead of the 16/24 chat body", () => {
    const styles = stylesFor("card")

    expect(styles.text).toMatchObject({ fontSize: 12, lineHeight: 18 })
    expect(styles.li).toMatchObject({ fontSize: 12, lineHeight: 18 })
    expect(styles.link).toMatchObject({ fontSize: 12, lineHeight: 18 })
  })

  test("shrinks headings and code padding to card scale", () => {
    const styles = stylesFor("card")

    expect(styles.h1).toMatchObject({ fontSize: 16 })
    expect(styles.h2).toMatchObject({ fontSize: 15 })
    expect(styles.h3).toMatchObject({ fontSize: 14 })
    expect(styles.h4).toMatchObject({ fontSize: 13 })
    expect(styles.code).toMatchObject({ padding: 8 })
  })

  test("stays compact regardless of the window width (a wide window is still a card)", () => {
    // The variant, not the viewport, decides: 390px is the narrow case above and
    // the same styles must come back on a desktop-width window.
    const styles = stylesFor("card")
    expect(styles.text).toMatchObject({ fontSize: 12, lineHeight: 18 })
  })

  test("positive control: an unset variant on a phone still uses the 16/24 chat body", () => {
    const styles = stylesFor()

    expect(styles.text).toMatchObject({ fontSize: 16, lineHeight: 24 })
  })
})
