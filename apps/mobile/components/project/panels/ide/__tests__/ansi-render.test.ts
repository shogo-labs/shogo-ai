/**
 * ansi-render — BUG-013 ANSI parser lockdown.
 *
 * The parser is the rule. Every property the render path depends on
 * (style propagation, reset semantics, malformed-input tolerance, color
 * code coverage) is pinned by one test below. A regression failure
 * name maps directly to the BUG-013 sub-hazard that reopened.
 */
import { describe, expect, test } from "bun:test";
import { parseAnsi, stripAnsi } from "../ansi-render";

const ESC = "\x1B";
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;
const BG_BLUE = `${ESC}[44m`;
const BRIGHT_RED = `${ESC}[91m`;

describe("parseAnsi — pass-through / no codes", () => {
  test("empty string returns []", () => {
    expect(parseAnsi("")).toEqual([]);
  });

  test("plain text returns one default-styled span", () => {
    const out = parseAnsi("hello world");
    expect(out.length).toBe(1);
    expect(out[0]!.text).toBe("hello world");
    expect(out[0]!.style.fg).toBe("default");
  });

  test("preserves \\n and \\t (renderer handles them)", () => {
    const out = parseAnsi("a\n\tb");
    expect(out[0]!.text).toBe("a\n\tb");
  });
});

describe("parseAnsi — single SGR codes", () => {
  test("red text emits red foreground", () => {
    const out = parseAnsi(`${RED}error${RESET}`);
    expect(out.length).toBe(1);
    expect(out[0]!.style.fg).toBe("red");
    expect(out[0]!.text).toBe("error");
  });

  test("bold text emits bold style", () => {
    const out = parseAnsi(`${BOLD}important${RESET}`);
    expect(out[0]!.style.bold).toBe(true);
  });

  test("background blue emits blue background", () => {
    const out = parseAnsi(`${BG_BLUE}highlight${RESET}`);
    expect(out[0]!.style.bg).toBe("blue");
  });

  test("bright color (90-97) maps to bright-* names", () => {
    const out = parseAnsi(`${BRIGHT_RED}loud${RESET}`);
    expect(out[0]!.style.fg).toBe("bright-red");
  });
});

describe("parseAnsi — multi-param SGR (semicolon-joined)", () => {
  test("bold+red together", () => {
    const out = parseAnsi(`${ESC}[1;31mfatal${RESET}`);
    expect(out[0]!.style.bold).toBe(true);
    expect(out[0]!.style.fg).toBe("red");
  });

  test("italic + underline + green", () => {
    const out = parseAnsi(`${ESC}[3;4;32mfancy${RESET}`);
    expect(out[0]!.style.italic).toBe(true);
    expect(out[0]!.style.underline).toBe(true);
    expect(out[0]!.style.fg).toBe("green");
  });

  test("explicit reset (0) clears all attributes", () => {
    const out = parseAnsi(`${RED}${BOLD}a${RESET}b`);
    expect(out[0]!.style.fg).toBe("red");
    expect(out[0]!.style.bold).toBe(true);
    expect(out[1]!.style.fg).toBe("default");
    expect(out[1]!.style.bold).toBe(false);
  });

  test("empty-param SGR (ESC[m) is implicit reset", () => {
    const out = parseAnsi(`${RED}a${ESC}[mb`);
    expect(out[1]!.style.fg).toBe("default");
  });

  test("partial reset: 22 clears bold/dim but NOT color", () => {
    const out = parseAnsi(`${BOLD}${RED}a${ESC}[22mb`);
    expect(out[0]!.style.bold).toBe(true);
    expect(out[0]!.style.fg).toBe("red");
    expect(out[1]!.style.bold).toBe(false);
    expect(out[1]!.style.fg).toBe("red"); // color preserved
  });

  test("color reset (39) clears fg but NOT bold", () => {
    const out = parseAnsi(`${BOLD}${RED}a${ESC}[39mb`);
    expect(out[1]!.style.bold).toBe(true);
    expect(out[1]!.style.fg).toBe("default");
  });
});

describe("parseAnsi — span splitting + merging", () => {
  test("mixed default + colored + default → 3 spans", () => {
    const out = parseAnsi(`prefix ${RED}mid${RESET} suffix`);
    expect(out.length).toBe(3);
    expect(out.map((s) => s.text)).toEqual(["prefix ", "mid", " suffix"]);
  });

  test("adjacent same-style spans are merged (saves React keys)", () => {
    // Two reset SGRs back-to-back with text between → still one span.
    const out = parseAnsi(`${RESET}a${RESET}b`);
    expect(out.length).toBe(1);
    expect(out[0]!.text).toBe("ab");
  });

  test("no trailing reset is fine — the last span just keeps the last style", () => {
    const out = parseAnsi(`${RED}danger`); // no RESET at end
    expect(out.length).toBe(1);
    expect(out[0]!.style.fg).toBe("red");
  });
});

