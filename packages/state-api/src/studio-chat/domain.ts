/**
 * Studio Chat Domain Store
 *
 * Uses the domain() composition API to define ChatSession, ChatMessage,
 * and ToolCallLog entities with enhancement hooks for computed views,
 * collection queries, and polymorphic context validation.
 */

import { scope } from "arktype"
import { v4 as uuidv4 } from "uuid"
import { getRoot } from "mobx-state-tree"
import { domain } from "../domain"

// ============================================================
// 1. DOMAIN SCHEMA (ArkType)
// ============================================================

export const StudioChatDomain = scope({
  ChatSession: {
    id: "string.uuid",
    "name?": "string", // User-settable name
    inferredName: "string", // Auto-generated name
    contextType: "'feature' | 'project' | 'general'",
    "contextId?": "string", // Reference to FeatureSession or Project (cross-schema)
    "phase?": "string", // Optional phase association
    "claudeCodeSessionId?": "string", // Optional Claude Code session ID for continuity
    createdAt: "number",
    lastActiveAt: "number",
  },

  ChatMessage: {
    id: "string.uuid",
    session: "ChatSession", // Reference to ChatSession
    role: "'user' | 'assistant'",
    content: "string",
    "imageData?": "string", // Optional data URL for image attachments (data:image/{type};base64,{data})
    createdAt: "number",
  },

  ToolCallLog: {
    id: "string.uuid",
    chatSession: "ChatSession", // Reference to ChatSession
    "messageId?": "string", // Optional reference to message that triggered this
    toolName: "string",
    status: "'streaming' | 'executing' | 'complete' | 'error'",
    "args?": "unknown", // Tool arguments (any type)
    "result?": "unknown", // Tool result (any type)
    "duration?": "number", // Execution duration in ms
    createdAt: "number",
  },
})

// ============================================================
// 2. DOMAIN DEFINITION WITH ENHANCEMENTS
// ============================================================

/**
 * Studio Chat domain with all enhancements.
 */
