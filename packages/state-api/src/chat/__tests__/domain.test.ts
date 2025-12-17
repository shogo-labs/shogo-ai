/**
 * Generated from TestSpecifications for task-chat-domain-store
 * Task: chat-domain-store
 * Description: Create chat domain store with domain() API for persistent chat sessions
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { ChatDomain, chatDomain } from "../domain"
import { NullPersistence } from "../../persistence/null"
import type { IEnvironment } from "../../environment/types"

// Helper to create a test environment
function createTestEnv(): IEnvironment {
  return {
    services: {
      persistence: new NullPersistence(),
      backendRegistry: {
        register: () => {},
        get: () => undefined,
        has: () => false,
        resolve: () => { throw new Error("No backend configured") },
        setDefault: () => {},
      } as any,
    },
    context: {
      schemaName: "ai-sdk-chat",
    },
  }
}

// ============================================================
// Test 1: ChatDomain ArkType scope exports correctly
// ============================================================
describe("ChatDomain ArkType scope exports correctly", () => {
  test("Scope includes ChatSession entity", () => {
    expect(ChatDomain).toBeDefined()
    const types = ChatDomain.export()
    expect(types.ChatSession).toBeDefined()
  })

  test("Scope includes ChatMessage entity", () => {
    const types = ChatDomain.export()
    expect(types.ChatMessage).toBeDefined()
  })

  test("Scope includes CreatedArtifact entity", () => {
    const types = ChatDomain.export()
    expect(types.CreatedArtifact).toBeDefined()
  })
})

// ============================================================
// Test 2: ChatSession entity has correct fields
// ============================================================
describe("ChatSession entity has correct fields", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = chatDomain.createStore(env)
  })

  test("ChatSession has id, name, status, createdAt fields", () => {
    const session = store.chatSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test Session",
      status: "active",
      createdAt: Date.now(),
    })

    expect(session.id).toBe("550e8400-e29b-41d4-a716-446655440001")
    expect(session.name).toBe("Test Session")
    expect(session.status).toBe("active")
    expect(session.createdAt).toBeDefined()
  })

  test("ChatSession supports optional claudeSessionId field", () => {
    const session = store.chatSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test Session",
      claudeSessionId: "claude-abc-123",
      status: "active",
      createdAt: Date.now(),
    })

    expect(session.claudeSessionId).toBe("claude-abc-123")
  })

  test("ChatSession supports optional updatedAt field", () => {
    const now = Date.now()
    const session = store.chatSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test Session",
      status: "active",
      createdAt: now,
      updatedAt: now + 1000,
    })

    expect(session.updatedAt).toBe(now + 1000)
  })

  test("ChatSession status accepts active, completed, error values", () => {
    const session1 = store.chatSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Active Session",
      status: "active",
      createdAt: Date.now(),
    })
    expect(session1.status).toBe("active")

    const session2 = store.chatSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Completed Session",
      status: "completed",
      createdAt: Date.now(),
    })
    expect(session2.status).toBe("completed")

    const session3 = store.chatSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440003",
      name: "Error Session",
      status: "error",
      createdAt: Date.now(),
    })
    expect(session3.status).toBe("error")
  })
})

// ============================================================
// Test 3: ChatMessage entity with session reference
// ============================================================
describe("ChatMessage entity with session reference", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = chatDomain.createStore(env)
  })

  test("ChatMessage reference resolves to ChatSession instance", () => {
    const session = store.chatSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test Session",
      status: "active",
      createdAt: Date.now(),
    })

    const message = store.chatMessageCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      session: session.id,
      role: "user",
      content: "Hello, Claude!",
      createdAt: Date.now(),
    })

    // Reference should resolve to the actual ChatSession instance
    expect(message.session).toBe(session)
    expect(message.session.name).toBe("Test Session")
  })

  test("ChatMessage has correct role values (user, assistant)", () => {
    const session = store.chatSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test Session",
      status: "active",
      createdAt: Date.now(),
    })

    const userMessage = store.chatMessageCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      session: session.id,
      role: "user",
      content: "Hello",
      createdAt: Date.now(),
    })
    expect(userMessage.role).toBe("user")

    const assistantMessage = store.chatMessageCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      session: session.id,
      role: "assistant",
      content: "Hi there!",
      createdAt: Date.now(),
    })
    expect(assistantMessage.role).toBe("assistant")
  })

  test("ChatMessage supports optional toolCalls array", () => {
    const session = store.chatSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test Session",
      status: "active",
      createdAt: Date.now(),
    })

    const message = store.chatMessageCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      session: session.id,
      role: "assistant",
      content: "Let me help you with that",
      toolCalls: [{ tool: "search", args: { query: "test" } }],
      createdAt: Date.now(),
    })

    expect(message.toolCalls).toBeDefined()
    expect(Array.isArray(message.toolCalls)).toBe(true)
  })
})

// ============================================================
// Test 4: CreatedArtifact entity with session reference
// ============================================================
describe("CreatedArtifact entity with session reference", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = chatDomain.createStore(env)
  })

  test("CreatedArtifact reference resolves to ChatSession instance", () => {
    const session = store.chatSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test Session",
      status: "active",
      createdAt: Date.now(),
    })

    const artifact = store.createdArtifactCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440020",
      session: session.id,
      artifactType: "schema",
      artifactName: "user-schema",
      toolName: "schema.set",
      createdAt: Date.now(),
    })

    // Reference should resolve to the actual ChatSession instance
    expect(artifact.session).toBe(session)
    expect(artifact.session.name).toBe("Test Session")
  })

  test("CreatedArtifact has correct artifactType values", () => {
    const session = store.chatSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test Session",
      status: "active",
      createdAt: Date.now(),
    })

    const schema = store.createdArtifactCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440020",
      session: session.id,
      artifactType: "schema",
      artifactName: "test-schema",
      toolName: "schema.set",
      createdAt: Date.now(),
    })
    expect(schema.artifactType).toBe("schema")

    const entity = store.createdArtifactCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440021",
      session: session.id,
      artifactType: "entity",
      artifactName: "test-entity",
      toolName: "store.create",
      createdAt: Date.now(),
    })
    expect(entity.artifactType).toBe("entity")

    const other = store.createdArtifactCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440022",
      session: session.id,
      artifactType: "other",
      artifactName: "test-file",
      toolName: "custom",
      createdAt: Date.now(),
    })
    expect(other.artifactType).toBe("other")
  })
})

// ============================================================
// Test 5: ChatSession.messageCount computed view
// ============================================================
describe("ChatSession.messageCount computed view", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = chatDomain.createStore(env)
  })

  test("Returns 0 for session with no messages", () => {
    const session = store.chatSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test Session",
      status: "active",
      createdAt: Date.now(),
    })

    expect(session.messageCount).toBe(0)
  })

  test("Returns correct count for session with multiple messages", () => {
    const session = store.chatSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test Session",
      status: "active",
      createdAt: Date.now(),
    })

    store.chatMessageCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      session: session.id,
      role: "user",
      content: "Message 1",
      createdAt: Date.now(),
    })

    store.chatMessageCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      session: session.id,
      role: "assistant",
      content: "Message 2",
      createdAt: Date.now(),
    })

    store.chatMessageCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440012",
      session: session.id,
      role: "user",
      content: "Message 3",
      createdAt: Date.now(),
    })

    expect(session.messageCount).toBe(3)
  })

  test("Count updates reactively when messages are added", () => {
    const session = store.chatSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test Session",
      status: "active",
      createdAt: Date.now(),
    })

    expect(session.messageCount).toBe(0)

    store.chatMessageCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      session: session.id,
      role: "user",
      content: "New message",
      createdAt: Date.now(),
    })

    expect(session.messageCount).toBe(1)
  })
})

// ============================================================
// Test 6: ChatSession.latestMessage computed view
// ============================================================
describe("ChatSession.latestMessage computed view", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = chatDomain.createStore(env)
  })

  test("Returns undefined for session with no messages", () => {
    const session = store.chatSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test Session",
      status: "active",
      createdAt: Date.now(),
    })

    expect(session.latestMessage).toBeUndefined()
  })

  test("Returns most recent message by createdAt", () => {
    const session = store.chatSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test Session",
      status: "active",
      createdAt: Date.now(),
    })

    const now = Date.now()

    store.chatMessageCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      session: session.id,
      role: "user",
      content: "First message",
      createdAt: now,
    })

    store.chatMessageCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      session: session.id,
      role: "assistant",
      content: "Second message",
      createdAt: now + 1000,
    })

    const latest = store.chatMessageCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440012",
      session: session.id,
      role: "user",
      content: "Latest message",
      createdAt: now + 2000,
    })

    expect(session.latestMessage).toBe(latest)
    expect(session.latestMessage.content).toBe("Latest message")
  })
})

// ============================================================
// Test 7: chatSessionCollection.findByStatus query method
// ============================================================
describe("chatSessionCollection.findByStatus query method", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = chatDomain.createStore(env)
  })

  test("Returns only sessions with matching status", () => {
    store.chatSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Active 1",
      status: "active",
      createdAt: Date.now(),
    })

    store.chatSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Active 2",
      status: "active",
      createdAt: Date.now(),
    })

    store.chatSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440003",
      name: "Completed 1",
      status: "completed",
      createdAt: Date.now(),
    })

    const activeSessions = store.chatSessionCollection.findByStatus("active")
    expect(activeSessions).toHaveLength(2)
    expect(activeSessions.every((s: any) => s.status === "active")).toBe(true)
  })

  test("Returns empty array when no sessions match status", () => {
    store.chatSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Active 1",
      status: "active",
      createdAt: Date.now(),
    })

    const errorSessions = store.chatSessionCollection.findByStatus("error")
    expect(errorSessions).toHaveLength(0)
  })
})

// ============================================================
// Test 8: createChatSession root store action
// ============================================================
describe("createChatSession root store action", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = chatDomain.createStore(env)
  })

  test("Creates new chat session with generated ID", () => {
    const session = store.createChatSession({
      name: "New Chat",
      claudeSessionId: "claude-123",
    })

    expect(session).toBeDefined()
    expect(session.id).toBeDefined()
    expect(session.name).toBe("New Chat")
    expect(session.claudeSessionId).toBe("claude-123")
    expect(session.status).toBe("active")
    expect(session.createdAt).toBeDefined()
  })

  test("Session is added to collection automatically", () => {
    const session = store.createChatSession({
      name: "New Chat",
    })

    const retrieved = store.chatSessionCollection.get(session.id)
    expect(retrieved).toBe(session)
  })

  test("Defaults status to active if not provided", () => {
    const session = store.createChatSession({
      name: "Default Status Chat",
    })

    expect(session.status).toBe("active")
  })
})

// ============================================================
// Test 9: recordArtifact root store action
// ============================================================
describe("recordArtifact root store action", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = chatDomain.createStore(env)
  })

  test("Records artifact for session", () => {
    const session = store.createChatSession({
      name: "Test Session",
    })

    const artifact = store.recordArtifact({
      sessionId: session.id,
      artifactType: "schema",
      artifactName: "user-schema",
      toolName: "schema.set",
    })

    expect(artifact).toBeDefined()
    expect(artifact.id).toBeDefined()
    expect(artifact.session).toBe(session)
    expect(artifact.artifactType).toBe("schema")
    expect(artifact.artifactName).toBe("user-schema")
    expect(artifact.toolName).toBe("schema.set")
  })

  test("Artifact is added to collection automatically", () => {
    const session = store.createChatSession({
      name: "Test Session",
    })

    const artifact = store.recordArtifact({
      sessionId: session.id,
      artifactType: "entity",
      artifactName: "test-entity",
      toolName: "store.create",
    })

    const retrieved = store.createdArtifactCollection.get(artifact.id)
    expect(retrieved).toBe(artifact)
  })
})

// ============================================================
// Test 10: domain.name matches schema name exactly
// ============================================================
describe("domain.name matches schema name exactly", () => {
  test("chatDomain.name equals 'ai-sdk-chat'", () => {
    expect(chatDomain.name).toBe("ai-sdk-chat")
  })

  test("Domain can create store successfully", () => {
    const env = createTestEnv()
    const store = chatDomain.createStore(env)

    expect(store).toBeDefined()
    expect(store.chatSessionCollection).toBeDefined()
    expect(store.chatMessageCollection).toBeDefined()
    expect(store.createdArtifactCollection).toBeDefined()
  })

  test("Domain exports RootStoreModel", () => {
    expect(chatDomain.RootStoreModel).toBeDefined()
  })

  test("Domain exports models record", () => {
    expect(chatDomain.models).toBeDefined()
    expect(chatDomain.models.ChatSession).toBeDefined()
    expect(chatDomain.models.ChatMessage).toBeDefined()
    expect(chatDomain.models.CreatedArtifact).toBeDefined()
  })
})
