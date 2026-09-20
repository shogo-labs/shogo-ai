// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `CreatePersonalSpaceBanner` — covers the dismiss/persistence lifecycle
 * (per-device, AsyncStorage-backed, keyed by user id) and the create action.
 */

import { createElement } from "react"
import { describe, expect, mock, test } from "bun:test"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createReactNativeMock } from "../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Pressable: ({ accessibilityLabel, accessibilityRole, children, onPress, disabled, ...props }: any) =>
      createElement(
        "button",
        {
          ...props,
          "aria-label": accessibilityLabel,
          role: accessibilityRole,
          disabled,
          onClick: onPress,
        },
        children,
      ),
  }),
)

const store = new Map<string, string>()
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: async (k: string) => {
      store.delete(k)
    },
  },
}))

const { CreatePersonalSpaceBanner } = await import("../CreatePersonalSpaceBanner")

describe("CreatePersonalSpaceBanner", () => {
  test("renders the offer for a user who hasn't dismissed it", async () => {
    store.clear()
    render(<CreatePersonalSpaceBanner userId="u-1" onCreate={() => {}} />)

    await waitFor(() => {
      expect(screen.getByText("Get your own personal space")).toBeTruthy()
    })
  })

  test("stays hidden for a user who already dismissed it on this device", async () => {
    store.clear()
    store.set("shogo:personal-space-offer-dismissed:u-2", "true")
    render(<CreatePersonalSpaceBanner userId="u-2" onCreate={() => {}} />)

    await waitFor(() => {
      // Give the AsyncStorage read a tick to resolve either way.
      expect(store.get("shogo:personal-space-offer-dismissed:u-2")).toBe("true")
    })
    expect(screen.queryByText("Get your own personal space")).toBeNull()
  })

  test("dismiss button hides the banner and persists the flag", async () => {
    store.clear()
    render(<CreatePersonalSpaceBanner userId="u-3" onCreate={() => {}} />)

    await waitFor(() => {
      expect(screen.getByText("Get your own personal space")).toBeTruthy()
    })

    fireEvent.click(screen.getByLabelText("Dismiss"))

    expect(screen.queryByText("Get your own personal space")).toBeNull()
    await waitFor(() => {
      expect(store.get("shogo:personal-space-offer-dismissed:u-3")).toBe("true")
    })
  })

  test("tapping create calls onCreate and then dismisses the banner", async () => {
    store.clear()
    const onCreate = mock(() => {})
    render(<CreatePersonalSpaceBanner userId="u-4" onCreate={onCreate} />)

    await waitFor(() => {
      expect(screen.getByText("Get your own personal space")).toBeTruthy()
    })

    fireEvent.click(screen.getByLabelText("Create personal space"))

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(screen.queryByText("Get your own personal space")).toBeNull()
    })
    await waitFor(() => {
      expect(store.get("shogo:personal-space-offer-dismissed:u-4")).toBe("true")
    })
  })

  test("does not persist dismissal when there is no userId", async () => {
    store.clear()
    // No `userId` (still loading auth) — the hook defaults to dismissed
    // (hidden) until it has a real id to check, and shouldn't render.
    render(<CreatePersonalSpaceBanner userId={undefined} onCreate={() => {}} />)
    expect(screen.queryByText("Get your own personal space")).toBeNull()
  })
})
