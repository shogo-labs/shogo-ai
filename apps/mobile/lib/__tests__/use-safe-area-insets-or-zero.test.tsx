// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, render } from "@testing-library/react"
import React from "react"
import { useSafeAreaInsetsOrZero } from "../use-safe-area-insets-or-zero"

afterEach(cleanup)

function Probe({ onInsets }: { onInsets: (insets: unknown) => void }) {
  onInsets(useSafeAreaInsetsOrZero())
  return null
}

describe("useSafeAreaInsetsOrZero", () => {
  test("returns zero insets instead of throwing without a SafeAreaProvider", () => {
    let seen: unknown = null
    expect(() => render(<Probe onInsets={(insets) => (seen = insets)} />)).not.toThrow()
    expect(seen).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
  })
})
