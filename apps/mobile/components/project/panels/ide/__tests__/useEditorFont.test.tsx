// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * BUG-012 — useEditorFont contract lockdown.
 *
 *   The IDE used to read fonts from THREE places:
 *     • CodeEditor hardcoded a literal
 *     • XtermSession defaulted from xterm-theme
 *     • HTML output panels used Tailwind's `font-mono`
 *
 *   This module is the single source of truth now. Every property the
 *   four consumer surfaces (CodeEditor, XtermView, HTML panels via CSS
 *   var, getEditorFontFamily for non-React boot code) rely on is pinned
 *   here so a future refactor that drops one property breaks one named
 *   test, not the UX silently.
 *
 *   Three test groups:
 *     - getEditorFontFamily — pure reader (8 specs)
 *     - useEditorFont       — React hook (7 specs)
 *     - broadcastEditorFontChange + cross-tab — wiring (4 specs)
 *     - triple-source consistency             — guards the 3 default sites (1 spec)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { act, cleanup, renderHook } from "@testing-library/react"
import {
  DEFAULT_FONT_FAMILY,
  FONT_FAMILY_OPTIONS,
  broadcastEditorFontChange,
  getEditorFontFamily,
  useEditorFont,
  _SAME_TAB_EVENT,
  _STORAGE_KEY,
} from "../useEditorFont"
import { DEFAULT_SETTINGS } from "../types"

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

// ─── getEditorFontFamily — pure reader ───────────────────────────────────
describe("getEditorFontFamily — pure reader", () => {
  test("returns DEFAULT_FONT_FAMILY when localStorage is empty", () => {
    expect(getEditorFontFamily()).toBe(DEFAULT_FONT_FAMILY)
  })

  test("reads fontFamily from a valid settings payload", () => {
    localStorage.setItem(_STORAGE_KEY, JSON.stringify({ fontFamily: "Menlo, monospace" }))
    expect(getEditorFontFamily()).toBe("Menlo, monospace")
  })

  test("trims surrounding whitespace", () => {
    localStorage.setItem(_STORAGE_KEY, JSON.stringify({ fontFamily: "  Fira Code  " }))
    expect(getEditorFontFamily()).toBe("Fira Code")
  })

  test("falls back to default when fontFamily is empty string", () => {
    localStorage.setItem(_STORAGE_KEY, JSON.stringify({ fontFamily: "" }))
    expect(getEditorFontFamily()).toBe(DEFAULT_FONT_FAMILY)
  })

  test("falls back to default when fontFamily is whitespace only", () => {
    localStorage.setItem(_STORAGE_KEY, JSON.stringify({ fontFamily: "   " }))
    expect(getEditorFontFamily()).toBe(DEFAULT_FONT_FAMILY)
  })

  test("falls back to default when fontFamily is not a string", () => {
    localStorage.setItem(_STORAGE_KEY, JSON.stringify({ fontFamily: 42 }))
    expect(getEditorFontFamily()).toBe(DEFAULT_FONT_FAMILY)
  })

  test("falls back to default on malformed JSON", () => {
    localStorage.setItem(_STORAGE_KEY, "{not valid json")
    expect(getEditorFontFamily()).toBe(DEFAULT_FONT_FAMILY)
  })

  test("falls back to default when the settings object has no fontFamily key (legacy payload)", () => {
    // A user upgrading from a build before BUG-012 has a settings object
    // with fontSize/tabSize/etc. but NO fontFamily field. We MUST land
    // on the default, not on `undefined` -> Tailwind serif soup.
    localStorage.setItem(
      _STORAGE_KEY,
      JSON.stringify({ fontSize: 14, tabSize: 4, wordWrap: "on" }),
    )
    expect(getEditorFontFamily()).toBe(DEFAULT_FONT_FAMILY)
  })
})

