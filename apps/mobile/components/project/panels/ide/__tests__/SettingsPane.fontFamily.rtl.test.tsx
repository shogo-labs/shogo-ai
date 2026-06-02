// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * BUG-012 — Settings → font propagation, end-to-end.
 *
 * This is the integration test that proves the "Some panels read separate
 * font setting" symptom is gone. Picking a font in SettingsPane must:
 *
 *   (a) call onChange with the FULL stack (not just the primary name)
 *   (b) when the parent then re-renders SettingsPane with the new value,
 *       the select reflects it
 *   (c) custom (non-curated) values present a visible "Custom" option
 *       rather than silently snapping to a curated default
 *   (d) the bug-foundational invariant: changing only `fontSize` doesn't
 *       wipe `fontFamily` and vice-versa (immutable spread, not partial
 *       replace).
 *
 * The hook + CSS-var + Monaco/xterm wiring is covered by:
 *   - useEditorFont.test.tsx        (hook contract)
 *   - xterm-session-setFont.test.ts (live update path)
 * This file is the user-visible round-trip.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { SettingsPane } from "../SettingsPane"
import { DEFAULT_SETTINGS, type EditorSettings } from "../types"
import { DEFAULT_FONT_FAMILY, FONT_FAMILY_OPTIONS } from "../useEditorFont"

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  localStorage.clear()
})

/**
 * Test harness — mirrors the way Workbench owns the settings state.
 * The pane is controlled, so the parent applies the patch and re-renders.
 */
function Harness({
  initial = DEFAULT_SETTINGS,
  onChangeSpy,
}: {
  initial?: EditorSettings
  onChangeSpy?: (s: EditorSettings) => void
}) {
  const [s, setS] = useState<EditorSettings>(initial)
  return (
    <SettingsPane
      settings={s}
      onChange={(next) => {
        onChangeSpy?.(next)
        setS(next)
      }}
    />
  )
}

describe("SettingsPane > Font family (BUG-012)", () => {
  test("renders the Font family select alongside Font size", () => {
    render(<Harness />)
    expect(screen.getByText("Font family")).toBeDefined()
    expect(screen.getByText("Font size")).toBeDefined()
  })

  test("initial value matches DEFAULT_FONT_FAMILY (first curated option)", () => {
    render(<Harness />)
    // The Font family <select> renders the curated label for the default.
    const select = screen
      .getAllByRole("combobox")
      .find((el) => (el as HTMLSelectElement).value === DEFAULT_FONT_FAMILY) as
      | HTMLSelectElement
      | undefined
    expect(select).toBeDefined()
    expect(select!.value).toBe(DEFAULT_FONT_FAMILY)
  })

  test("changing the select fires onChange with the FULL font-family stack", async () => {
    const seen: EditorSettings[] = []
    render(<Harness onChangeSpy={(s) => seen.push(s)} />)
    const select = screen
      .getAllByRole("combobox")
      .find((el) => (el as HTMLSelectElement).value === DEFAULT_FONT_FAMILY) as HTMLSelectElement
    // Pick Menlo (curated option #4 — search by value, not by index).
    const menlo = FONT_FAMILY_OPTIONS.find((o) => o.label === "Menlo")!
    await userEvent.selectOptions(select, menlo.value)
    expect(seen.length).toBeGreaterThan(0)
    const last = seen[seen.length - 1]!
    expect(last.fontFamily).toBe(menlo.value)
    // Confirm we got the FULL stack with fallbacks, not just "Menlo".
    expect(last.fontFamily).toContain("monospace")
  })

  test("a non-curated persisted value surfaces the 'Custom' fallback option", () => {
    render(
      <Harness
        initial={{ ...DEFAULT_SETTINGS, fontFamily: "MyCustomFont, monospace" }}
      />,
    )
    // The select's value should be the sentinel `__custom__` so the
    // dropdown doesn't silently snap to JetBrains Mono (which would
    // hide the user's hand-edited stack).
    const select = screen
      .getAllByRole("combobox")
      .find((el) => (el as HTMLSelectElement).value === "__custom__") as
      | HTMLSelectElement
      | undefined
    expect(select).toBeDefined()
    expect(select!.value).toBe("__custom__")
    // And the user can SEE that they're on Custom.
    expect(screen.getByText(/Custom \(from settings file\)/)).toBeDefined()
  })

  test("selecting the 'Custom' sentinel is a no-op (preserves the hand-edited stack)", async () => {
    const seen: EditorSettings[] = []
    render(
      <Harness
        initial={{ ...DEFAULT_SETTINGS, fontFamily: "MyCustomFont, monospace" }}
        onChangeSpy={(s) => seen.push(s)}
      />,
    )
    const select = screen
      .getAllByRole("combobox")
      .find((el) => (el as HTMLSelectElement).value === "__custom__") as HTMLSelectElement
    // Re-selecting __custom__ must not fire a write that would replace
    // the user's stack with the literal "__custom__".
    await userEvent.selectOptions(select, "__custom__")
    expect(seen).toEqual([])
  })

  test("changing fontSize does NOT wipe fontFamily (immutable spread)", () => {
    const seen: EditorSettings[] = []
    render(<Harness onChangeSpy={(s) => seen.push(s)} />)
    // The size slider is the first <input type="range">. happy-dom +
    // userEvent doesn't drive range inputs reliably (keyboard events on
    // a range are a no-op without a layout engine); use the synthetic
    // `change` event directly. We're testing the SETTING flow, not the
    // range widget — the slider's contract is React's onChange firing
    // with a fresh value.
    const slider = screen.getAllByRole("slider")[0] as HTMLInputElement
    fireEvent.change(slider, { target: { value: "17" } })
    expect(seen.length).toBeGreaterThan(0)
    const last = seen[seen.length - 1]!
    expect(last.fontSize).toBe(17)
    // The crucial assertion: fontFamily survived the partial update.
    // Before BUG-012, the harness still passed this because fontFamily
    // didn't exist on the settings object yet — the regression target
    // is the OPPOSITE direction: future devs adding "replace" instead
    // of "spread" semantics.
    expect(last.fontFamily).toBe(DEFAULT_FONT_FAMILY)
  })

  test("Reset button restores fontFamily to the default", async () => {
    render(
      <Harness
        initial={{
          ...DEFAULT_SETTINGS,
          fontFamily: "MyCustomFont, monospace",
        }}
      />,
    )
    const reset = screen.getByTitle("Reset to defaults")
    await userEvent.click(reset)
    // After reset the select should show the curated default again.
    const select = screen
      .getAllByRole("combobox")
      .find((el) => (el as HTMLSelectElement).value === DEFAULT_FONT_FAMILY) as
      | HTMLSelectElement
      | undefined
    expect(select).toBeDefined()
    expect(select!.value).toBe(DEFAULT_FONT_FAMILY)
  })
})
