/**
 * Chat Domain Module
 *
 * Public API for AI SDK chat with persistent conversation history.
 * Exports domain scope and store factory.
 */

// Domain scope and store factory
export { ChatDomain, chatDomain, createChatStore } from "./domain"

// Types
export type { CreateChatStoreOptions } from "./domain"
