// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { utimesSync } from 'node:fs'

/**
 * Stamp a file's mtime from `Date.now()`, the clock the code under test reads.
 *
 * Age checks (`Date.now() - stat.mtimeMs`) compare the process clock against a
 * file's mtime. A fixture that writes a file and leaves the mtime to the OS
 * gets the *real* clock stamped on it, which is only the same clock when the
 * process clock is real. Under the future-clock nightly
 * (`scripts/test-clock-offset-preload.ts`) `Date.now()` reads N days ahead of
 * the filesystem, so an unstamped "fresh" file looks N days old and a stale-lock
 * sweeper deletes it — a false positive that has nothing to do with the test's
 * intent, and one that would never happen on a real clock N days from now.
 *
 * Stamping from `Date.now()` puts the file on the same clock as the assertion,
 * so "fresh" means fresh under any offset:
 *
 *     stampMtime(file)                              // fresh
 *     stampMtime(file, Date.now() - 10 * 60_000)    // stale
 *
 * This mirrors `packages/agent-runtime/src/__tests__/helpers/stamp-mtime.ts`;
 * the two packages keep their own copy rather than sharing a test helper
 * across the package boundary.
 */
export function stampMtime(file: string, atMs: number = Date.now()): void {
  const seconds = atMs / 1000
  utimesSync(file, seconds, seconds)
}
