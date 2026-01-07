/**
 * usePhaseColor Hook Tests
 * Task: task-w1-use-phase-color-hook
 *
 * Tests verify:
 * 1. Returns color object for valid phases
 * 2. Handles all 8 phase values
 * 3. Returns neutral gray for unknown phases
 * 4. Is memoized to prevent recalculation
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { renderHook } from "@testing-library/react"
import { Window } from "happy-dom"
import { usePhaseColor, getPhaseColors } from "./usePhaseColor"

// Set up happy-dom
let window: Window
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document

beforeAll(() => {
  window = new Window()
  originalWindow = globalThis.window
  originalDocument = globalThis.document
  // @ts-expect-error - happy-dom Window type mismatch
  globalThis.window = window
  // @ts-expect-error - happy-dom Document type mismatch
  globalThis.document = window.document
})

afterAll(() => {
  globalThis.window = originalWindow
  globalThis.document = originalDocument
  window.close()
})

describe("usePhaseColor - Returns Object", () => {
  test("returns object with bg property", () => {
    const { result } = renderHook(() => usePhaseColor("discovery"))
    expect(result.current).toHaveProperty("bg")
    expect(typeof result.current.bg).toBe("string")
  })

  test("returns object with text property", () => {
    const { result } = renderHook(() => usePhaseColor("discovery"))
    expect(result.current).toHaveProperty("text")
    expect(typeof result.current.text).toBe("string")
  })

  test("returns object with border property", () => {
    const { result } = renderHook(() => usePhaseColor("discovery"))
    expect(result.current).toHaveProperty("border")
    expect(typeof result.current.border).toBe("string")
  })

  test("returns object with ring property", () => {
    const { result } = renderHook(() => usePhaseColor("discovery"))
    expect(result.current).toHaveProperty("ring")
    expect(typeof result.current.ring).toBe("string")
  })

  test("returns object with accent property", () => {
    const { result } = renderHook(() => usePhaseColor("discovery"))
    expect(result.current).toHaveProperty("accent")
    expect(typeof result.current.accent).toBe("string")
  })
})

describe("usePhaseColor - All Phases", () => {
  test("returns colors for 'discovery'", () => {
    const { result } = renderHook(() => usePhaseColor("discovery"))
    expect(result.current.bg).toBeTruthy()
    expect(result.current.bg).toContain("blue")
  })

  test("returns colors for 'analysis'", () => {
    const { result } = renderHook(() => usePhaseColor("analysis"))
    expect(result.current.bg).toBeTruthy()
    expect(result.current.bg).toContain("violet")
  })

  test("returns colors for 'classification'", () => {
    const { result } = renderHook(() => usePhaseColor("classification"))
    expect(result.current.bg).toBeTruthy()
    expect(result.current.bg).toContain("pink")
  })

  test("returns colors for 'design'", () => {
    const { result } = renderHook(() => usePhaseColor("design"))
    expect(result.current.bg).toBeTruthy()
    expect(result.current.bg).toContain("amber")
  })

  test("returns colors for 'spec'", () => {
    const { result } = renderHook(() => usePhaseColor("spec"))
    expect(result.current.bg).toBeTruthy()
    expect(result.current.bg).toContain("emerald")
  })

  test("returns colors for 'testing'", () => {
    const { result } = renderHook(() => usePhaseColor("testing"))
    expect(result.current.bg).toBeTruthy()
    expect(result.current.bg).toContain("cyan")
  })

  test("returns colors for 'implementation'", () => {
    const { result } = renderHook(() => usePhaseColor("implementation"))
    expect(result.current.bg).toBeTruthy()
    expect(result.current.bg).toContain("red")
  })

  test("returns colors for 'complete'", () => {
    const { result } = renderHook(() => usePhaseColor("complete"))
    expect(result.current.bg).toBeTruthy()
    expect(result.current.bg).toContain("green")
  })
})

describe("usePhaseColor - Unknown Phases", () => {
  test("returns neutral gray color classes for unknown phase", () => {
    const { result } = renderHook(() => usePhaseColor("unknown-phase"))
    expect(result.current.bg).toContain("gray")
  })

  test("does not throw error for unknown phase", () => {
    expect(() => {
      renderHook(() => usePhaseColor("invalid"))
    }).not.toThrow()
  })

  test("returns valid CSS class names for unknown phase", () => {
    const { result } = renderHook(() => usePhaseColor(""))
    expect(result.current.bg.length).toBeGreaterThan(0)
    expect(result.current.text.length).toBeGreaterThan(0)
  })
})

describe("usePhaseColor - Memoization", () => {
  test("returns same object reference on subsequent calls with same phase", () => {
    const { result, rerender } = renderHook(
      ({ phase }) => usePhaseColor(phase),
      { initialProps: { phase: "discovery" } }
    )

    const firstResult = result.current
    rerender({ phase: "discovery" })
    const secondResult = result.current

    // Should return same reference (memoized)
    expect(firstResult).toBe(secondResult)
  })

  test("returns new object when phase changes", () => {
    const { result, rerender } = renderHook(
      ({ phase }) => usePhaseColor(phase),
      { initialProps: { phase: "discovery" } }
    )

    const firstResult = result.current
    rerender({ phase: "analysis" })
    const secondResult = result.current

    // Should return different reference when phase changes
    expect(firstResult).not.toBe(secondResult)
  })
})

describe("getPhaseColors - Non-hook utility", () => {
  test("returns colors for valid phase without hook", () => {
    const colors = getPhaseColors("discovery")
    expect(colors.bg).toContain("blue")
    expect(colors.text).toContain("blue")
  })

  test("returns gray for unknown phase without hook", () => {
    const colors = getPhaseColors("unknown")
    expect(colors.bg).toContain("gray")
  })
})
