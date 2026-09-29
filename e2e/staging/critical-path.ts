// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Critical-path subset of the hosted e2e suite.
 *
 * Runs after every staging deploy (`e2e-hosted.yml` called from
 * `deploy.yml`) and must be green on a commit before a `v*` tag for that
 * commit may deploy to production. Keep it fast (target < 15 min) and
 * limited to journeys whose breakage means "users can't use the product":
 * sign up, create a project, run a chat turn, see the preview, reopen after
 * suspend/recycle, and switch workspaces.
 *
 * Select it with `E2E_SUITE=critical` (see e2e/playwright.config.ts) or
 * `bun run test:e2e:critical`. `scripts/check-e2e-quarantine.ts` verifies
 * every file listed here exists.
 */
export const CRITICAL_PATH_SPECS: readonly string[] = [
  // Sign up + create project + first chat turn + preview iframe.
  "project-preview-smoke.test.ts",
  // Agent hands users a public preview URL, never localhost.
  "agent-localhost-publish.test.ts",
  // Suspend -> reopen serves the saved source, not the template.
  "project-reopen-existing.test.ts",
  // Metal recycle keeps code + database.
  "runtime-recycle.test.ts",
  // Personal <-> team switching on wide and narrow layouts.
  "workspace-switch.test.ts",
]

export function criticalPathTestMatch(): string[] {
  return CRITICAL_PATH_SPECS.map((file) => `**/${file}`)
}
