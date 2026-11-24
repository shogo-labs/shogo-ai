// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { join } from 'path'

/** The Bun preload that shifts the wall clock (see the file's header). */
export const TEST_CLOCK_PRELOAD_PATH = join(import.meta.dir, '..', 'test-clock-offset-preload.ts')

/**
 * `--preload` arguments for a `bun test` child, when the future-clock job
 * (`future-clock.yml`) asked for a clock offset. Empty on a normal run, so every
 * caller can splat it unconditionally.
 */
export function clockOffsetPreloadArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!env.SHOGO_TEST_CLOCK_OFFSET_DAYS) return []
  return ['--preload', TEST_CLOCK_PRELOAD_PATH]
}
