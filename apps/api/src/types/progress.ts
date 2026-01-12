/**
 * Progress event types for subagent streaming
 * Task: task-subagent-progress-streaming
 *
 * These types define the shape of progress events emitted by Claude Agent SDK
 * hooks and streamed to the client via SSE data-progress parts.
 */

export type SubagentProgressEvent =
  | {
      type: 'subagent-start'
      agentId: string
      agentType: string
      timestamp: number
    }
  | {
      type: 'subagent-stop'
      agentId: string
      timestamp: number
    }
  | {
      type: 'tool-complete'
      toolName: string
      toolUseId: string
      timestamp: number
    }

/**
 * Virtual Tool event types for client-side execution
 * Task: virtual-tools-domain Phase 0 PoC
 *
 * Virtual tools are intercepted server-side via PreToolUse hook and
 * streamed to the client for execution rather than routing to MCP.
 */
export interface VirtualToolEvent {
  type: 'virtual-tool-execute'
  /** Unique ID for this tool invocation */
  toolUseId: string
  /** Virtual tool name (e.g., 'navigate_to_phase') */
  toolName: string
  /** Tool arguments from Claude's invocation */
  args: Record<string, unknown>
  /** Timestamp of invocation */
  timestamp: number
}

/**
 * Known virtual tool names for type-safe checking.
 * Add new virtual tools here as they're implemented.
 */
export const VIRTUAL_TOOL_NAMES = [
  'navigate_to_phase',
] as const

export type VirtualToolName = typeof VIRTUAL_TOOL_NAMES[number]

/**
 * Check if a tool name is a virtual tool.
 */
export function isVirtualTool(toolName: string): toolName is VirtualToolName {
  return VIRTUAL_TOOL_NAMES.includes(toolName as VirtualToolName)
}
