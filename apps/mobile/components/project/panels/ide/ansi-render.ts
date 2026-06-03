/**
 * ansi-render.ts — pure ANSI-escape → styled-span parser (BUG-013).
 *
 * The canvas evidence: "Build log: ANSI codes shown as raw escape
 * sequences. Visible in Shogo screenshot — '[stdout]' leaks through.
 * Fix: Pipe output through anser before render."
 *
 * Background:
 *   The run-output panel previously called stripAnsi(line) which deleted
 *   every CSI sequence. That kept output readable but discarded all
 *   styling — TypeScript errors, vite warnings, eslint diagnostics all
 *   lost their colors. The fix replaces the strip with this parser
 *   which emits a structured ANSI span list ready for theme-aware
 *   rendering by <AnsiText> (no innerHTML, no theme drift).
 *
 * Why a hand-rolled parser instead of pulling in `anser`:
 *   1. `anser` emits HTML strings with hardcoded #RRGGBB; we want to
 *      bind through CSS custom properties so colors respect the active
 *      Monaco theme.
 *   2. The dev-tool subset we need to handle is small and well-defined:
 *      SGR codes 0, 1, 2, 3, 4, 22, 23, 24, 30-37, 38, 39, 40-47, 48,
 *      49, 90-97, 100-107. Cursor-move / clear sequences are stripped.
 *   3. Zero supply-chain surface for a feature that ships in every CI
 *      log line — `anser` is a small dep but each transitive package
 *      adds dependabot noise.
 *
 * The parser is pure (no DOM, no side effects) so the renderer is
 * trivially test-deterministic. Adversarial inputs (malformed / truncated
 * escapes, prototype-polluted iterations, unicode surrogates) are handled
 * defensively per the test suite.
 */

export interface AnsiStyle {
  /** Foreground colour. "default" → use the theme's default text colour. */
  fg: AnsiColor;
  /** Background colour. */
  bg: AnsiColor;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

export type AnsiColor =
  | "default"
  | "black" | "red" | "green" | "yellow"
  | "blue" | "magenta" | "cyan" | "white"
  | "bright-black" | "bright-red" | "bright-green" | "bright-yellow"
  | "bright-blue" | "bright-magenta" | "bright-cyan" | "bright-white";

export interface AnsiSpan {
  text: string;
  style: AnsiStyle;
}

const DEFAULT_STYLE: AnsiStyle = {
  fg: "default",
  bg: "default",
  bold: false,
  dim: false,
  italic: false,
  underline: false,
};

const FG_COLORS: AnsiColor[] = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
];
const FG_BRIGHT_COLORS: AnsiColor[] = [
  "bright-black", "bright-red", "bright-green", "bright-yellow",
  "bright-blue", "bright-magenta", "bright-cyan", "bright-white",
];

