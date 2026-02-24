/**
 * Shared chat message helpers.
 *
 * Platform-independent utilities for parsing and formatting chat messages.
 * Used by both web and mobile chat implementations.
 */

/**
 * Extract text content from a UIMessage.
 * Handles both legacy content-string format and v3 parts-array format.
 */
export function extractTextContent(message: { parts?: Array<{ type: string; text?: string }>; content?: string }): string {
  if (typeof message.content === 'string' && message.content) {
    return message.content
  }

  if (Array.isArray(message.parts)) {
    return message.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text || '')
      .join('')
  }

  return ''
}

/**
 * Friendly error code mapping for chat errors.
 */
export const ERROR_CODE_MESSAGES: Record<string, string> = {
  pod_unavailable: "We're having trouble starting your project environment. Please try again in a moment.",
  rate_limit_exceeded: "You're sending messages too quickly. Please wait a moment and try again.",
  insufficient_credits: "You've run out of credits. Please upgrade your plan to continue.",
  session_expired: 'Your session has expired. Please refresh the page.',
  internal_error: 'Something went wrong on our end. Please try again.',
}

/**
 * Parse potentially JSON error messages into user-friendly text.
 */
export function formatErrorMessage(rawMessage: string): string {
  try {
    const parsed = JSON.parse(rawMessage)
    if (parsed?.error?.code && ERROR_CODE_MESSAGES[parsed.error.code]) {
      return ERROR_CODE_MESSAGES[parsed.error.code]
    }
    if (parsed?.error?.message) {
      return parsed.error.message
    }
    if (parsed?.message) {
      return parsed.message
    }
  } catch {
    // Not JSON
  }
  return rawMessage
}

/**
 * Format MCP tool names for display.
 * e.g., mcp__shogo__store_query -> shogo.store_query
 */
export function formatToolName(name: string): string {
  if (name.startsWith('mcp__')) {
    const parts = name.replace('mcp__', '').split('__')
    return parts.join('.')
  }
  return name
}

/**
 * Categorize a tool name for styling purposes.
 */
export function getToolCategory(name: string): 'mcp' | 'file' | 'skill' | 'other' {
  if (name.startsWith('mcp__')) return 'mcp'
  if (['Read', 'Write', 'Edit', 'Glob', 'Grep'].includes(name)) return 'file'
  if (['Skill', 'Task'].includes(name)) return 'skill'
  return 'other'
}
