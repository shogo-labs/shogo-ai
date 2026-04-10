// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Prompt builder for the FeatureBench benchmark.
 *
 * FeatureBench tasks require implementing new features in real open-source
 * repositories. Unlike SWE-bench (bug fixing), this tests end-to-end feature
 * development with both fail-to-pass and pass-to-pass test validation.
 */

export function buildFeatureBenchPrompt(opts: {
  instanceId: string
  repo: string
  featureDescription: string
}): string {
  const { instanceId, repo, featureDescription } = opts
  return [
    `You are an expert software engineer. Implement the feature described below in the **${repo}** repository.`,
    '',
    '## Feature Request',
    '',
    featureDescription,
    '',
    '## Approach',
    '',
    '### 1. Explore',
    'Understand the repository structure and relevant code before writing anything.',
    '- Use `exec` to run shell commands (ls, find, rg) and understand the project layout.',
    '- Use `search` or `exec` to find related classes, functions, APIs, and patterns.',
    '- Read existing code to understand conventions, data flow, and architecture.',
    '- Look at existing tests to understand the testing patterns and framework used.',
    '',
    '### 2. Plan',
    'Design your implementation before writing code.',
    '- Identify which files need to be modified or created.',
    '- Understand how the new feature fits into the existing architecture.',
    '- Consider edge cases and how existing functionality should be preserved.',
    '',
    '### 3. Implement',
    'Write clean, well-structured code that follows the repository\'s conventions.',
    '- Use `edit_file` to modify existing files. Create new files only when necessary.',
    '- Follow the coding style, naming conventions, and patterns already in the codebase.',
    '- Implement the feature completely — partial implementations will not pass tests.',
    '- Do not add unnecessary comments explaining your changes.',
    '',
    '### 4. Verify',
    'Run the test suite to confirm your implementation works and nothing is broken.',
    '- Look for test configuration: `pytest.ini`, `setup.py`, `setup.cfg`, `tox.ini`, `Makefile`, `package.json`.',
    '- Run relevant tests (e.g., `exec("python -m pytest tests/ -x")` or `exec("npm test")`).',
    '- If tests fail, read the failure output, fix your code, and re-run.',
    '- Ensure both new feature tests AND existing tests pass.',
    '',
    '## Constraints',
    '',
    '- Implement the feature as described — do not take shortcuts.',
    '- Follow existing patterns and conventions in the codebase.',
    '- Do NOT run `pip install` or modify dependencies unless the feature explicitly requires it.',
    '- Do NOT modify test files.',
    '- Do NOT run git commands.',
    `- Instance ID: ${instanceId}`,
  ].join('\n')
}
