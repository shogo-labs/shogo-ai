// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Probe for filesystem symlink support.
 *
 * Creating a symlink on Windows requires either an elevated process or
 * Developer Mode, so `symlinkSync` throws `EPERM` on a stock developer
 * machine. Symlink-escape tests must therefore be skipped rather than
 * failed, otherwise the Windows CI job can never go green and the
 * platform stays untested (SHOG-749).
 */
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function probe(): boolean {
  let dir: string | null = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'shogo-symlink-probe-'))
    symlinkSync(join(dir, 'target'), join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  }
}

/** True when this process can create symlinks. Probed once per test run. */
export const SYMLINKS_SUPPORTED = probe()
