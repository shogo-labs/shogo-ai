// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `BuddyLookProvider` mounts above the root Stack, so a throw in its effects
 * takes down every screen. On React Native `window` exists but has no DOM
 * event methods — iOS 2.1.0 crashed on launch (Sentry SHOGO-IOS-C) because
 * the cross-window `storage` listener assumed otherwise.
 */

import { afterEach, describe, expect, mock, test } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import { createReactNativeMock } from "../../test/react-native-mock"

mock.module("react-native", () => createReactNativeMock())

mock.module("../auth", () => ({
  useAuth: () => ({ user: { id: "u-1" }, isAuthenticated: true }),
}))

mock.module("../../lib/api", () => ({
  api: {
    getMe: async () => ({ data: {} }),
    setBuddyLook: async () => ({}),
  },
  createHttpClient: () => ({}),
}))

mock.module("../../lib/desktop-island", () => ({
  setIslandBuddyLook: () => {},
}))

mock.module("../../lib/safe-storage", () => ({
  safeGetItem: () => null,
  safeSetItem: () => {},
}))

const { BuddyLookProvider } = await import("../buddy-look")

const originalAdd = window.addEventListener
const originalRemove = window.removeEventListener

afterEach(() => {
  window.addEventListener = originalAdd
  window.removeEventListener = originalRemove
})

describe("BuddyLookProvider", () => {
  test("mounts for a signed-in user when window has no event listener API (React Native)", async () => {
    ;(window as any).addEventListener = undefined
    ;(window as any).removeEventListener = undefined

    const { unmount } = render(
      <BuddyLookProvider>
        <span>app</span>
      </BuddyLookProvider>,
    )

    await waitFor(() => expect(screen.getByText("app")).toBeTruthy())
    expect(() => unmount()).not.toThrow()
  })

  test("still listens for cross-window look changes on web", async () => {
    const added: string[] = []
    window.addEventListener = ((type: string, ...rest: any[]) => {
      added.push(type)
      return (originalAdd as any).call(window, type, ...rest)
    }) as typeof window.addEventListener

    render(
      <BuddyLookProvider>
        <span>web</span>
      </BuddyLookProvider>,
    )

    await waitFor(() => expect(added).toContain("storage"))
  })
})
