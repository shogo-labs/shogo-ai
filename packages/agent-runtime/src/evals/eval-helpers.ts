// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared validation helpers for eval test cases.
 *
 * Centralised so every test-cases-*.ts file imports from one place
 * rather than re-declaring the same helpers.
 */

import type { EvalResult } from './types'

/** True if `toolName` was called in any turn (history + final). */
export function usedTool(result: EvalResult, toolName: string): boolean {
  return result.toolCalls.some(t => t.name === toolName)
}

/** True if `toolName` was called in the final evaluated turn only. */
export function usedToolInFinalTurn(result: EvalResult, toolName: string): boolean {
  return result.finalTurnToolCalls.some(t => t.name === toolName)
}

/** True if `toolName` was NOT called in any turn. */
export function neverUsedTool(result: EvalResult, toolName: string): boolean {
  return !result.toolCalls.some(t => t.name === toolName)
}

/** True if `toolName` was NOT called in the final turn. */
export function didNotUseToolInFinalTurn(result: EvalResult, toolName: string): boolean {
  return !result.finalTurnToolCalls.some(t => t.name === toolName)
}

/** Count of calls to `toolName` across all turns. */
export function toolCallCount(result: EvalResult, toolName: string): number {
  return result.toolCalls.filter(t => t.name === toolName).length
}

/** True if the agent's response text contains every one of `terms` (case-insensitive). */
export function responseContains(result: EvalResult, ...terms: string[]): boolean {
  const text = result.responseText.toLowerCase()
  return terms.every(t => text.includes(t.toLowerCase()))
}

/** JSON-stringified tool calls for ad-hoc substring searches. */
export function toolCallsJson(result: EvalResult): string {
  return JSON.stringify(result.toolCalls).toLowerCase()
}

/** True if any call to `toolName` has `value` anywhere in its JSON-serialised input. */
export function toolCallArgsContain(result: EvalResult, toolName: string, value: string): boolean {
  return result.toolCalls
    .filter(t => t.name === toolName)
    .some(t => JSON.stringify(t.input).toLowerCase().includes(value.toLowerCase()))
}

/** True if `toolName` was called and succeeded (not an error) at least once. */
export function usedToolSuccessfully(result: EvalResult, toolName: string): boolean {
  return result.toolCalls.some(t => t.name === toolName && !t.error)
}

/** Count of successful (non-error) calls to `toolName` across all turns. */
export function successfulToolCallCount(result: EvalResult, toolName: string): number {
  return result.toolCalls.filter(t => t.name === toolName && !t.error).length
}

/** True if any tool_install call was made without `command` or `args` (i.e. managed-style name-only install). */
export function installCalledWithoutCommand(result: EvalResult): boolean {
  return result.toolCalls
    .filter(t => t.name === 'tool_install')
    .some(t => {
      const input = t.input as Record<string, any>
      return !input.command && !input.args
    })
}

/** True if any `exec` tool call has a `command` input containing `substring` (case-insensitive). */
export function execCommandContains(result: EvalResult, substring: string): boolean {
  return result.toolCalls
    .filter(t => t.name === 'exec')
    .some(t => {
      const input = t.input as Record<string, any>
      return typeof input.command === 'string' &&
        input.command.toLowerCase().includes(substring.toLowerCase())
    })
}

/** True if any `write_file` tool call targets `.env` and its content contains `key`. */
export function wroteEnvFile(result: EvalResult, key: string): boolean {
  return result.toolCalls
    .filter(t => t.name === 'write_file')
    .some(t => {
      const input = t.input as Record<string, any>
      const path = typeof input.path === 'string' ? input.path : ''
      const content = typeof input.content === 'string' ? input.content : ''
      return (path === '.env' || path.endsWith('/.env')) && content.includes(key)
    })
}
