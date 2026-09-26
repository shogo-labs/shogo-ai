// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Git exports must not create commits while an agent turn is streaming.
 * Turn completion owns checkpoint creation; host-driven exports only persist
 * the already-committed repository when the runtime is idle.
 */
export function shouldFlushGitBeforeExport(activeStreamCount: number): boolean {
  return activeStreamCount === 0
}
