/**
 * regex-support.ts — runtime feature detection + pattern analysis for the
 * search/replace regex path (BUG-008).
 *
 * Canvas evidence: "Search regex mode crashes on lookbehind in older
 * Chromium. Electron <116 V8 lacks lookbehind. Fix: Feature-detect + warn."
 *
 * Today SearchPane already catches `new RegExp(query, …)` syntax errors
 * via a try/catch and surfaces "Invalid regex: <V8 message>". The
 * problem isn't a crash — V8 throws a SyntaxError and we render the
 * message — but the V8 message for unsupported syntax in older Electron
 * is cryptic:
 *
 *   "Invalid regular expression: /(?<=foo)bar/gi: Invalid group"
 *   "Invalid regular expression: /(?<name>x)/gi: Invalid group"
 *
 * The user has no idea this is an Electron-version problem; they
 * assume their regex is wrong, second-guess the syntax, and either
 * file a "search is broken" issue or silently abandon the feature.
 *
 * Fix design:
 *   1. detectRegexSupport() probes the host V8 ONCE at module load by
 *      attempting to construct probe patterns for lookbehind, named
 *      groups, and the Unicode flag. Memoised in module scope.
 *   2. analyzeRegex(pattern) scans the user's pattern text for the
 *      feature constructs (no execution — pure string analysis). Tells
 *      us which features the pattern USES.
 *   3. explainRegexError(pattern, support) cross-references the two
 *      and returns a human message like "Lookbehind requires
 *      Chromium 116+ (your runtime doesn't support it)." Caller
 *      (SearchPane) shows this INSTEAD OF the cryptic V8 message
 *      when feature detection has a hit.
 *
 * Pure — no DOM, no globals beyond the module-scope memo. Tests can
 * inject a custom support snapshot to exercise every (pattern × runtime)
 * matrix cell.
 */

export interface RegexSupport {
  /** ECMAScript 2018 lookbehind: (?<=…) / (?<!…). Chrome/V8 ≥ 62. */
  lookbehind: boolean;
  /** Lookahead: (?=…) / (?!…). Universal — always true; included for
   *  parity in the analysis output. */
  lookahead: boolean;
  /** ECMAScript 2018 named capture groups: (?<name>…). Chrome/V8 ≥ 64. */
  namedGroups: boolean;
  /** Unicode property escapes \p{…} (requires the 'u' flag). V8 ≥ 64. */
  unicodePropertyEscapes: boolean;
}

let memoised: RegexSupport | undefined;

function probe(pattern: string, flags = ""): boolean {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect which advanced regex features the host V8 supports. Memoised at
 * module scope — the runtime can't change while the app is running, so
 * one probe per process is all we need.
 *
 * Pass `{ force: true }` from tests when you need to re-detect after
 * monkey-patching globalThis.RegExp.
 */
export function detectRegexSupport(opts?: { force?: boolean }): RegexSupport {
  if (memoised && !opts?.force) return memoised;
  memoised = {
    lookbehind: probe("(?<=a)b"),
    lookahead: probe("a(?=b)"),
    namedGroups: probe("(?<name>x)"),
    unicodePropertyEscapes: probe("\\p{Letter}", "u"),
  };
  return memoised;
}

export interface RegexUsage {
  /** True if the pattern contains a lookbehind assertion (?<= …) or (?<! …). */
  usesLookbehind: boolean;
  /** True if it contains a named-group declaration (?<name>…). */
  usesNamedGroups: boolean;
  /** True if it contains a Unicode property escape \p{…} or \P{…}. */
  usesUnicodePropertyEscapes: boolean;
}

/**
 * Scan a regex source string for advanced features. Pure string scan —
 * does NOT compile the regex (so it's safe to run on patterns the host
 * V8 would reject). The analyzer is deliberately PERMISSIVE: it errs on
 * the side of detecting a feature even when the surrounding regex is
 * malformed (e.g. unbalanced parens), because the goal is to give the
 * user a hint about WHY their pattern doesn't work — and being wrong
 * about the feature in a malformed pattern is harmless.
 *
 * NB: this does not respect character-class escaping — e.g. `[(?<=)]`
 * (a literal `(?<=)` inside a char class) would be flagged as
 * lookbehind. In practice the false-positive rate is near-zero because
 * char classes containing those exact byte sequences are extremely rare.
 * Documented here so a future maintainer doesn't replace this with a
 * full regex parser thinking the simple form is broken.
 */
export function analyzeRegex(pattern: string): RegexUsage {
  return {
    // (?<= or (?<! — lookbehind assertions
    usesLookbehind: /\(\?<[=!]/.test(pattern),
    // (?<name> — named group declaration (NOT lookbehind which is
    // (?<=…) / (?<!…); the regex above explicitly requires = or !).
    usesNamedGroups: /\(\?<[A-Za-z_$][\w$]*>/.test(pattern),
    // \p{...} or \P{...} unicode property escapes
    usesUnicodePropertyEscapes: /\\[pP]\{[^}]+\}/.test(pattern),
  };
}

/**
 * Cross-reference a pattern's usage against the host's support and
 * return a human explanation if there's a mismatch. Returns null when
 * everything is supported — caller falls back to whatever V8 actually
 * said about the pattern.
 *
 * Returned strings are user-facing — keep them concise, action-oriented,
 * and free of jargon ("Chromium 116+" is fine, "V8 ≥ 11.6.189.12" is not).
 */
export function explainRegexError(
  pattern: string,
  support: RegexSupport = detectRegexSupport(),
): string | null {
  const usage = analyzeRegex(pattern);
  if (usage.usesLookbehind && !support.lookbehind) {
    return "Lookbehind ((?<=…) / (?<!…)) requires Chromium 116+ — your runtime doesn't support it. Try using a non-lookbehind form, or upgrade the Shogo desktop app.";
  }
  if (usage.usesNamedGroups && !support.namedGroups) {
    return "Named capture groups ((?<name>…)) require Chromium 64+ — your runtime doesn't support it. Use a positional group ((…)) instead.";
  }
  if (usage.usesUnicodePropertyEscapes && !support.unicodePropertyEscapes) {
    return "Unicode property escapes (\\p{…}) require Chromium 64+ with the 'u' flag — your runtime doesn't support it.";
  }
  return null;
}
