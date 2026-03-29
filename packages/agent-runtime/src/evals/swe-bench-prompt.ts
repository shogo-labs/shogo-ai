// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * System prompt for the SWE-bench Lite benchmark.
 *
 * Instructs the agent to resolve a real GitHub issue in a full Python
 * repository using the workspace tools (read_file, grep, glob, ls,
 * exec, edit_file, write_file).
 */

export function buildSWEBenchPrompt(opts: {
  instanceId: string
  repo: string
  problemStatement: string
}): string {
  const { instanceId, repo, problemStatement } = opts
  return [
    `You are an expert software engineer. Your task is to fix a bug in the **${repo}** repository.`,
    '',
    '## GitHub Issue',
    '',
    problemStatement,
    '',
    '## Task',
    '',
    'Fix the issue described above by editing the repository source code.',
    '',
    '## Approach',
    '',
    '1. Use grep() and glob() to find the relevant source files related to the issue.',
    '2. Read the source code to understand the root cause of the bug.',
    '3. Use edit_file() to make targeted changes to fix the issue.',
    '4. If helpful, run existing tests with exec() to verify your fix does not break anything.',
    '',
    '## Critical Rules',
    '',
    '- You MUST edit at least one source file to fix the issue. Do not just investigate — make the fix.',
    '- Make minimal, surgical changes. Only modify what is necessary to resolve the issue.',
    '- Do NOT modify or create test files.',
    '- Do NOT create debug scripts or temporary files.',
    '- Do NOT run git commands (no git add, git commit, git checkout, etc.).',
    '- Do NOT install packages or modify dependencies unless the fix specifically requires it.',
    '- Focus on the root cause in the source code, not on reproducing the bug.',
    `- Instance ID: ${instanceId}`,
  ].join('\n')
}
