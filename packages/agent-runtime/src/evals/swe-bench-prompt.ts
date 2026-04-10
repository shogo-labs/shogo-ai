// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Task prompt for SWE-bench instances.
 *
 * Provides the issue, environment context, and a structured
 * reproduce-fix-verify workflow modeled on top-performing agents.
 * Supports both regular SWE-bench (Python-only) and SWE-bench Pro
 * (multi-language with requirements/interface fields).
 */

export function buildSWEBenchPrompt(opts: {
  instanceId: string
  repo: string
  problemStatement: string
  requirements?: string
  interface?: string
  repoLanguage?: string
}): string {
  const { repo, problemStatement, requirements, repoLanguage } = opts
  const iface = opts.interface

  const langHint = repoLanguage ? ` (${repoLanguage})` : ''
  const workspaceNote = 'The repository and all its dependencies are pre-installed — you can run tests immediately.'

  let prompt = `\
Fix the following issue in the **${repo}**${langHint} repository (workspace is at \`/app/workspace\`).
${workspaceNote}

<issue>
${problemStatement}
</issue>`

  if (requirements) {
    prompt += `

## Requirements

${requirements}`
  }

  if (iface) {
    prompt += `

## Interface

${iface}`
  }

  prompt += `

## Workflow

Follow these steps in order. Complete each step before moving to the next.

### 1. Explore
Analyze the codebase to understand the relevant code. Use \`search\`, \`exec\`, and \`read_file\` to find the files and functions related to the issue. Read the failing test or traceback to understand expected vs. actual behavior.

### 2. Reproduce
Create a minimal reproduction script that demonstrates the bug. Run it and confirm it fails in the way the issue describes. If the issue includes a code snippet, use that as your starting point.

### 3. Fix
Edit the source code with the **minimal change** needed to resolve the issue. Prefer the simplest correct fix — a one-line change is better than a ten-line rewrite when both are correct.

### 4. Verify
Re-run your reproduction script to confirm the fix works. Then run the project's existing test suite to check for regressions.

### 5. Edge Cases
Consider boundary conditions — does your fix handle empty inputs, None values, edge types correctly? If you spot a gap, update the fix and re-verify.

## Rules
- Only modify non-test **source files**. Do NOT modify tests, configuration files (setup.py, setup.cfg, pyproject.toml, package.json, go.mod), or CI configs.
- Do NOT refactor, rename, or clean up unrelated code.
- Do NOT add comments explaining your fix rationale — just make the fix.
- Your reproduction script is for your own debugging — it will not be included in the final patch.`

  return prompt
}
