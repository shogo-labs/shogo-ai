// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * @shogo-ai/sdk/agent
 *
 * First-class agent connection module. Provides a typed client and React hooks
 * for communicating with a Shogo agent runtime — status, chat, canvas streaming,
 * workspace files, and mode control.
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
 * import { useAgentStatus, useAgentChat, useCanvasStream } from '@shogo-ai/sdk/agent'
 *
 * function Dashboard() {
 *   const { status } = useAgentStatus({ pollInterval: 5000 })
 *   const { messages, send, isStreaming } = useAgentChat()
 *   const { surfaces, dispatchAction } = useCanvasStream()
 *   // ...
 * }
 * ```
 */

// Client
export { AgentClient, getAgentClient } from './client.js'

// React hooks
export {
  useAgentStatus,
  useAgentChat,
  useCanvasStream,
  useAgentMode,
  useAgentFiles,
} from './hooks.js'

// Types
export type {
  AgentClientConfig,
  AgentExportBundle,
  AgentImportResult,
  AgentStatus,
  ChatMessage,
  ChatMessagePart,
  ChatOptions,
  ChatStreamEvent,
  Surface,
  CanvasComponent,
  CanvasState,
  ActionContext,
  FileNode,
  SearchResult,
  VisualMode,
} from './types.js'

// Hook result types
export type {
  UseAgentStatusOptions,
  UseAgentStatusResult,
  UseAgentChatOptions,
  UseAgentChatResult,
  UseCanvasStreamOptions,
  UseCanvasStreamResult,
  UseAgentModeOptions,
  UseAgentModeResult,
  UseAgentFilesOptions,
  UseAgentFilesResult,
} from './hooks.js'
