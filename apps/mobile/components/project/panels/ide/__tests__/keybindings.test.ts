/**
 * keybindings — BUG-005 palette-intent resolver lockdown.
 *
 * Each invariant is one test, named after the rule it pins. A regression
 * failure name tells you exactly which BUG-005 hazard reopened.
 *
 * The resolver IS the rule — every consumer (Workbench dispatcher,
 * CodeEditor Monaco suppression) delegates to it, so locking these tests
 * locks the entire behaviour.
 */
import { describe, expect, test } from "bun:test"
import { isPaletteShortcut, resolvePaletteIntent } from "../keybindings"

function ev(
  init: Partial<{
    key: string
    metaKey: boolean
    ctrlKey: boolean
    shiftKey: boolean
    altKey: boolean
  }>,
): KeyboardEvent {
  return {
    key: init.key ?? "p",
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
  } as unknown as KeyboardEvent
}

describe("resolvePaletteIntent — happy paths", () => {
  test("Cmd+P → 'file' (Quick Open)", () => {
    expect(resolvePaletteIntent(ev({ metaKey: true, key: "p" }))).toBe("file")
  })

  test("Ctrl+P → 'file' (Quick Open, cross-platform)", () => {
    expect(resolvePaletteIntent(ev({ ctrlKey: true, key: "p" }))).toBe("file")
  })

  test("Cmd+Shift+P → 'command' (the canvas 'Shift wins' rule)", () => {
    expect(
      resolvePaletteIntent(ev({ metaKey: true, shiftKey: true, key: "P" })),
    ).toBe("command")
  })

  test("Ctrl+Shift+P → 'command' (cross-platform)", () => {
    expect(
      resolvePaletteIntent(ev({ ctrlKey: true, shiftKey: true, key: "P" })),
    ).toBe("command")
  })
})

describe("resolvePaletteIntent — key normalisation", () => {
  test("uppercase 'P' (browser-reported when Shift is held) is accepted", () => {
    expect(resolvePaletteIntent(ev({ metaKey: true, shiftKey: true, key: "P" }))).toBe("command")
  })

  test("lowercase 'p' with Shift also resolves to 'command'", () => {
    // Some keyboard layouts / browsers report 'p' even when Shift is held.
    expect(resolvePaletteIntent(ev({ metaKey: true, shiftKey: true, key: "p" }))).toBe("command")
  })

  test("missing key returns null (defensive)", () => {
    expect(resolvePaletteIntent(ev({ metaKey: true, key: "" }))).toBeNull()
  })
})

describe("resolvePaletteIntent — modifier discipline", () => {
  test("plain 'p' with NO modifiers → null (must not steal text input)", () => {
    expect(resolvePaletteIntent(ev({ key: "p" }))).toBeNull()
  })

  test("Shift+P alone (no meta) → null (text input, capital P)", () => {
    expect(resolvePaletteIntent(ev({ shiftKey: true, key: "P" }))).toBeNull()
  })

  test("Cmd+Alt+P → null (Alt reserved for future bindings)", () => {
    expect(resolvePaletteIntent(ev({ metaKey: true, altKey: true, key: "p" }))).toBeNull()
  })

  test("Cmd+Shift+Alt+P → null (Alt always kills the palette intent)", () => {
    expect(
      resolvePaletteIntent(ev({ metaKey: true, shiftKey: true, altKey: true, key: "P" })),
    ).toBeNull()
  })
})

describe("resolvePaletteIntent — wrong key", () => {
  test("Cmd+Q → null", () => {
    expect(resolvePaletteIntent(ev({ metaKey: true, key: "q" }))).toBeNull()
  })

  test("Cmd+Shift+S → null (only 'p' opens palettes)", () => {
    expect(resolvePaletteIntent(ev({ metaKey: true, shiftKey: true, key: "S" }))).toBeNull()
  })

  test("Cmd+0 → null (digit, not letter)", () => {
    expect(resolvePaletteIntent(ev({ metaKey: true, key: "0" }))).toBeNull()
  })
})

describe("isPaletteShortcut — boolean convenience", () => {
  test("true for both Cmd+P and Cmd+Shift+P", () => {
    expect(isPaletteShortcut(ev({ metaKey: true, key: "p" }))).toBe(true)
    expect(isPaletteShortcut(ev({ metaKey: true, shiftKey: true, key: "P" }))).toBe(true)
  })

  test("false for plain 'p' / wrong key / alt-augmented", () => {
    expect(isPaletteShortcut(ev({ key: "p" }))).toBe(false)
    expect(isPaletteShortcut(ev({ metaKey: true, key: "q" }))).toBe(false)
    expect(isPaletteShortcut(ev({ metaKey: true, altKey: true, key: "p" }))).toBe(false)
  })
})

describe("BUG-005 canonical scenarios", () => {
  test("Cmd+P never returns 'command' (no fall-through into the wrong palette)", () => {
    expect(resolvePaletteIntent(ev({ metaKey: true, key: "p" }))).not.toBe("command")
  })

  test("Cmd+Shift+P never returns 'file' (Shift always wins)", () => {
    expect(
      resolvePaletteIntent(ev({ metaKey: true, shiftKey: true, key: "P" })),
    ).not.toBe("file")
  })

  test("resolver is total: every valid keypress maps to exactly one intent OR null", () => {
    // Enumerate the meaningful modifier matrix for the 'p' key.
    const cases: Array<[Partial<KeyboardEvent>, "file" | "command" | null]> = [
      [{ key: "p" }, null],
      [{ key: "p", metaKey: true }, "file"],
      [{ key: "p", ctrlKey: true }, "file"],
      [{ key: "P", metaKey: true, shiftKey: true }, "command"],
      [{ key: "P", ctrlKey: true, shiftKey: true }, "command"],
      [{ key: "p", metaKey: true, altKey: true }, null],
      [{ key: "P", metaKey: true, shiftKey: true, altKey: true }, null],
      [{ key: "P", shiftKey: true }, null],
    ]
    for (const [partial, expected] of cases) {
      expect(resolvePaletteIntent(ev(partial as any))).toBe(expected)
    }
  })
})
