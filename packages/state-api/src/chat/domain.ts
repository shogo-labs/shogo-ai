/**
 * Chat Domain Store
 *
 * Uses the domain() composition API to define ChatSession, ChatMessage,
 * and CreatedArtifact entities with enhancement hooks for computed views
 * (messageCount, latestMessage, artifactCount), collection queries (findByStatus),
 * and root store actions (createChatSession, recordArtifact).
 *
 * Integrates with AI SDK chat feature for persistent conversation history.
 */

import { scope } from "arktype"
import { v4 as uuidv4 } from "uuid"
import { getRoot } from "mobx-state-tree"
import { domain } from "../domain"

// ============================================================
// 1. DOMAIN SCHEMA (ArkType)
// ============================================================

export const ChatDomain = scope({
  ChatSession: {
    id: "string",
    name: "string",
    "claudeSessionId?": "string", // Session ID from Claude for multi-turn
    "featureSessionId?": "string", // Links to platform-features FeatureSession
    status: "'active' | 'completed' | 'error'",
    createdAt: "number",
    "updatedAt?": "number",
  },

  ChatMessage: {
    id: "string",
    session: "ChatSession", // Reference to parent session
    role: "'user' | 'assistant'",
    content: "string",
    "toolCalls?": "unknown[]", // Array of tool call objects
    createdAt: "number",
  },

  CreatedArtifact: {
    id: "string",
    session: "ChatSession", // Reference to parent session
    artifactType: "'schema' | 'entity' | 'other'",
    artifactName: "string",
    toolName: "string", // Tool that created this artifact (e.g., schema_set)
    createdAt: "number",
  },
})

// ============================================================
// 2. DOMAIN DEFINITION WITH ENHANCEMENTS
// ============================================================

/**
 * Chat domain with all enhancements.
 * Registered in enhancement registry for meta-store integration.
 */
