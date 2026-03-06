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
 * Emitted when an integration tool encounters an access/auth/permission
 * error. The frontend shows a fixed summary toast with the toolkit name.
 */
export interface ToolAccessErrorEvent {
  toolName: string
  toolkitName: string
  toolUseId: string
}

/**
 * Access/auth/permission error patterns common across third-party APIs.
 * Only these trigger the toast — generic tool failures (bad input,
 * timeouts, rate limits) are left for the agent to handle inline.
 */
const ACCESS_ERROR_PATTERNS = [
  'not found',
  'resource not accessible',
  'unauthorized',
  'not authorized',
  'forbidden',
  'invalid_auth',
  'not_authed',
  'missing_scope',
  'token_revoked',
  'account_inactive',
  'authentication required',
  'insufficient authentication scopes',
  'access denied',
  'permission denied',
]

/**
 * Integration tools follow specific naming conventions:
 * Composio: GITHUB_LIST_ISSUES (UPPER_CASE with underscores)
 * MCP:      mcp__server__tool
 * Built-in tools (Read, Write, Bash, web, exec, etc.) don't match.
 */
export function isIntegrationTool(toolName: string): boolean {
  return /^[A-Z]+_/.test(toolName) || toolName.startsWith('mcp__')
}

/**
 * Check whether an error string indicates an access/auth/permission problem.
 */
export function isAccessError(errorText: string): boolean {
  const lower = errorText.toLowerCase()
  return ACCESS_ERROR_PATTERNS.some((p) => lower.includes(p))
}

/**
 * Extract a human-readable toolkit name from a tool slug.
 * Composio: GITHUB_LIST_ISSUES -> "Github"
 * MCP:      mcp__slack__send_message -> "Slack"
 */
export function extractToolkitName(toolName: string): string {
  if (toolName.startsWith('mcp__')) {
    const server = toolName.split('__')[1] || toolName
    return server.charAt(0).toUpperCase() + server.slice(1)
  }
  const prefix = toolName.split('_')[0]
  if (!prefix) return toolName
  return prefix.charAt(0).toUpperCase() + prefix.slice(1).toLowerCase()
}

/**
 * Extract an error string from a tool response.
 * Composio proxy tools return textResult({ error: "..." }) which the
 * SDK surfaces as a string or object in tool_response.
 */
export function extractErrorText(response: unknown): string | null {
  if (!response) return null
  if (typeof response === 'string') {
    try {
      const parsed = JSON.parse(response)
      if (parsed?.error) return String(parsed.error)
    } catch { /* not JSON */ }
    return null
  }
  if (typeof response === 'object' && response !== null) {
    const r = response as Record<string, unknown>
    if (r.error) return String(r.error)
  }
  return null
}

/**
 * Known virtual tool names for type-safe checking.
 * Add new virtual tools here as they're implemented.
 */
export const VIRTUAL_TOOL_NAMES = [
  'navigate_to_phase',
  'show_schema',
] as const

export type VirtualToolName = typeof VIRTUAL_TOOL_NAMES[number]

/**
 * Check if a tool name is a virtual tool.
 */
export function isVirtualTool(toolName: string): toolName is VirtualToolName {
  return VIRTUAL_TOOL_NAMES.includes(toolName as VirtualToolName)
}
