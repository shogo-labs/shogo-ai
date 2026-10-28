// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A relative file link on the NATIVE renderer (SHO-242).
 *
 * `react-native-marked` pulls a second copy of React Native that Bun cannot
 * parse, so the native path is mocked down to the `value` prop it receives —
 * the markdown the parser is about to turn into links. A bare `plans/a.md`
 * href must never reach it: on a device that link is handed to the URL opener,
 * which cannot open a workspace path.
 */
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import * as React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

let captured: { value: string } | null = null

mock.module("react-native-marked", () => ({
  default: (props: { value: string }) => {
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

function markdownFor(text: string, onFilePress?: (path: string) => void): string {
  captured = null
  render(<MarkdownText onFilePress={onFilePress}>{text}</MarkdownText>)
  if (!captured) throw new Error("react-native-marked was not rendered")
  return (captured as { value: string }).value
}

beforeEach(() => {
  captured = null
})
afterEach(cleanup)

describe("a relative file link in a message (native)", () => {
  test("never reaches the parser as a relative href", () => {
    const value = markdownFor("[plans/a.md](plans/a.md)")

    expect(value).not.toContain("](plans/a.md)")
    expect(value).toContain("plans/a.md")
  })

  test("becomes the file href when the host can open files", () => {
    const value = markdownFor("[plans/a.md](plans/a.md)", () => {})

    expect(value).toContain("/shogo-file?path=plans%2Fa.md")
    expect(value).not.toContain("](plans/a.md)")
  })

  test("unwraps a link whose text is prose, and never opens a ../ path", () => {
    const value = markdownFor("[the plan](plans/a.md) and [key](../secret.txt)", () => {})

    expect(value).not.toContain("](plans/a.md)")
    expect(value).not.toContain("](../secret.txt)")
    expect(value).toContain("the plan")
  })
})
