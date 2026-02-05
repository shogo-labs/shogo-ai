/**
 * Chat UI Module - Public API
 * Task: task-2-4-007 (barrel-exports)
 *
 * Complete barrel exports for the chat module.
 * Exports all public components, hooks, and types.
 *
 * Usage:
 *   import { ChatPanel, useChatContext, ChatContextProvider } from '@/components/app/chat'
 *   import type { ChatContextValue, ChatPanelProps } from '@/components/app/chat'
 */

// ============================================================================
// Smart Components
// ============================================================================

export { ChatPanel, type ChatPanelProps } from "./ChatPanel"

// ============================================================================
// Context & Hooks
// ============================================================================

export {
  ChatContextProvider,
  useChatContext,
  useChatContextSafe,
  type ChatContextValue,
} from "./ChatContext"

// ============================================================================
// Presentational Components
// ============================================================================

export { ChatMessage, type ChatMessageProps } from "./ChatMessage"
export { MessageList, type MessageListProps } from "./MessageList"
export { ToolCallDisplay, type ToolCallDisplayProps, type ToolCallState } from "./ToolCallDisplay"
export { ChatInput, type ChatInputProps, type AgentMode, type AgentModeConfig } from "./ChatInput"
export { ChatHeader, type ChatHeaderProps } from "./ChatHeader"
export { ChatSessionPicker, type ChatSessionPickerProps, type ChatSession, formatRelativeTime } from "./ChatSessionPicker"
export { ExpandTab, type ExpandTabProps } from "./ExpandTab"
