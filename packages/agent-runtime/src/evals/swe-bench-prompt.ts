// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * System prompt for the SWE-bench Lite benchmark.
 *
 * Kept intentionally minimal — methodology lives in the base agent prompts
 * (CODE_AGENT_GENERAL_GUIDE). This prompt only provides context and
 * eval-specific guardrails.
 */

export function buildSWEBenchPrompt(opts: {
  instanceId: string
  repo: string
  problemStatement: string
}): string {
  const { instanceId, repo, problemStatement } = opts
  return [
    `You are an expert software engineer. Fix the bug described below in the **${repo}** repository.`,
    '',
    '## GitHub Issue',
    '',
    problemStatement,
    '',
    '## Rules',
    '',
    '- You MUST edit at least one source file.',
    '- Only modify what is necessary to fix the issue.',
    '- Do not create new files. Use edit_file() on existing source files only.',
    '- Do not run `pip install` or modify dependencies.',
    '- Do not modify or create test files.',
    '- Do not run git commands.',
    `- Instance ID: ${instanceId}`,
  ].join('\n')
}
