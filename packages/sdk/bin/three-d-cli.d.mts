// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** Typings for the plain-ESM `shogo 3d` implementation shared with bin/cli.mjs. */

export declare const THREE_D_COMMANDS: readonly string[]

export declare function threeDHelp(): string

export interface ThreeDDeps {
  env?: Record<string, string | undefined>
  cwd?: string
  fetch?: typeof fetch
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  sleep?: (ms: number) => Promise<void>
  pollIntervalMs?: number
  fs?: Record<string, unknown>
}

/** Returns a process exit code: 0 success, 1 failure, 2 missing proxy env. */
export declare function runThreeDCommand(
  args: string[],
  flags: Record<string, unknown>,
  deps?: ThreeDDeps,
): Promise<number>
