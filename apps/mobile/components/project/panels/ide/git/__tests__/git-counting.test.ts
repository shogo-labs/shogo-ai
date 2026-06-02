/**
 * git-counting — BUG-007 single-source-of-truth lockdown.
 *
 * These tests enumerate every GitShortCode and assert which ones count
 * toward a "changes" surface. The point isn't to test the implementation
 * (it's a 5-line set lookup) — it's to make the inclusion rule legible
 * and machine-checked, so any future code addition (or accidental drop)
 * is caught at PR time, not in the SCM badge looking wrong in prod.
 *
 * The bug class this prevents: BUG-007's evidence ("'!' status leaked
 * into count") was a per-call-site rule duplicated in two places. Now
 * isCountedGitCode is the canonical predicate; both consumers
 * (gitChangeCount + ChangesList.buildGroups) delegate to it.
 */
import { describe, expect, test } from "bun:test";
import { isCountedGitCode } from "../git-counting";
import type { GitShortCode } from "../bridge";

describe("isCountedGitCode — included codes (match VS Code SCM badge)", () => {
  const COUNTED: GitShortCode[] = ["M", "A", "D", "R", "C", "T", "U", "?"];
  for (const code of COUNTED) {
    test(`'${code}' counts as a change`, () => {
      expect(isCountedGitCode(code)).toBe(true);
    });
  }
});

describe("isCountedGitCode — excluded codes (NEVER counted)", () => {
  test("'!' (ignored file) is NOT counted — this is THE BUG-007 fix", () => {
    expect(isCountedGitCode("!")).toBe(false);
  });

  test("'·' (synthetic folder-dirty marker) is NOT counted", () => {
    expect(isCountedGitCode("·")).toBe(false);
  });
});

describe("isCountedGitCode — defensive / fail-closed", () => {
  test("null is NOT counted", () => {
    expect(isCountedGitCode(null)).toBe(false);
  });

  test("undefined is NOT counted", () => {
    expect(isCountedGitCode(undefined)).toBe(false);
  });

  test("unknown short code falls into the NOT-counted bucket by default", () => {
    // If a hypothetical future short code 'X' is added to GitShortCode but
    // NOT added here, it must default to false. Counting unknown codes
    // would silently re-create the BUG-007 class.
    expect(isCountedGitCode("X" as unknown as GitShortCode)).toBe(false);
  });

  test("empty string is NOT counted", () => {
    expect(isCountedGitCode("" as unknown as GitShortCode)).toBe(false);
  });

  test("whitespace / lowercase variants are NOT counted (codes are case-sensitive)", () => {
    expect(isCountedGitCode("m" as unknown as GitShortCode)).toBe(false);
    expect(isCountedGitCode(" M" as unknown as GitShortCode)).toBe(false);
    expect(isCountedGitCode("M " as unknown as GitShortCode)).toBe(false);
  });
});
