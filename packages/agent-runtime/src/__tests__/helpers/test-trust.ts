// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Test helpers for the runtime-trust system.
 *
 * Background: `gateway-tools.ts` gates every `exec`, `write_file`, and
 * `edit_file` call behind `assertAllowedPath()` (introduced with the
 * external-folder + Workspace Trust feature). That helper consults the
 * GLOBAL trust config — `globalThis.__SHOGO_AGENT_RUNTIME_CONFIG__` set
 * at server boot, falling back to the `WORKSPACE_DIR` / `AGENT_DIR` /
 * `PROJECT_DIR` env vars.
 *
 * Unit tests typically build a local `ToolContext` with their own tmp
 * `workspaceDir` (e.g. `/tmp/test-gateway-tools`) but never propagate it
 * into the global trust config. Without this, every tool call returns
 * `Path is outside the project's allowed folders` and the tests fail
 * before exercising any real behavior.
 *
 * Use these helpers at the top of any test file that runs gateway-tools
 * against a local workspace:
 *
 *     beforeAll(() => trustWorkspaceForTests(TEST_DIR))
 *     afterAll(() => clearTrustForTests())
 *
 * For tests that mint a new workspace per test (e.g. `tmpdir()` based),
 * call `trustWorkspaceForTests(workDir)` from `beforeEach` after the
 * directory is created.
 *
 * `clearTrustForTests()` deletes both the `globalThis` config and every
 * env var the runtime-trust env-fallback consults, so the next test
 * file in the same process starts from a clean slate. The agent-runtime
 * isolated runner (`scripts/run-tests-isolated.ts`) gives each file its
 * own process, but `bun test` (used by `test:fast`) does not — keeping
 * teardown defensive avoids accidental cross-file leaks if someone
 * switches runners.
 */

export interface TrustWorkspaceOpts {
  /**
   * Trust level the tool path checks should grant. Default `trusted`
   * so `write` + `exec` are unblocked. Tests that specifically exercise
   * the restricted-mode UI prompt should pass `restricted` explicitly.
   */
  trustLevel?: 'trusted' | 'restricted'
  /**
   * `managed` (default) skips the restricted-mode default for external
   * folders, matching how managed sandbox projects boot. `external`
   * tests should set this to `external` and pick the appropriate
   * `trustLevel`.
   */
  workingMode?: 'managed' | 'external'
  /**
   * Additional allowed roots beyond `workspaceDir`. Useful for tests
   * that touch sibling tmp directories or use `os.tmpdir()` for one
   * test and a static path for another.
   */
  linkedFolders?: string[]
}

/**
 * Mirror `workspaceDir` (and any `linkedFolders`) into the global
 * runtime-trust config so `assertAllowedPath()` accepts paths under
 * those roots. Idempotent — call from `beforeEach` on every test that
 * creates a fresh workspace.
 */
export function trustWorkspaceForTests(
  workspaceDir: string,
  opts: TrustWorkspaceOpts = {},
): void {
  ;(globalThis as any).__SHOGO_AGENT_RUNTIME_CONFIG__ = {
    workingMode: opts.workingMode ?? 'managed',
    trustLevel: opts.trustLevel ?? 'trusted',
    workspaceDir,
    linkedFolders: opts.linkedFolders ?? [],
  }
}

/**
 * Reset both the global config and every env var the env-fallback
 * consults. Call from `afterAll` (and `afterEach` for tests that
 * mutate the workspace mid-suite).
 */
export function clearTrustForTests(): void {
  delete (globalThis as any).__SHOGO_AGENT_RUNTIME_CONFIG__
  delete process.env.WORKSPACE_DIR
  delete process.env.AGENT_DIR
  delete process.env.PROJECT_DIR
  delete process.env.WORKING_MODE
  delete process.env.TRUST_LEVEL
  delete process.env.LINKED_FOLDERS
}
