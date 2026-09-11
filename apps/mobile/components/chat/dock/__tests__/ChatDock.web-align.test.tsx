// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Web dock cards (Error, Changed files, Queue, …) float above the
 * composer. They must share the transcript's centered `max-w-3xl`
 * column — not stick to the left of a full-bleed overlay.
 */
import { describe, expect, mock, test } from "bun:test"
import { render } from "@testing-library/react"
import * as React from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

mock.module("react-native", () => createReactNativeMock())
mock.module("@legendapp/motion", () => ({
  Motion: {
    View: React.forwardRef<HTMLElement, Record<string, unknown>>(function MotionView(
      { children },
      ref,
    ) {
      return React.createElement("div", { ref }, children as React.ReactNode)
    }),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}))
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))

const { createChatDockStore, ChatDockStoreContext } = await import("../../../../lib/chat-dock-store")
const { useDockPanel } = await import("../useDockPanel")
const { ChatDock } = await import("../ChatDock")

function DummyIcon() {
  return null
}

function DockHarness() {
  const store = React.useMemo(() => createChatDockStore(), [])
  const descriptor = React.useMemo(
    () => ({
      id: "error",
      kind: "status" as const,
      order: 1,
      title: "Error",
      icon: DummyIcon,
      defaultExpanded: true,
      render: () => <div>I encountered an issue processing your message.</div>,
    }),
    [],
  )
  useDockPanel(descriptor, store)

  return (
    <ChatDockStoreContext.Provider value={store}>
      <ChatDock testID="chat-dock" />
    </ChatDockStoreContext.Provider>
  )
}

describe("ChatDock web alignment", () => {
  test("centers the max-w-3xl card in the absolute overlay", () => {
    const { container } = render(<DockHarness />)
    const overlay = container.querySelector('[data-rn-shim="chat-dock"]') as HTMLElement | null
    expect(overlay).toBeTruthy()
    expect(overlay?.style.position).toBe("absolute")
    expect(overlay?.style.left).toBe("0px")
    expect(overlay?.style.right).toBe("0px")
    expect(overlay?.style.alignItems).toBe("center")
    expect(overlay?.getAttribute("class")).toBeNull()

    const column = overlay?.firstElementChild as HTMLElement | null
    expect(column?.getAttribute("class") ?? "").toContain("max-w-3xl")
    expect(column?.getAttribute("class") ?? "").toContain("w-full")
  })
})
