// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * @shogo-ai/sdk/agent
 *
 * First-class agent connection module. Provides a typed client and React hooks
 * for communicating with a Shogo agent runtime — status, chat, workspace
 * files, and mode control.
 *
 * Apps built on Shogo run on the same pod as their agent, so the client defaults
 * to relative URLs with zero configuration.
 *
 * @example
 * ```typescript
 * import { AgentClient } from '@shogo-ai/sdk/agent'
 *
 * const agent = new AgentClient()
 * const status = await agent.getStatus()
 * ```
 *
 * @example React hooks
 * ```typescript
 * import { useAgentStatus, useAgentChat } from '@shogo-ai/sdk/agent'
 *
 * function Dashboard() {
 *   const { status } = useAgentStatus({ pollInterval: 5000 })
 *   const { messages, send, isStreaming } = useAgentChat()
 *   // ...
 * }
 * ```
 */

// Client
export { AgentClient, getAgentClient } from './client.js'
export type { WorkspaceEvent } from './client.js'

// React hooks
export {
  useAgentStatus,
  useAgentChat,
  useAgentMode,
  useAgentFiles,
} from './hooks.js'

// Types
export type {
  AgentClientConfig,
  AgentExportBundle,
  AgentImportResult,
  AgentPlanSummary,
  AgentStatus,
  ChatMessage,
  ChatMessagePart,
  ChatOptions,
  ChatStreamEvent,
  FileNode,
  SearchResult,
  VisualMode,
  WorkspaceBundle,
} from './types.js'

// Hook result types
export type {
  UseAgentStatusOptions,
  UseAgentStatusResult,
  UseAgentChatOptions,
  UseAgentChatResult,
  UseAgentModeOptions,
  UseAgentModeResult,
  UseAgentFilesOptions,
  UseAgentFilesResult,
} from './hooks.js'
