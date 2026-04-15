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

/** True if `toolName` was NOT called in any turn (including via subagents). */
export function neverUsedTool(result: EvalResult, toolName: string): boolean {
  return !result.toolCalls.some(t => t.name === toolName)
}

/**
 * True if `toolName` was called anywhere — directly by the main agent OR
 * inside a subagent (flattened by runner.ts). Equivalent to usedTool() after
 * subagent tool call flattening, but semantically clearer for delegated tools.
 */
export function usedToolAnywhere(result: EvalResult, toolName: string): boolean {
  return result.toolCalls.some(t => t.name === toolName)
}

/** True if the agent delegated to a specific subagent type via agent_spawn. */
export function delegatedTo(result: EvalResult, subagentType: string): boolean {
  return result.toolCalls.some(t =>
    t.name === 'agent_spawn' &&
    typeof t.input === 'object' && t.input !== null &&
    (t.input as Record<string, unknown>).type === subagentType,
  )
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

// ---------------------------------------------------------------------------
// Skill server exec validation
// ---------------------------------------------------------------------------

interface ExecCallInfo {
  command: string
  stdout: string
  exitCode: number
}

/** Extract all exec tool calls that target the local skill server. */
export function execCallsToSkillServer(result: EvalResult): ExecCallInfo[] {
  return result.toolCalls
    .filter(t => t.name === 'exec')
    .map(t => {
      const output = t.output as any
      const input = t.input as any
      const command = typeof input?.command === 'string' ? input.command : ''
      const stdout = output?.details?.stdout ?? output?.stdout ?? ''
      const exitCode = output?.details?.exitCode ?? output?.exitCode ?? 1
      return { command, stdout: String(stdout), exitCode: Number(exitCode) }
    })
    .filter(o =>
      o.command.includes('localhost:4100') ||
      o.command.includes('127.0.0.1:4100') ||
      o.stdout.includes('localhost:4100') ||
      o.stdout.includes('127.0.0.1:4100')
    )
}

/** True if the agent made at least one exec call to the skill server that returned valid data. */
export function anyExecToSkillServerSucceeded(result: EvalResult): boolean {
  const calls = execCallsToSkillServer(result)
  if (calls.length === 0) return true
  return calls.some(c =>
    c.exitCode === 0 &&
    !c.stdout.includes('ENOENT') &&
    !c.stdout.includes('404 Not Found') &&
    !c.stdout.includes('Cannot connect')
  )
}

/** True if the agent's last exec call to the skill server did not return an error. */
export function lastSkillServerExecSucceeded(result: EvalResult): boolean {
  const calls = execCallsToSkillServer(result)
  if (calls.length === 0) return true
  const last = calls[calls.length - 1]
  return last.exitCode === 0 &&
    !last.stdout.includes('ENOENT') &&
    !last.stdout.includes('404 Not Found') &&
    !last.stdout.includes('Cannot connect')
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

/**
 * True if the last schema write in this eval still contains `modelName`.
 * Returns true when no schema was written (prior models are untouched on disk).
 */
export function lastSchemaPreservesModel(result: EvalResult, modelName: string): boolean {
  const schemaWrites = result.toolCalls
    .filter(t => t.name === 'write_file')
    .filter(t => String((t.input as any).path ?? '').includes('schema.prisma'))
  if (schemaWrites.length === 0) return true
  const last = schemaWrites[schemaWrites.length - 1]
  const content = String((last.input as any).content ?? '')
  return content.includes(`model ${modelName}`)
}
