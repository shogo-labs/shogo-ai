/**
 * regex-support — BUG-008 feature detection + targeted-warning lockdown.
 *
 * The pattern → explanation mapping is THE rule. Every cell in the
 * (pattern uses feature) × (runtime supports feature) matrix is one
 * test below — a regression failure name maps to the exact cell that
 * broke.
 *
 * Categories:
 *   1. detectRegexSupport — probes the host V8 once, memoises;
 *   2. analyzeRegex — pure string scan of the pattern's feature usage;
 *   3. explainRegexError — cross-references usage × support and returns
 *      a user-facing message (or null when supported).
 */
import { describe, expect, test } from "bun:test";
import {
  analyzeRegex,
  detectRegexSupport,
  explainRegexError,
  type RegexSupport,
} from "../regex-support";

const FULL: RegexSupport = {
  lookbehind: true,
  lookahead: true,
  namedGroups: true,
  unicodePropertyEscapes: true,
};
const NO_LOOKBEHIND: RegexSupport = { ...FULL, lookbehind: false };
const NO_NAMED: RegexSupport = { ...FULL, namedGroups: false };
const NO_UNICODE: RegexSupport = { ...FULL, unicodePropertyEscapes: false };

describe("detectRegexSupport — host probe", () => {
  test("modern bun + Node + Electron all support every probed feature", () => {
    // Our test runtime IS modern V8 — these probes must all succeed.
    // If this test fails the test environment regressed, not the code.
    const r = detectRegexSupport({ force: true });
    expect(r.lookbehind).toBe(true);
    expect(r.lookahead).toBe(true);
    expect(r.namedGroups).toBe(true);
    expect(r.unicodePropertyEscapes).toBe(true);
  });

  test("memoises across calls (no re-probe without force)", () => {
    const a = detectRegexSupport();
    const b = detectRegexSupport();
    expect(b).toBe(a); // same reference — confirms memoisation
  });

  test("force=true returns a fresh object", () => {
    const a = detectRegexSupport();
    const b = detectRegexSupport({ force: true });
    expect(b).not.toBe(a);
    expect(b).toEqual(a);
  });
});

describe("analyzeRegex — pattern scan", () => {
  test("plain text → no advanced features", () => {
    expect(analyzeRegex("hello")).toEqual({
      usesLookbehind: false,
      usesNamedGroups: false,
      usesUnicodePropertyEscapes: false,
    });
  });

  test("lookahead is NOT flagged as lookbehind", () => {
    expect(analyzeRegex("foo(?=bar)").usesLookbehind).toBe(false);
  });

  test("negative lookahead is NOT flagged as lookbehind", () => {
    expect(analyzeRegex("foo(?!bar)").usesLookbehind).toBe(false);
  });

  test("positive lookbehind (?<=…) IS flagged", () => {
    expect(analyzeRegex("(?<=foo)bar").usesLookbehind).toBe(true);
  });

  test("negative lookbehind (?<!…) IS flagged", () => {
    expect(analyzeRegex("(?<!foo)bar").usesLookbehind).toBe(true);
  });

  test("lookbehind anywhere in the pattern is flagged", () => {
    expect(analyzeRegex("\\s+(?<=x)y").usesLookbehind).toBe(true);
  });

  test("named group (?<name>…) IS flagged", () => {
    expect(analyzeRegex("(?<year>\\d{4})").usesNamedGroups).toBe(true);
  });

  test("named group with underscore / $ in name", () => {
    expect(analyzeRegex("(?<_x$>...)").usesNamedGroups).toBe(true);
  });

  test("named group is NOT flagged as lookbehind", () => {
    const u = analyzeRegex("(?<year>\\d{4})");
    expect(u.usesNamedGroups).toBe(true);
    expect(u.usesLookbehind).toBe(false);
  });

  test("lookbehind is NOT flagged as named group", () => {
    const u = analyzeRegex("(?<=x)y");
    expect(u.usesNamedGroups).toBe(false);
    expect(u.usesLookbehind).toBe(true);
  });

  test("Unicode property escape \\p{…} IS flagged", () => {
    expect(analyzeRegex("\\p{Letter}+").usesUnicodePropertyEscapes).toBe(true);
  });

  test("negated Unicode property escape \\P{…} IS flagged", () => {
    expect(analyzeRegex("\\P{ASCII}").usesUnicodePropertyEscapes).toBe(true);
  });

  test("escaped \\p (literal p) is also flagged — false positive accepted per docstring", () => {
    // Documented limitation: \p{...} inside a char class or after a
    // backslash-escape would still match. Acceptable false-positive in
    // service of a simpler, faster scanner. The user pattern almost
    // certainly intends the property escape if they wrote \p{...}.
    expect(analyzeRegex("[\\p{Letter}]").usesUnicodePropertyEscapes).toBe(true);
  });

  test("combined: lookbehind + named group + unicode property", () => {
    const u = analyzeRegex("(?<=^)(?<word>\\p{Letter}+)");
    expect(u.usesLookbehind).toBe(true);
    expect(u.usesNamedGroups).toBe(true);
    expect(u.usesUnicodePropertyEscapes).toBe(true);
  });

  test("malformed pattern doesn't throw the analyzer", () => {
    // The analyzer is pure string scan — must not call new RegExp.
    expect(() => analyzeRegex("(?<=incomplete")).not.toThrow();
  });

  test("empty pattern → no features", () => {
    expect(analyzeRegex("").usesLookbehind).toBe(false);
  });
});