export const chatDomain = domain({
  name: "ai-sdk-chat", // Must match schema name exactly
  from: ChatDomain,
  enhancements: {
    // --------------------------------------------------------
    // models: Add computed views to individual entities
    // --------------------------------------------------------
    models: (models) => ({
      ...models,

      // ChatSession computed views
      ChatSession: models.ChatSession.views((self: any) => ({
        /**
         * Get count of messages in this session
         */
        get messageCount(): number {
          // Access root store through getRoot
          const root = getRoot(self) as any
          if (!root.chatMessageCollection) return 0
          return root.chatMessageCollection
            .all()
            .filter((m: any) => m.session?.id === self.id).length
        },

        /**
         * Get the latest message in this session
         */
        get latestMessage(): any | undefined {
          const root = getRoot(self) as any
          if (!root.chatMessageCollection) return undefined
          const messages = root.chatMessageCollection
            .all()
            .filter((m: any) => m.session?.id === self.id)
          if (messages.length === 0) return undefined
          return messages.reduce((latest: any, m: any) =>
            m.createdAt > latest.createdAt ? m : latest
          )
        },

        /**
         * Get count of artifacts created by this session
         */
        get artifactCount(): number {
          const root = getRoot(self) as any
          if (!root.createdArtifactCollection) return 0
          return root.createdArtifactCollection
            .all()
            .filter((a: any) => a.session?.id === self.id).length
        },
      })),
    }),

    // --------------------------------------------------------
    // collections: Add query methods (CollectionPersistable auto-composed)
    // --------------------------------------------------------
    collections: (collections) => ({
      ...collections,

      ChatSessionCollection: collections.ChatSessionCollection.views((self: any) => ({
        /**
         * Find all sessions with a given status
         */
        findByStatus(status: "active" | "completed" | "error"): any[] {
          return self.all().filter((s: any) => s.status === status)
        },

        /**
         * Find session by Claude session ID
         */
        findByClaudeSessionId(claudeSessionId: string): any | undefined {
          return self.all().find((s: any) => s.claudeSessionId === claudeSessionId)
        },

        /**
         * Find session by feature session ID
         */
        findByFeatureSessionId(featureSessionId: string): any | undefined {
          return self.all().find((s: any) => s.featureSessionId === featureSessionId)
        },
      })),

      ChatMessageCollection: collections.ChatMessageCollection.views((self: any) => ({
        /**
         * Get all messages for a session, ordered by createdAt
         */
        findBySession(sessionId: string): any[] {
          return self
            .all()
            .filter((m: any) => m.session?.id === sessionId)
            .sort((a: any, b: any) => a.createdAt - b.createdAt)
        },
      })),

      CreatedArtifactCollection: collections.CreatedArtifactCollection.views((self: any) => ({
        /**
         * Find all artifacts for a session
         */
        findBySession(sessionId: string): any[] {
          return self.all().filter((a: any) => a.session?.id === sessionId)
        },

        /**
         * Find all artifacts of a given type
         */
        findByType(artifactType: "schema" | "entity" | "other"): any[] {
          return self.all().filter((a: any) => a.artifactType === artifactType)
        },
      })),
    }),

    // --------------------------------------------------------
    // rootStore: Add domain actions
    // --------------------------------------------------------
    rootStore: (RootModel) =>
      RootModel.actions((self: any) => ({
        /**
         * Create a new chat session
         */
        createChatSession(params: { name: string; claudeSessionId?: string; featureSessionId?: string }) {
          const session = self.chatSessionCollection.add({
            id: uuidv4(),
            name: params.name,
            claudeSessionId: params.claudeSessionId,
            featureSessionId: params.featureSessionId,
            status: "active",
            createdAt: Date.now(),
          })
          return session
        },

        /**
         * Add a message to a session
         */
        addMessage(params: {
          sessionId: string
          role: "user" | "assistant"
          content: string
          toolCalls?: any[]
        }) {
          const message = self.chatMessageCollection.add({
            id: uuidv4(),
            session: params.sessionId,
            role: params.role,
            content: params.content,
            toolCalls: params.toolCalls,
            createdAt: Date.now(),
          })

          // Update session timestamp
          const session = self.chatSessionCollection.get(params.sessionId)
          if (session) {
            session.updatedAt = Date.now()
          }

          return message
        },

        /**
         * Record an artifact created during a chat session
         */
        recordArtifact(params: {
          sessionId: string
          artifactType: "schema" | "entity" | "other"
          artifactName: string
          toolName: string
        }) {
          const artifact = self.createdArtifactCollection.add({
            id: uuidv4(),
            session: params.sessionId,
            artifactType: params.artifactType,
            artifactName: params.artifactName,
            toolName: params.toolName,
            createdAt: Date.now(),
          })
          return artifact
        },

        /**
         * Update session status
         */
        updateSessionStatus(sessionId: string, status: "active" | "completed" | "error") {
          const session = self.chatSessionCollection.get(sessionId)
          if (session) {
            session.status = status
            session.updatedAt = Date.now()
          }
        },

        /**
         * Link Claude session ID to a chat session
         */
        linkClaudeSession(sessionId: string, claudeSessionId: string) {
          const session = self.chatSessionCollection.get(sessionId)
          if (session) {
            session.claudeSessionId = claudeSessionId
            session.updatedAt = Date.now()
          }
        },

        /**
         * Link feature session ID to a chat session
         */
        linkFeatureSession(sessionId: string, featureSessionId: string) {
          const session = self.chatSessionCollection.get(sessionId)
          if (session) {
            session.featureSessionId = featureSessionId
            session.updatedAt = Date.now()
          }
        },
      })),
  },
})

// ============================================================
// 3. BACKWARD-COMPATIBLE STORE FACTORY
// ============================================================

export interface CreateChatStoreOptions {
  /** Enable reference validation (default: true in dev) */
  validateReferences?: boolean
}

/**
 * Creates chat store with backward-compatible API.
 */
export function createChatStore(_options: CreateChatStoreOptions = {}) {
  return {
    createStore: chatDomain.createStore,
    RootStoreModel: chatDomain.RootStoreModel,
    domain: chatDomain,
  }
}
