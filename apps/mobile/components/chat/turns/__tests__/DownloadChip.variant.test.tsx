// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The file viewer's header borrows this button at its own size: `variant="icon"`
 * is the same download at `h-8 w-8` with no label, so it sits beside Copy path
 * and Close instead of widening the header (SHO-284).
 */

import { expect, mock, test } from "bun:test"
import React from "react"
import { createReactNativeMock } from "../../../../test/react-native-mock"
import * as lucideStub from "../../../../test/stubs/lucide-react-native"

// The shared mock passes `onPress` to a <button>, where React ignores it.
const Pressable = ({ onPress, children, ...rest }: Record<string, unknown> & { onPress?: () => void }) => (
  <button {...rest} onClick={onPress}>
    {children as React.ReactNode}
  </button>
)
mock.module("react-native", () => createReactNativeMock({ Pressable: Pressable as never }))
mock.module("@shogo/shared-ui/primitives", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}))
mock.module("lucide-react-native", () => lucideStub)

const { cleanup, fireEvent, render, screen } = await import("@testing-library/react")
const { afterEach } = await import("bun:test")
const { DownloadChip } = await import("../DownloadChip")

afterEach(cleanup)

function open(props: { variant?: "chip" | "icon"; path: string }) {
  return render(<DownloadChip {...props} agentUrl="https://agent.example" />)
}

/** The React Native mock renders `accessibilityLabel` as a lowercase attribute. */
function byLabel(label: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[accessibilitylabel="${label}"]`)
  if (!element) throw new Error(`No element labelled ${label}`)
  return element
}

test("the icon variant is a bare icon at the header's button size", () => {
  open({ variant: "icon", path: "docs/q4 report.pdf" })

  const button = byLabel("Download q4 report.pdf")
  expect(button.className).toContain("h-8")
  expect(button.className).toContain("w-8")
  // No label: the header keeps its one row.
  expect(button.textContent).toBe("")
  expect(screen.queryByText(/Download q4 report\.pdf/)).toBeNull()
})

test("the chip variant still names the file", () => {
  open({ path: "docs/q4 report.pdf" })

  expect(byLabel("Download q4 report.pdf").textContent).toContain(
    "Download q4 report.pdf",
  )
})

test("the icon variant still starts the download", () => {
  const clicked: string[] = []
  const realCreate = document.createElement.bind(document)
  const spy = mock((tag: string) => {
    const element = realCreate(tag)
    if (tag === "a") {
      element.addEventListener("click", () => clicked.push((element as HTMLAnchorElement).href))
    }
    return element
  })
  const original = document.createElement
  document.createElement = spy as unknown as typeof document.createElement

  try {
    open({ variant: "icon", path: "docs/q4.pdf" })
    fireEvent.click(byLabel("Download q4.pdf"))
  } finally {
    document.createElement = original
  }

  expect(clicked.length).toBe(1)
  expect(clicked[0]).toContain("/agent/workspace/download/docs/q4.pdf")
})
