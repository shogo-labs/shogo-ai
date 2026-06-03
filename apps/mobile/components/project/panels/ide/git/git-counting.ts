/**
 * git-counting.ts — single source of truth for "counts as a change" rules.
 *
 * BUG-007 ("SCM badge counts ignored files when .gitignore is staged") was
 * fixed at the badge layer (gitChangeCount excludes '!') but the SAME rule
 * was reimplemented inline in scm/ChangesList.buildGroups: `if (code === "·"
 * || code === "!") continue;`. Two copies of the same rule is one copy too
 * many — a future GitShortCode (e.g. a hypothetical "X" for assume-unchanged
 * or "k" for kept-locally) added to only ONE site reintroduces the BUG-007
 * class silently. This module is the canonical rule both consumers consult.
 *
 * What counts:
 *   M, A, D, R, C, T, U, ?  — modified, added, deleted, renamed, copied,
 *                              type-changed, unmerged (conflict), untracked
 *
 * What does NOT count:
 *   '!'  — ignored (matches VS Code's SCM badge / source-control view)
 *   '·'  — synthetic folder-dirty marker (never stored in fileStatus, but
 *           defensively rejected in case anything ever leaks it)
 *
 * Any GitShortCode added in the future falls into the NOT-counted bucket by
 * default — callers must opt-in by adding the code here.
 */
import type { GitShortCode } from "./bridge";

export type CountableGitCode = "M" | "A" | "D" | "R" | "C" | "T" | "U" | "?";

const COUNTING_CODES: ReadonlySet<string> = new Set<CountableGitCode>([
  "M", "A", "D", "R", "C", "T", "U", "?",
]);

/**
 * True iff `code` is a status that should appear in any "changes" surface
 * (SCM badge count, Changes group in the source-control viewlet, etc.).
 * Null/undefined-safe. Unknown strings return false (fail-closed).
 */
export function isCountedGitCode(
  code: GitShortCode | "·" | null | undefined,
): boolean {
  if (code == null) return false;
  return COUNTING_CODES.has(code);
}