describe("explainRegexError — usage × support matrix", () => {
  test("plain text on full-support runtime: no explanation", () => {
    expect(explainRegexError("hello world", FULL)).toBeNull();
  });

  test("lookbehind on supported runtime: no explanation (let V8 speak)", () => {
    expect(explainRegexError("(?<=foo)bar", FULL)).toBeNull();
  });

  test("THE BUG-008 case: lookbehind on Electron <116 → targeted Chromium-116 message", () => {
    const msg = explainRegexError("(?<=foo)bar", NO_LOOKBEHIND);
    expect(msg).not.toBeNull();
    expect(msg).toContain("Lookbehind");
    expect(msg).toContain("Chromium 116");
  });

  test("named groups on old runtime → Chromium-64 named-group message", () => {
    const msg = explainRegexError("(?<year>\\d{4})", NO_NAMED);
    expect(msg).toContain("Named capture groups");
    expect(msg).toContain("Chromium 64");
  });

  test("Unicode property escape on old runtime → property-escape message", () => {
    const msg = explainRegexError("\\p{Letter}", NO_UNICODE);
    expect(msg).toContain("Unicode property escapes");
  });

  test("pattern that needs MULTIPLE missing features: lookbehind wins (most-blocking-first)", () => {
    const support: RegexSupport = {
      lookbehind: false,
      lookahead: true,
      namedGroups: false,
      unicodePropertyEscapes: false,
    };
    const msg = explainRegexError("(?<=x)(?<g>y)\\p{Letter}", support);
    expect(msg).toContain("Lookbehind"); // first hit returned
  });

  test("pattern uses lookbehind but lookbehind is supported: no explanation", () => {
    expect(explainRegexError("(?<=foo)bar", FULL)).toBeNull();
  });

  test("named group on full-support runtime: no explanation", () => {
    expect(explainRegexError("(?<year>\\d{4})", FULL)).toBeNull();
  });

  test("default support (from detectRegexSupport): no explanation on modern V8", () => {
    // Don't pass an explicit support arg — uses the real probe.
    expect(explainRegexError("(?<=foo)bar")).toBeNull();
  });

  test("explanation messages are action-oriented (mention what to do)", () => {
    // Strings are user-facing; assert the actionable parts are present.
    const lb = explainRegexError("(?<=x)y", NO_LOOKBEHIND)!;
    expect(lb).toMatch(/upgrade|non-lookbehind/i);
    const ng = explainRegexError("(?<n>x)", NO_NAMED)!;
    expect(ng).toMatch(/positional|instead/i);
  });
});

describe("BUG-008 canonical scenarios", () => {
  test("Electron 115 user typing `(?<=\\$)\\d+` for 'dollar amounts': clear message, not V8 noise", () => {
    const msg = explainRegexError("(?<=\\$)\\d+", NO_LOOKBEHIND);
    expect(msg).toBeTruthy();
    // The user is told it's an Electron/Chromium issue, not a syntax error.
    expect(msg).not.toContain("Invalid group");
    expect(msg).toContain("Chromium 116");
  });

  test("Electron 116 user typing same pattern: no targeted message (it just works)", () => {
    // On a runtime that supports lookbehind, we don't generate a custom
    // message — V8 would compile it fine.
    expect(explainRegexError("(?<=\\$)\\d+", FULL)).toBeNull();
  });

  test("user typo unrelated to feature support: no false explanation", () => {
    // A truly broken pattern with no advanced features falls through
    // to the V8 message (caller handles that fallback).
    expect(explainRegexError("(abc", FULL)).toBeNull();
    expect(explainRegexError("[unclosed", FULL)).toBeNull();
  });
});
