// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Task prompt for SWE-bench instances.
 *
 * Kept intentionally minimal — the general coding discipline comes from the
 * system prompt (via the `swe` prompt profile).  The task prompt only provides
 * the issue and essential environment context, following the pattern used by
 * top-performing agents (OpenHands, SWE-agent).
 */

export function buildSWEBenchPrompt(opts: {
  instanceId: string
  repo: string
  problemStatement: string
}): string {
  const { repo, problemStatement } = opts
  return `\
Please fix the following issue in the **${repo}** repository (workspace is at \`/app/workspace\`).
The repository and all its dependencies are pre-installed — you can run tests immediately.

<issue>
${problemStatement}
</issue>

Make the minimal changes to non-test source files to resolve the issue.
Do not modify test files — tests are already correct.`
}
