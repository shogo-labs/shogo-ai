// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from "node:path"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { cleanup, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"

mock.module("react-native", () =>
  createReactNativeMock({
    Platform: { OS: "ios" },
    Pressable: ({ accessibilityLabel, accessibilityRole, children, onPress, ...props }: any) =>
      createElement(
        "button",
        { ...props, "aria-label": accessibilityLabel, onClick: onPress, role: accessibilityRole },
        children,
      ),
  }),
)
mock.module("expo-router", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }))
mock.module("@shogo/shared-ui/primitives", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }))
mock.module("lucide-react-native", () => {
  const Icon = () => createElement("span")
  return {
    Bell: Icon, Bot: Icon, Folder: Icon, Hash: Icon, Home: Icon, Mail: Icon, MessagesSquare: Icon,
    Mic: Icon, MoreHorizontal: Icon, Plus: Icon, Search: Icon, Shield: Icon, Target: Icon,
  }
})
mock.module(resolve(import.meta.dir, "../../../branding/ShogoLogoMark"), () => ({ ShogoLogoMark: () => null }))
mock.module(resolve(import.meta.dir, "../../CreateMenu"), () => ({ CreateMenu: () => null }))
mock.module(resolve(import.meta.dir, "../../ProfileMenu"), () => ({ ProfileMenu: () => null }))

const { IconRail } = await import("../IconRail")

/** The RN mock renders testID as a data attribute, so query that. */
const allTestIds = (id: string) => Array.from(document.querySelectorAll(`[data-rn-shim="${id}"]`))
const queryTestId = (id: string) => document.querySelector(`[data-rn-shim="${id}"]`)
const testId = (id: string) => {
  const el = queryTestId(id)
  if (!el) throw new Error(`no element with testID ${id}`)
  return el
}

afterEach(() => cleanup())

function rail(props: Partial<Parameters<typeof IconRail>[0]> = {}) {
  return render(
    createElement(IconRail, {
      tabs: ["home", "dms", "activity"],
      active: "home",
      badges: {},
      onSelect: () => {},
      ...props,
    } as any),
  )
}

describe("IconRail activity badge", () => {
  test("a thread-only unread shows a dot and an 'unread' label, not a number", () => {
    rail({ dots: { activity: true } })
    expect(screen.getByRole("tab", { name: "Activity, unread" })).toBeTruthy()
    expect(testId("rail-dot")).toBeTruthy()
    expect(queryTestId("rail-badge")).toBeNull()
  })

  test("a count wins over the dot", () => {
    rail({ badges: { activity: 3 }, dots: { activity: true } })
    expect(screen.getByRole("tab", { name: "Activity, 3 unread" })).toBeTruthy()
    expect(testId("rail-badge").textContent).toBe("3")
    expect(queryTestId("rail-dot")).toBeNull()
  })

  test("no dot and a plain label when nothing is unread", () => {
    rail({ badges: { activity: 0 }, dots: { activity: false } })
    expect(screen.getByRole("tab", { name: "Activity" })).toBeTruthy()
    expect(queryTestId("rail-dot")).toBeNull()
    expect(queryTestId("rail-badge")).toBeNull()
  })

  test("a dot on one tab does not show on the others", () => {
    rail({ dots: { activity: true } })
    expect(screen.getByRole("tab", { name: "DMs" })).toBeTruthy()
    expect(allTestIds("rail-dot")).toHaveLength(1)
  })
})