// ─── useEditorFont — React hook ──────────────────────────────────────────
describe("useEditorFont — React hook", () => {
  test("initial value is the live localStorage value", () => {
    localStorage.setItem(_STORAGE_KEY, JSON.stringify({ fontFamily: "Cascadia Code, monospace" }))
    const { result } = renderHook(() => useEditorFont())
    expect(result.current).toBe("Cascadia Code, monospace")
  })

  test("initial value is DEFAULT_FONT_FAMILY when localStorage is empty", () => {
    const { result } = renderHook(() => useEditorFont())
    expect(result.current).toBe(DEFAULT_FONT_FAMILY)
  })

  test("updates when broadcastEditorFontChange fires (same-tab)", () => {
    const { result } = renderHook(() => useEditorFont())
    expect(result.current).toBe(DEFAULT_FONT_FAMILY)
    act(() => {
      localStorage.setItem(_STORAGE_KEY, JSON.stringify({ fontFamily: "Menlo, monospace" }))
      broadcastEditorFontChange("Menlo, monospace")
    })
    expect(result.current).toBe("Menlo, monospace")
  })

  test("updates when a `storage` event fires for the IDE key (cross-tab)", () => {
    const { result } = renderHook(() => useEditorFont())
    act(() => {
      localStorage.setItem(_STORAGE_KEY, JSON.stringify({ fontFamily: "Fira Code, monospace" }))
      // Simulate another tab writing — `storage` doesn't fire same-tab
      // in real browsers, but we synthesise it here to exercise the
      // cross-tab listener path.
      window.dispatchEvent(new StorageEvent("storage", { key: _STORAGE_KEY }))
    })
    expect(result.current).toBe("Fira Code, monospace")
  })

  test("ignores `storage` events for unrelated keys", () => {
    localStorage.setItem(_STORAGE_KEY, JSON.stringify({ fontFamily: "Menlo" }))
    const { result } = renderHook(() => useEditorFont())
    expect(result.current).toBe("Menlo")
    act(() => {
      // Touch an unrelated key. The hook should NOT re-read settings
      // (perf: many components mount this; spamming reads on every
      // localStorage write would be a regression).
      localStorage.setItem("some.other.key", "x")
      window.dispatchEvent(new StorageEvent("storage", { key: "some.other.key" }))
    })
    expect(result.current).toBe("Menlo")
  })

  test("unsubscribes on unmount (no leak)", () => {
    const { unmount, result } = renderHook(() => useEditorFont())
    const initial = result.current
    unmount()
    // Post-unmount events must not throw and must not affect the
    // (now unmounted) hook. Smoke check that no listener references
    // the dead state setter.
    expect(() => {
      localStorage.setItem(_STORAGE_KEY, JSON.stringify({ fontFamily: "x" }))
      broadcastEditorFontChange("x")
      window.dispatchEvent(new StorageEvent("storage", { key: _STORAGE_KEY }))
    }).not.toThrow()
    // result.current is captured at the last render — still the initial.
    expect(result.current).toBe(initial)
  })

  test("multiple subscribers all see the same updated value", () => {
    const { result: a } = renderHook(() => useEditorFont())
    const { result: b } = renderHook(() => useEditorFont())
    expect(a.current).toBe(DEFAULT_FONT_FAMILY)
    expect(b.current).toBe(DEFAULT_FONT_FAMILY)
    act(() => {
      localStorage.setItem(_STORAGE_KEY, JSON.stringify({ fontFamily: "Consolas, monospace" }))
      broadcastEditorFontChange("Consolas, monospace")
    })
    expect(a.current).toBe("Consolas, monospace")
    expect(b.current).toBe("Consolas, monospace")
  })
})

// ─── broadcastEditorFontChange + cross-tab wiring ────────────────────────
describe("broadcastEditorFontChange — wiring", () => {
  test("dispatches a CustomEvent on the canonical event name", () => {
    let received: string | null = null
    const listener = (e: Event) => {
      received = (e as CustomEvent<{ fontFamily: string }>).detail?.fontFamily ?? null
    }
    window.addEventListener(_SAME_TAB_EVENT, listener as EventListener)
    try {
      broadcastEditorFontChange("Foo Mono")
    } finally {
      window.removeEventListener(_SAME_TAB_EVENT, listener as EventListener)
    }
    expect(received).toBe("Foo Mono")
  })

  test("does NOT throw when no window listener is attached", () => {
    expect(() => broadcastEditorFontChange("orphan")).not.toThrow()
  })

  test("event detail carries the family — but hook still re-reads from localStorage (single source of truth)", () => {
    // Verify the hook re-reads from localStorage rather than blindly
    // trusting the event detail. This protects against a future where
    // the event payload drifts away from the persisted value (e.g. a
    // partial settings write that the broadcaster doesn't know about).
    localStorage.setItem(_STORAGE_KEY, JSON.stringify({ fontFamily: "Persisted" }))
    const { result } = renderHook(() => useEditorFont())
    expect(result.current).toBe("Persisted")
    act(() => {
      // Event says one thing, localStorage says another — localStorage wins.
      broadcastEditorFontChange("LiarLiar")
    })
    expect(result.current).toBe("Persisted")
  })

  test("FONT_FAMILY_OPTIONS first entry value === DEFAULT_FONT_FAMILY", () => {
    expect(FONT_FAMILY_OPTIONS[0]?.value).toBe(DEFAULT_FONT_FAMILY)
  })
})

// ─── Triple-source consistency — the contract that anchors the fix ───────
describe("triple-source consistency", () => {
  test("DEFAULT_FONT_FAMILY === DEFAULT_SETTINGS.fontFamily (same baked-in default)", () => {
    // If this breaks: someone updated one default but not the other.
    // The CSS variable in global.css must also be kept in sync — there
    // is no programmatic check for that one (it lives in a .css file
    // not imported into the type system), but the PR diff should
    // show both changes together. The fix-summary documents the
    // three sites that must change in lockstep.
    expect(DEFAULT_FONT_FAMILY).toBe(DEFAULT_SETTINGS.fontFamily)
  })
})
