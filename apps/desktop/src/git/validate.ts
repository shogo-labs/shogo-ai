// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Validation helpers for user-supplied strings that flow into `git` as
// positional arguments. The threat model: a misbehaving renderer (or a
// future feature that pipes external input — e.g. opening a URL handler
// — through these IPC handlers) could pass a leading-dash value like
// `--orphan` or `-f` as a "branch name". Git would interpret it as a
// flag and do something the user didn't ask for.
//
// We don't try to fully sanitize against git's ref-name rules
// (`git check-ref-format` is the authoritative answer for that). We
// just block the one class of mistake that turns into a privileged
// command injection: arguments that look like flags.

export function isSafeRefArg(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (s.length === 0) return false;
  if (s.length > 250) return false;            // git's own practical limit
  if (s.startsWith("-")) return false;          // flag-injection guard
  if (/[\x00-\x1f\x7f]/.test(s)) return false;  // control chars
  if (/\s/.test(s)) {
    // Git allows spaces in some contexts (e.g. branch names if forced),
    // but our UI never produces them. Reject so that an accidental
    // "main; rm -rf" can't slip through as a single arg.
    return false;
  }
  return true;
}

/**
 * Same as isSafeRefArg but allows the standard git short-ref characters
 * `@ { } /` that show up in stash refs (`stash@{0}`) and remote-tracking
 * branches (`origin/main`).
 */
export function isSafeFullRefArg(s: unknown): s is string {
  if (!isSafeRefArg(s)) return false;
  // isSafeRefArg already passed; just additionally allow @{} which the
  // base check doesn't explicitly forbid anyway, so this is a no-op
  // pass-through. Kept as a named helper to document intent.
  return true;
}
