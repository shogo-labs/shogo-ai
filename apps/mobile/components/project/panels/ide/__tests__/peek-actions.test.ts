// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-PEEK — unit tests for the pure peek/goto decision engine.
 *
 * Pure module, no React / Monaco / DOM — runs under `bun test`.
 * Pins: trigger→kind mapping; the decision matrix (explicit-peek, single
 * goto, multi preference, references-as-list, cmd+click fix); defensive
 * count normalisation; preference parsing (nested dotted keys + coercion);
 * and the Monaco option mapping.
 */
import { describe, expect, test } from "bun:test"
import {
  DEFAULT_PEEK_PREFERENCES,
  multiPreferenceFor,
  parsePeekPreferences,
  peekPreferencesToMonacoOptions,
  resolvePeekAction,
  triggerLocationKind,
  type PeekPreferences,
} from "../peek-actions"

const prefs = (over: Partial<PeekPreferences> = {}): PeekPreferences => ({ ...DEFAULT_PEEK_PREFERENCES, ...over })

describe("defaults realise the fix", () => {
  test("cmd+click peeks and multi-definitions peek by default", () => {
    expect(DEFAULT_PEEK_PREFERENCES.clickOpensPeek).toBe(true)
    expect(DEFAULT_PEEK_PREFERENCES.multipleDefinitions).toBe("peek")
    expect(Object.isFrozen(DEFAULT_PEEK_PREFERENCES)).toBe(true)
  })
})

describe("triggerLocationKind", () => {
  test("maps each trigger to its kind", () => {
    expect(triggerLocationKind("goToDefinition")).toBe("definition")
    expect(triggerLocationKind("peekDefinition")).toBe("definition")
    expect(triggerLocationKind("click")).toBe("definition")
    expect(triggerLocationKind("goToTypeDefinition")).toBe("typeDefinition")
    expect(triggerLocationKind("goToDeclaration")).toBe("declaration")
    expect(triggerLocationKind("goToImplementation")).toBe("implementation")
    expect(triggerLocationKind("goToReferences")).toBe("references")
    expect(triggerLocationKind("peekReferences")).toBe("references")
  })
})

describe("resolvePeekAction — no locations", () => {
  test("0 locations → none regardless of trigger", () => {
    expect(resolvePeekAction("goToDefinition", 0)).toBe("none")
    expect(resolvePeekAction("peekDefinition", 0)).toBe("none")
    expect(resolvePeekAction("click", 0)).toBe("none")
  })
  test("negative / NaN / fractional counts normalise", () => {
    expect(resolvePeekAction("goToDefinition", -3)).toBe("none")
    expect(resolvePeekAction("goToDefinition", NaN)).toBe("none")
    expect(resolvePeekAction("goToDefinition", 1.9)).toBe("goto") // floors to 1
    expect(resolvePeekAction("goToDefinition", 2.1, prefs({ multipleDefinitions: "peek" }))).toBe("peek")
  })
})

describe("resolvePeekAction — explicit peek commands always peek", () => {
  test("Alt+F12 peeks even a single definition", () => {
    expect(resolvePeekAction("peekDefinition", 1)).toBe("peek")
    expect(resolvePeekAction("peekDefinition", 5)).toBe("peek")
  })
  test("Shift+F12 peeks references even when only one", () => {
    expect(resolvePeekAction("peekReferences", 1)).toBe("peek")
  })
  test("explicit peek ignores a 'goto' preference", () => {
    expect(resolvePeekAction("peekDefinition", 3, prefs({ multipleDefinitions: "goto" }))).toBe("peek")
  })
})

describe("resolvePeekAction — Go to Definition (F12)", () => {
  test("single location jumps straight there", () => {
    expect(resolvePeekAction("goToDefinition", 1)).toBe("goto")
  })
  test("multiple → consults multipleDefinitions preference", () => {
    expect(resolvePeekAction("goToDefinition", 3, prefs({ multipleDefinitions: "peek" }))).toBe("peek")
    expect(resolvePeekAction("goToDefinition", 3, prefs({ multipleDefinitions: "goto" }))).toBe("goto")
    expect(resolvePeekAction("goToDefinition", 3, prefs({ multipleDefinitions: "gotoAndPeek" }))).toBe("gotoAndPeek")
  })
  test("type-definition uses its OWN preference, not definition's", () => {
    const p = prefs({ multipleDefinitions: "goto", multipleTypeDefinitions: "peek" })
    expect(resolvePeekAction("goToTypeDefinition", 2, p)).toBe("peek")
  })
  test("implementation + declaration use their own preferences", () => {
    expect(resolvePeekAction("goToImplementation", 2, prefs({ multipleImplementations: "gotoAndPeek" }))).toBe("gotoAndPeek")
    expect(resolvePeekAction("goToDeclaration", 2, prefs({ multipleDeclarations: "goto" }))).toBe("goto")
  })
})

describe("resolvePeekAction — references are a list", () => {
  test("peek even for a single reference (unless goto)", () => {
    expect(resolvePeekAction("goToReferences", 1, prefs({ multipleReferences: "peek" }))).toBe("peek")
    expect(resolvePeekAction("goToReferences", 9, prefs({ multipleReferences: "peek" }))).toBe("peek")
  })
  test("multipleReferences:'goto' jumps instead", () => {
    expect(resolvePeekAction("goToReferences", 9, prefs({ multipleReferences: "goto" }))).toBe("goto")
  })
})

