// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Prompt builder for Terminal-Bench 2.0.
 *
 * Terminal-Bench tasks are real-world CLI/terminal tasks (compiling code,
 * debugging, system administration, security) that the agent must solve
 * by executing terminal commands in an isolated Docker environment.
 */

export function buildTerminalBenchPrompt(opts: {
  taskId: string
  description: string
  category?: string
}): string {
  const { taskId, description, category } = opts

  return [
    `You are an expert systems engineer. Complete the following terminal task.`,
    '',
    '## Task',
    '',
    description,
    '',
    '## Instructions',
    '',
    '1. Start by understanding the current state of the environment:',
    '   - Run `ls`, `pwd`, `whoami` to orient yourself.',
    '   - Check system info with `uname -a`, installed packages, etc.',
    '2. Plan your approach before making changes.',
    '3. Execute commands step-by-step using `exec`.',
    '4. After each command, inspect the output carefully before proceeding.',
    '5. If something fails, read error messages and debug systematically.',
    '',
    '## Constraints',
    '',
    '- Use only terminal commands via `exec`. Do not use `edit_file` unless explicitly needed.',
    '- Do not install packages unless the task requires it.',
    '- Work within the existing environment — do not change fundamental system configuration.',
    '- Complete the task fully. Partial completion does not count.',
    '',
    `Task ID: ${taskId}${category ? ` | Category: ${category}` : ''}`,
  ].join('\n')
}
