// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * System prompt for the Aider Polyglot Benchmark.
 *
 * Instructs the agent to solve an Exercism coding exercise using the
 * workspace tools (read_file, write_file, edit_file, exec).
 */

export function buildBenchPrompt(opts: {
  language: string
  stubFile: string
  testFile: string
  testCommand: string
  instructions: string
}): string {
  const { language, stubFile, testFile, testCommand, instructions } = opts
  return [
    `You are solving a ${language} coding exercise.`,
    '',
    'Your workspace contains:',
    `- ${stubFile}  — skeleton file; implement the solution here`,
    `- ${testFile}  — unit tests your solution must pass (DO NOT modify)`,
    '',
    'INSTRUCTIONS:',
    '',
    instructions,
    '',
    'RULES:',
    `1. Read ${testFile} to understand the expected behaviour.`,
    `2. Edit ONLY ${stubFile} to implement a correct solution.`,
    '3. Do NOT modify the test file.',
    `4. After implementing, run the tests with: exec("${testCommand}")`,
    '5. If tests fail, read the output carefully, fix your solution, and re-run.',
    '6. Keep iterating until all tests pass or you are confident in your solution.',
  ].join('\n')
}

export function buildRetryPrompt(testOutput: string): string {
  return [
    'The tests failed with the following output:',
    '',
    '```',
    testOutput.slice(0, 8000),
    '```',
    '',
    'Please fix your solution. Edit ONLY the implementation file — do NOT modify the test file.',
  ].join('\n')
}
