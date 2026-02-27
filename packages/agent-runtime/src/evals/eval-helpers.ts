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

/** True if any mcp_install call was made without `command` or `args` (i.e. Composio-style name-only install). */
export function installCalledWithoutCommand(result: EvalResult): boolean {
  return result.toolCalls
    .filter(t => t.name === 'mcp_install')
    .some(t => {
      const input = t.input as Record<string, any>
      return !input.command && !input.args
    })
}
