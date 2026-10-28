// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import React from "react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "android", select: (options: Record<string, unknown>) => options.android },
  }),
)
mock.module("../ShareFileViewer", () => ({ ShareFileSheet: () => null }))

const { OPEN_FILE_EVENT, ShareFileHost } = await import("../share-file-context")

afterEach(cleanup)

test("does not register browser file events when mounted on Android", () => {
  const addEventListener = spyOn(window, "addEventListener")
  try {
    render(<ShareFileHost><div>App</div></ShareFileHost>)
    expect(addEventListener.mock.calls.some(([event]) => event === OPEN_FILE_EVENT)).toBe(false)
  } finally {
    addEventListener.mockRestore()
  }
})