describe("resolvePeekAction — Cmd/Ctrl+Click (the fix)", () => {
  test("click with default prefs opens an inline peek", () => {
    expect(resolvePeekAction("click", 1)).toBe("peek")
    expect(resolvePeekAction("click", 4)).toBe("peek")
  })
  test("click multi + gotoAndPeek preference → gotoAndPeek", () => {
    expect(resolvePeekAction("click", 3, prefs({ multipleDefinitions: "gotoAndPeek" }))).toBe("gotoAndPeek")
  })
  test("click single + gotoAndPeek still just peeks (nothing to disambiguate)", () => {
    expect(resolvePeekAction("click", 1, prefs({ multipleDefinitions: "gotoAndPeek" }))).toBe("peek")
  })
  test("clickOpensPeek:false → click behaves like Go to Definition", () => {
    const p = prefs({ clickOpensPeek: false })
    expect(resolvePeekAction("click", 1, p)).toBe("goto")
    expect(resolvePeekAction("click", 3, p)).toBe("peek") // multipleDefinitions default 'peek'
    expect(resolvePeekAction("click", 3, prefs({ clickOpensPeek: false, multipleDefinitions: "goto" }))).toBe("goto")
  })
})

describe("multiPreferenceFor", () => {
  test("selects the right field per kind", () => {
    const p = prefs({
      multipleDefinitions: "goto",
      multipleTypeDefinitions: "peek",
      multipleDeclarations: "gotoAndPeek",
      multipleImplementations: "goto",
      multipleReferences: "peek",
    })
    expect(multiPreferenceFor(p, "definition")).toBe("goto")
    expect(multiPreferenceFor(p, "typeDefinition")).toBe("peek")
    expect(multiPreferenceFor(p, "declaration")).toBe("gotoAndPeek")
    expect(multiPreferenceFor(p, "implementation")).toBe("goto")
    expect(multiPreferenceFor(p, "references")).toBe("peek")
  })
})

describe("parsePeekPreferences", () => {
  test("empty → defaults (cloned, not frozen)", () => {
    const out = parsePeekPreferences(null)
    expect(out).toEqual({ ...DEFAULT_PEEK_PREFERENCES })
    expect(Object.isFrozen(out)).toBe(false)
  })
  test("partial fills the rest from defaults", () => {
    const out = parsePeekPreferences({ multipleReferences: "goto" })
    expect(out.multipleReferences).toBe("goto")
    expect(out.multipleDefinitions).toBe("peek")
  })
  test("reads flattened editor.gotoLocation.* and gotoLocation.* keys", () => {
    const out = parsePeekPreferences({ "editor.gotoLocation.multipleDefinitions": "goto", "gotoLocation.multipleReferences": "gotoAndPeek" })
    expect(out.multipleDefinitions).toBe("goto")
    expect(out.multipleReferences).toBe("gotoAndPeek")
  })
  test("coerces junk to defaults, never throws", () => {
    const out = parsePeekPreferences({ multipleDefinitions: "ZOOM", peekWidgetDefaultFocus: "screen", clickOpensPeek: "false" })
    expect(out.multipleDefinitions).toBe("peek")
    expect(out.peekWidgetDefaultFocus).toBe("tree")
    expect(out.clickOpensPeek).toBe(false)
  })
  test("focus + bool string coercion", () => {
    expect(parsePeekPreferences({ peekWidgetDefaultFocus: "EDITOR" }).peekWidgetDefaultFocus).toBe("editor")
    expect(parsePeekPreferences({ clickOpensPeek: "true" }).clickOpensPeek).toBe(true)
  })
  test("honours a custom base", () => {
    const base = prefs({ multipleDefinitions: "goto", clickOpensPeek: false })
    expect(parsePeekPreferences({ multipleReferences: "goto" }, base).clickOpensPeek).toBe(false)
  })
})

describe("peekPreferencesToMonacoOptions", () => {
  test("maps the gotoLocation slice + focus", () => {
    const out = peekPreferencesToMonacoOptions(prefs({ multipleReferences: "goto", peekWidgetDefaultFocus: "editor" }))
    expect(out.gotoLocation.multipleReferences).toBe("goto")
    expect(out.gotoLocation.multipleDefinitions).toBe("peek")
    expect(out.peekWidgetDefaultFocus).toBe("editor")
  })
  test("does not leak clickOpensPeek into Monaco options", () => {
    const out = peekPreferencesToMonacoOptions(DEFAULT_PEEK_PREFERENCES) as Record<string, unknown>
    expect("clickOpensPeek" in out).toBe(false)
    expect("clickOpensPeek" in (out.gotoLocation as Record<string, unknown>)).toBe(false)
  })
  test("sanitises a dirty input blob end-to-end", () => {
    const out = peekPreferencesToMonacoOptions({ multipleDefinitions: "junk" } as unknown)
    expect(out.gotoLocation.multipleDefinitions).toBe("peek")
  })
})