describe("parseAnsi — extended (256-color / truecolor)", () => {
  test("256-color fg sequence is silently dropped (palette index ignored)", () => {
    const out = parseAnsi(`${ESC}[38;5;196mtext${RESET}`);
    // The 196 doesn't map to a named color in our subset — fg stays default.
    expect(out[0]!.style.fg).toBe("default");
    expect(out[0]!.text).toBe("text");
  });

  test("truecolor fg sequence consumes ALL trailing args (no leak as bogus SGR)", () => {
    // The 1 after the truecolor block would otherwise be parsed as bold.
    // We assert here that the 1;31 IS interpreted (after the 5-arg
    // truecolor consume), so the NEXT span is bold+red.
    const out = parseAnsi(`${ESC}[38;2;255;100;50;1;31mboom${RESET}`);
    expect(out[0]!.style.fg).toBe("red");
    expect(out[0]!.style.bold).toBe(true);
  });

  test("256-color bg sequence consumes index arg", () => {
    const out = parseAnsi(`${ESC}[48;5;21;1mhi${RESET}`);
    expect(out[0]!.style.bold).toBe(true); // 1 after 48;5;21 is bold
  });
});

describe("parseAnsi — malformed / adversarial input", () => {
  test("trailing lone ESC is dropped", () => {
    const out = parseAnsi(`hello${ESC}`);
    expect(out[0]!.text).toBe("hello");
  });

  test("truncated CSI (ESC[ with no final byte) is dropped", () => {
    const out = parseAnsi(`hello${ESC}[`);
    expect(out[0]!.text).toBe("hello");
  });

  test("non-SGR CSI sequence (e.g. clear-screen ESC[2J) is stripped, NOT emitted", () => {
    const out = parseAnsi(`a${ESC}[2Jb`);
    expect(out.map((s) => s.text).join("")).toBe("ab");
  });

  test("cursor-move CSI sequence is stripped", () => {
    const out = parseAnsi(`a${ESC}[5;10Hb`);
    expect(out.map((s) => s.text).join("")).toBe("ab");
  });

  test("single-char ESC sequence (e.g. ESC 7 save cursor) is stripped", () => {
    const out = parseAnsi(`a${ESC}7b`);
    expect(out.map((s) => s.text).join("")).toBe("ab");
  });

  test("control chars BEL/BS/CR are dropped from output", () => {
    const out = parseAnsi(`a\x07b\x08c\rd`);
    expect(out[0]!.text).toBe("abcd");
  });

  test("unknown SGR code is silently ignored (forward-compat)", () => {
    const out = parseAnsi(`${ESC}[99mtext${RESET}`);
    expect(out[0]!.style.fg).toBe("default");
    expect(out[0]!.text).toBe("text");
  });

  test("NaN params (numbers that fail to parse inside SGR) are silently ignored", () => {
    // ESC[NaN;31m — 'NaN' won't parse to a number; the 31 still applies.
    // We construct this by injecting a non-digit param mid-SGR via the
    // standard digit/semicolon syntax that SGR_REGEX accepts: ESC[1;;31m
    // (empty middle param parses as Number("") → 0 → reset, then 31 = red).
    const out = parseAnsi(`${ESC}[1;;31mtext${ESC}[0m`);
    expect(out[0]!.text).toBe("text");
    expect(out[0]!.style.fg).toBe("red");
    // Empty middle param triggered reset, so bold from the 1 was cleared.
    expect(out[0]!.style.bold).toBe(false);
  });

  test("nested escapes (one inside another's payload) are tolerated", () => {
    const out = parseAnsi(`${RED}a${GREEN}b${RESET}`);
    expect(out.length).toBe(2);
    expect(out[0]!.style.fg).toBe("red");
    expect(out[1]!.style.fg).toBe("green");
  });
});

describe("parseAnsi — real-world dev-tool output samples", () => {
  test("TypeScript-style error (RED bold) renders intact", () => {
    const line = `${ESC}[31m${ESC}[1merror${ESC}[22m TS2304: Cannot find name 'foo'.${RESET}`;
    const out = parseAnsi(line);
    expect(out[0]!.text).toBe("error");
    expect(out[0]!.style.bold).toBe(true);
    expect(out[0]!.style.fg).toBe("red");
    expect(out[1]!.text).toBe(" TS2304: Cannot find name 'foo'.");
    expect(out[1]!.style.fg).toBe("red");
    expect(out[1]!.style.bold).toBe(false);
  });

  test("vite-style banner (cyan bold) renders intact", () => {
    const line = `${ESC}[36m${ESC}[1mVITE v5.0.0${RESET}  ready in 234 ms`;
    const out = parseAnsi(line);
    expect(out[0]!.style.fg).toBe("cyan");
    expect(out[0]!.style.bold).toBe(true);
    expect(out[1]!.text).toBe("  ready in 234 ms");
    expect(out[1]!.style.fg).toBe("default");
  });

  test("eslint-style warning (yellow) + filepath (default) renders intact", () => {
    const line = `${ESC}[33mwarning${RESET}  Unused variable 'x'  ${ESC}[2mno-unused-vars${RESET}`;
    const out = parseAnsi(line);
    expect(out.map((s) => s.style.fg)).toEqual(["yellow", "default", "default"]);
    expect(out[2]!.style.dim).toBe(true);
  });
});

describe("stripAnsi — compat shim", () => {
  test("returns plain text for ANSI-laden input", () => {
    expect(stripAnsi(`${RED}${BOLD}hello${RESET} world`)).toBe("hello world");
  });

  test("empty in → empty out", () => {
    expect(stripAnsi("")).toBe("");
  });

  test("strips cursor-movement sequences too", () => {
    expect(stripAnsi(`a${ESC}[5;10Hb`)).toBe("ab");
  });
});