// CSI: ESC [ … final-byte. We match only SGR (final = 'm') for styling.
// Other CSI sequences (cursor move, clear screen, etc.) are matched
// separately so they're stripped, not emitted as text.
const SGR_REGEX = /\x1B\[([\d;]*)m/y;
const OTHER_CSI_REGEX = /\x1B\[[0-?]*[ -/]*[@-~]/y;
// Single-char ESC sequences (e.g. ESC 7 = DECSC save cursor, ESC = NEL,
// ESC > = numeric keypad, ESC c = full reset). Per ECMA-48 the second byte
// may be anything in 0x20-0x7E that is not '[' (which would start CSI).
const ESC_SINGLE_REGEX = /\x1B[\x20-\x5A\x5C-\x7E]/y;

/**
 * Parse a single line of text containing ANSI escape sequences into a
 * list of styled spans. Each span is contiguous text with one style.
 *
 * Contract:
 *   - Returns at least one span for non-empty input (may be the empty
 *     style if there were no SGR codes).
 *   - Returns [] for empty input — saves a render pass.
 *   - Adjacent spans with identical style are merged (saves React keys).
 *   - Unknown SGR parameters are silently ignored (forward-compat with
 *     future codes like 256-color / truecolor — see note in applySgr).
 *   - Malformed / truncated escapes (e.g. trailing "\x1B[") are dropped,
 *     never emitted as text.
 */
export function parseAnsi(input: string): AnsiSpan[] {
  if (!input) return [];

  const spans: AnsiSpan[] = [];
  let current: AnsiStyle = { ...DEFAULT_STYLE };
  let buf = "";
  let i = 0;

  const flush = () => {
    if (!buf) return;
    const last = spans[spans.length - 1];
    if (last && stylesEqual(last.style, current)) {
      last.text += buf;
    } else {
      spans.push({ text: buf, style: { ...current } });
    }
    buf = "";
  };

  while (i < input.length) {
    const ch = input.charCodeAt(i);
    // ESC
    if (ch === 0x1b) {
      SGR_REGEX.lastIndex = i;
      const sgr = SGR_REGEX.exec(input);
      if (sgr) {
        flush();
        current = applySgr(current, sgr[1]!);
        i = SGR_REGEX.lastIndex;
        continue;
      }
      OTHER_CSI_REGEX.lastIndex = i;
      const other = OTHER_CSI_REGEX.exec(input);
      if (other) {
        // Strip the sequence — don't emit it as text.
        i = OTHER_CSI_REGEX.lastIndex;
        continue;
      }
      ESC_SINGLE_REGEX.lastIndex = i;
      const esc = ESC_SINGLE_REGEX.exec(input);
      if (esc) {
        i = ESC_SINGLE_REGEX.lastIndex;
        continue;
      }
      // Truncated ESC[ (CSI started but no valid sequence to close it):
      // consume the [ alongside ESC so it doesn't leak as text on the next
      // iteration. Real-world cause: log was sliced mid-escape by buffering.
      if (input.charCodeAt(i + 1) === 0x5b /* '[' */) {
        i += 2;
        continue;
      }
      // Lone or truncated ESC — drop it (silently consume one char).
      i++;
      continue;
    }
    // Control chars we silently swallow rather than render as raw bytes.
    //   \x07 BEL   \x08 BS   \x0d CR (when not part of \r\n line break)
    // Keep \n / \t so the renderer can do its own newline / indent work.
    if (ch === 0x07 || ch === 0x08 || ch === 0x0d) {
      i++;
      continue;
    }
    buf += input[i]!;
    i++;
  }
  flush();
  return spans;
}

/**
 * Apply one SGR parameter string (e.g. "1;31" → bold + red fg) to a style.
 * Returns a NEW style object — never mutates the input.
 */
function applySgr(prev: AnsiStyle, paramsStr: string): AnsiStyle {
  // Empty params (e.g. "\x1B[m") is shorthand for reset (== "0").
  if (paramsStr === "") return { ...DEFAULT_STYLE };
  const next: AnsiStyle = { ...prev };
  const parts = paramsStr.split(";");
  for (let i = 0; i < parts.length; i++) {
    const n = Number(parts[i]);
    if (!Number.isFinite(n)) continue;
    if (n === 0) {
      // Reset all attributes — wholesale replacement.
      Object.assign(next, DEFAULT_STYLE);
    } else if (n === 1) next.bold = true;
    else if (n === 2) next.dim = true;
    else if (n === 3) next.italic = true;
    else if (n === 4) next.underline = true;
    else if (n === 22) { next.bold = false; next.dim = false; }
    else if (n === 23) next.italic = false;
    else if (n === 24) next.underline = false;
    else if (n >= 30 && n <= 37) next.fg = FG_COLORS[n - 30]!;
    else if (n === 38) {
      // 256-color / truecolor extended setter:
      //   38;5;<index>     → palette index (ignored: collapse to default)
      //   38;2;<r>;<g>;<b> → truecolor (ignored: collapse to default)
      // Consume the trailing args so they don't leak into the next loop
      // iteration as bogus SGR codes. We don't render extended colors yet
      // — the dev-tool subset doesn't need them and binding to theme
      // CSS vars wouldn't carry palette-index / RGB cleanly.
      const sub = Number(parts[i + 1]);
      if (sub === 5) i += 2;       // palette index
      else if (sub === 2) i += 4;  // r;g;b
      // else: malformed, skip just the 38.
    }
    else if (n === 39) next.fg = "default";
    else if (n >= 40 && n <= 47) next.bg = FG_COLORS[n - 40]!;
    else if (n === 48) {
      const sub = Number(parts[i + 1]);
      if (sub === 5) i += 2;
      else if (sub === 2) i += 4;
    }
    else if (n === 49) next.bg = "default";
    else if (n >= 90 && n <= 97) next.fg = FG_BRIGHT_COLORS[n - 90]!;
    else if (n >= 100 && n <= 107) next.bg = FG_BRIGHT_COLORS[n - 100]!;
    // Unknown codes: silently ignored (forward-compat).
  }
  return next;
}

function stylesEqual(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    a.fg === b.fg && a.bg === b.bg &&
    a.bold === b.bold && a.dim === b.dim &&
    a.italic === b.italic && a.underline === b.underline
  );
}

/**
 * Strip every ANSI escape sequence from a string. Compat shim for any
 * call site that needs plain text (search, copy-to-clipboard, etc.) —
 * NOT used by the render path. The bug fix replaces strip-and-render
 * with parse-and-style.
 */
export function stripAnsi(input: string): string {
  return parseAnsi(input).map((s) => s.text).join("");
}
