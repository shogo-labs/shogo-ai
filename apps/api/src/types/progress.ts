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