export const studioChatDomain = domain({
  name: "studio-chat",
  from: StudioChatDomain,
  enhancements: {
    // --------------------------------------------------------
    // models: Add computed views to individual entities
    // --------------------------------------------------------
    models: (models) => ({
      ...models,

      ToolCallLog: models.ToolCallLog.views((self: any) => ({
        /**
         * Extract namespace from tool name (e.g., 'store' from 'store.create')
         */
        get toolNamespace(): string {
          const parts = self.toolName.split(".")
          return parts.length > 1 ? parts[0] : self.toolName
        },

        /**
         * Returns true when status is 'complete'
         */
        get isSuccess(): boolean {
          return self.status === "complete"
        },

        /**
         * Concise metadata string for collapsed view
         */
        get summaryLine(): string {
          const args = self.args as Record<string, unknown> | undefined
          const model = args?.model as string | undefined
          const schema = args?.schema as string | undefined

          if (model) return `${self.toolName}: ${model}`
          if (schema) return `${self.toolName}: ${schema}`
          return self.toolName
        },
      })),

      ChatMessage: models.ChatMessage.views((self: any) => ({
        /**
         * Returns true if this message has an attached image
         */
        get hasImage(): boolean {
          return self.imageData != null && self.imageData !== ""
        },
      })),

      ChatSession: models.ChatSession.views((self: any) => ({
        /**
         * Returns true if this session has an associated Claude Code session ID
         */
        get hasClaudeCodeSession(): boolean {
          return self.claudeCodeSessionId != null && self.claudeCodeSessionId !== ""
        },

        /**
         * Count of messages in this session
         */
        get messageCount(): number {
          const root = getRoot(self) as any
          return root.chatMessageCollection
            .all()
            .filter((m: any) => m.session?.id === self.id).length
        },

        /**
         * Most recent message by createdAt
         */
        get latestMessage(): any {
          const root = getRoot(self) as any
          const messages = root.chatMessageCollection
            .all()
            .filter((m: any) => m.session?.id === self.id)

          if (messages.length === 0) return undefined

          return messages.reduce((latest: any, current: any) =>
            current.createdAt > latest.createdAt ? current : latest
          )
        },

        /**
         * Count of tool calls in this session
         */
        get toolCallCount(): number {
          const root = getRoot(self) as any
          return root.toolCallLogCollection
            .all()
            .filter((tc: any) => tc.chatSession?.id === self.id).length
        },
      })),
    }),

    // --------------------------------------------------------
    // collections: Add query methods
    // --------------------------------------------------------
    collections: (collections) => ({
      ...collections,

      ChatSessionCollection: collections.ChatSessionCollection.views((self: any) => ({
        /**
         * Find sessions for a specific feature by contextId
         */
        findByFeature(featureId: string): any[] {
          return self
            .all()
            .filter(
              (s: any) => s.contextType === "feature" && s.contextId === featureId
            )
        },

        /**
         * Find session for specific feature and phase
         */
        findByFeatureAndPhase(featureId: string, phase: string): any {
          return self
            .all()
            .find(
              (s: any) =>
                s.contextType === "feature" &&
                s.contextId === featureId &&
                s.phase === phase
            ) ?? null
        },

        /**
         * Find all sessions of a given context type
         */
        findByContextType(contextType: "feature" | "project" | "general"): any[] {
          return self.all().filter((s: any) => s.contextType === contextType)
        },
      })),

      ChatMessageCollection: collections.ChatMessageCollection.views((self: any) => ({
        /**
         * Find all messages for a specific session
         */
        findBySession(sessionId: string): any[] {
          return self.all().filter((m: any) => m.session?.id === sessionId)
        },
      })),

      ToolCallLogCollection: collections.ToolCallLogCollection.views((self: any) => ({
        /**
         * Find tool calls by execution status
         */
        findByStatus(
          status: "streaming" | "executing" | "complete" | "error"
        ): any[] {
          return self.all().filter((tc: any) => tc.status === status)
        },
      })),
    }),

    // --------------------------------------------------------
    // rootStore: Add domain actions
    // --------------------------------------------------------
    rootStore: (RootModel) =>
      RootModel.actions((self: any) => ({
        /**
         * Create a chat session with context type validation.
         * - feature/project require contextId
         * - general must not have contextId
         *
         * Uses async insertOne for backend persistence.
         */
        async createChatSession(data: {
          name?: string
          inferredName: string
          contextType: "feature" | "project" | "general"
          contextId?: string
          phase?: string
        }): Promise<any> {
          // Validation: feature/project require contextId
          if (
            (data.contextType === "feature" || data.contextType === "project") &&
            !data.contextId
          ) {
            throw new Error(
              `contextId is required for contextType '${data.contextType}'`
            )
          }

          // Validation: general must not have contextId
          if (data.contextType === "general" && data.contextId) {
            throw new Error(
              `contextId is not allowed for contextType 'general'`
            )
          }

          const now = Date.now()
          return await self.chatSessionCollection.insertOne({
            id: uuidv4(),
            name: data.name,
            inferredName: data.inferredName,
            contextType: data.contextType,
            contextId: data.contextId,
            phase: data.phase,
            createdAt: now,
            lastActiveAt: now,
          })
        },

        /**
         * Add a message to a session and update lastActiveAt.
         *
         * Uses async insertOne for backend persistence.
         */
        async addMessage(data: {
          sessionId: string
          role: "user" | "assistant"
          content: string
          imageData?: string // Optional data URL for image attachments
        }): Promise<any> {
          const session = self.chatSessionCollection.get(data.sessionId)
          if (!session) {
            throw new Error(`ChatSession with id '${data.sessionId}' not found`)
          }

          const now = Date.now()

          // Update session's lastActiveAt using updateOne for backend persistence
          await self.chatSessionCollection.updateOne(data.sessionId, {
            lastActiveAt: now,
          })

          // Create the message using insertOne for backend persistence
          return await self.chatMessageCollection.insertOne({
            id: uuidv4(),
            session: data.sessionId,
            role: data.role,
            content: data.content,
            imageData: data.imageData,
            createdAt: now,
          })
        },

        /**
         * Record a tool call for a session.
         *
         * Uses async insertOne for backend persistence.
         */
        async recordToolCall(data: {
          sessionId: string
          messageId?: string
          toolName: string
          status: "streaming" | "executing" | "complete" | "error"
          args: unknown
          result?: unknown
          duration?: number
        }): Promise<any> {
          const session = self.chatSessionCollection.get(data.sessionId)
          if (!session) {
            throw new Error(`ChatSession with id '${data.sessionId}' not found`)
          }

          return await self.toolCallLogCollection.insertOne({
            id: uuidv4(),
            chatSession: data.sessionId,
            messageId: data.messageId,
            toolName: data.toolName,
            status: data.status,
            args: data.args,
            result: data.result,
            duration: data.duration,
            createdAt: Date.now(),
          })
        },
      })),
  },
})

// ============================================================
// 3. BACKWARD-COMPATIBLE STORE FACTORY
// ============================================================

/**
 * Creates studio-chat store with backward-compatible API.
 */
export function createStudioChatStore() {
  return {
    createStore: studioChatDomain.createStore,
    RootStoreModel: studioChatDomain.RootStoreModel,
    domain: studioChatDomain,
  }
}
