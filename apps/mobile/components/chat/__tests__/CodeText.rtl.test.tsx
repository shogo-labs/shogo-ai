// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import * as React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

const rendered: Array<Record<string, unknown>> = []
const TextHost = React.forwardRef<HTMLElement, Record<string, unknown>>(function TextHost(props, ref) {
  rendered.push(props)
  return React.createElement("span", { ref }, props.children as React.ReactNode)
})

mock.module("react-native", () => createReactNativeMock({ Text: TextHost }))
const setStringAsync = mock(async (_text: string) => true)
mock.module("expo-clipboard", () => ({ setStringAsync }))

const { Platform: platform } = (await import("react-native")) as unknown as { Platform: { OS: string } }
const { CodeText } = await import("../CodeText")

afterEach(() => {
  cleanup()
  rendered.length = 0
  setStringAsync.mockClear()
})

describe("CodeText", () => {
  test("is not natively selectable on Android, where dragging a selection can crash", () => {
    platform.OS = "android"
    render(<CodeText>{'{\n  "ok": true\n}'}</CodeText>)
    expect(rendered[0].selectable).toBeUndefined()
    ;(rendered[0].onLongPress as () => void)()
    expect(setStringAsync).toHaveBeenCalledWith('{\n  "ok": true\n}')
  })

  test("stays selectable elsewhere", () => {
    platform.OS = "ios"
    render(<CodeText>{"output"}</CodeText>)
    expect(rendered[0].selectable).toBe(true)
    expect(rendered[0].onLongPress).toBeUndefined()
  })
})
