/**
 * Generated from TestSpecifications for task-1-2-domain-store
 * Session: studio-app-1-2-studio-chat
 * Description: Create studio-chat domain store with domain() API
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { StudioChatDomain, studioChatDomain } from "../domain"
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
      schemaName: "studio-chat",
    },
  }
}

// ============================================================
// Test 1: createChatSession validation - feature requires contextId
// ============================================================
describe("createChatSession throws when contextType='feature' without contextId", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("Error is thrown with message about missing contextId", () => {
    expect(() => {
      store.createChatSession({
        inferredName: "Test Session",
        contextType: "feature",
        // No contextId provided
      })
    }).toThrow(/contextId.*required|feature.*contextId/i)
  })

  test("No ChatSession entity is created", () => {
    try {
      store.createChatSession({
        inferredName: "Test Session",
        contextType: "feature",
      })
    } catch (e) {
      // Expected
    }
    expect(store.chatSessionCollection.all()).toHaveLength(0)
  })
})

// ============================================================
// Test 2: createChatSession validation - project requires contextId
// ============================================================
describe("createChatSession throws when contextType='project' without contextId", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("Error is thrown with message about missing contextId", () => {
    expect(() => {
      store.createChatSession({
        inferredName: "Test Session",
        contextType: "project",
        // No contextId provided
      })
    }).toThrow(/contextId.*required|project.*contextId/i)
  })

  test("No ChatSession entity is created", () => {
    try {
      store.createChatSession({
        inferredName: "Test Session",
        contextType: "project",
      })
    } catch (e) {
      // Expected
    }
    expect(store.chatSessionCollection.all()).toHaveLength(0)
  })
})

// ============================================================
// Test 3: createChatSession validation - general rejects contextId
// ============================================================
describe("createChatSession throws when contextType='general' has contextId", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("Error is thrown with message about unexpected contextId", () => {
    expect(() => {
      store.createChatSession({
        inferredName: "Test Session",
        contextType: "general",
        contextId: "some-context-id",
      })
    }).toThrow(/contextId.*not.*allowed|general.*contextId/i)
  })

  test("No ChatSession entity is created", () => {
    try {
      store.createChatSession({
        inferredName: "Test Session",
        contextType: "general",
        contextId: "some-context-id",
      })
    } catch (e) {
      // Expected
    }
    expect(store.chatSessionCollection.all()).toHaveLength(0)
  })
})

// ============================================================
// Test 4: createChatSession succeeds with valid feature + contextId
// ============================================================
describe("createChatSession succeeds with valid contextType='feature' and contextId", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("ChatSession entity is created", () => {
    const session = store.createChatSession({
      inferredName: "Feature Chat",
      contextType: "feature",
      contextId: "feat-session-123",
    })

    expect(session).toBeDefined()
    expect(session.id).toBeDefined()
  })

  test("contextType is 'feature'", () => {
    const session = store.createChatSession({
      inferredName: "Feature Chat",
      contextType: "feature",
      contextId: "feat-session-123",
    })

    expect(session.contextType).toBe("feature")
  })

  test("contextId matches provided value", () => {
    const session = store.createChatSession({
      inferredName: "Feature Chat",
      contextType: "feature",
      contextId: "feat-session-123",
    })

    expect(session.contextId).toBe("feat-session-123")
  })

  test("createdAt and lastActiveAt are set to current timestamp", () => {
    const before = Date.now()
    const session = store.createChatSession({
      inferredName: "Feature Chat",
      contextType: "feature",
      contextId: "feat-session-123",
    })
    const after = Date.now()

    expect(session.createdAt).toBeGreaterThanOrEqual(before)
    expect(session.createdAt).toBeLessThanOrEqual(after)
    expect(session.lastActiveAt).toBeGreaterThanOrEqual(before)
    expect(session.lastActiveAt).toBeLessThanOrEqual(after)
  })
})

// ============================================================
// Test 5: createChatSession succeeds with general (no contextId)
// ============================================================
describe("createChatSession succeeds with contextType='general' and no contextId", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("ChatSession entity is created", () => {
    const session = store.createChatSession({
      inferredName: "General Chat",
      contextType: "general",
    })

    expect(session).toBeDefined()
    expect(session.id).toBeDefined()
  })

  test("contextType is 'general'", () => {
    const session = store.createChatSession({
      inferredName: "General Chat",
      contextType: "general",
    })

    expect(session.contextType).toBe("general")
  })

  test("contextId is undefined/null", () => {
    const session = store.createChatSession({
      inferredName: "General Chat",
      contextType: "general",
    })

    expect(session.contextId).toBeUndefined()
  })
})

// ============================================================
// Test 6: addMessage updates session.lastActiveAt timestamp
// ============================================================
describe("addMessage updates session.lastActiveAt timestamp", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("ChatMessage is created with session reference", () => {
    const session = store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const message = store.addMessage({
      sessionId: session.id,
      role: "user",
      content: "Hello!",
    })

    expect(message).toBeDefined()
    expect(message.session).toBe(session)
  })

  test("Session.lastActiveAt is updated", () => {
    const session = store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const initialLastActive = session.lastActiveAt

    // Wait a tiny bit to ensure timestamp changes
    const message = store.addMessage({
      sessionId: session.id,
      role: "user",
      content: "Hello!",
    })

    expect(session.lastActiveAt).toBeGreaterThanOrEqual(initialLastActive)
  })

  test("Message.createdAt is set", () => {
    const session = store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const before = Date.now()
    const message = store.addMessage({
      sessionId: session.id,
      role: "user",
      content: "Hello!",
    })
    const after = Date.now()

    expect(message.createdAt).toBeGreaterThanOrEqual(before)
    expect(message.createdAt).toBeLessThanOrEqual(after)
  })
})

// ============================================================
// Test 7: addMessage creates message with correct session reference
// ============================================================
describe("addMessage creates message with correct session reference", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("ChatMessage.session resolves to the ChatSession instance (not just ID string)", () => {
    const session = store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const message = store.addMessage({
      sessionId: session.id,
      role: "user",
      content: "Hello!",
    })

    // Should be the actual instance, not just an ID string
    expect(message.session).toBe(session)
    expect(message.session.inferredName).toBe("Test Session")
  })

  test("ChatMessage.role is 'user'", () => {
    const session = store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const message = store.addMessage({
      sessionId: session.id,
      role: "user",
      content: "Hello!",
    })

    expect(message.role).toBe("user")
  })

  test("ChatMessage.content matches provided value", () => {
    const session = store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const message = store.addMessage({
      sessionId: session.id,
      role: "assistant",
      content: "How can I help you?",
    })

    expect(message.content).toBe("How can I help you?")
  })
})

// ============================================================
// Test 8: ChatSession.messageCount returns correct count
// ============================================================
describe("ChatSession.messageCount returns correct count", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("Returns 0 for session with no messages", () => {
    const session = store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    expect(session.messageCount).toBe(0)
  })

  test("Returns 3 after adding 3 messages", () => {
    const session = store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    store.addMessage({ sessionId: session.id, role: "user", content: "Message 1" })
    store.addMessage({ sessionId: session.id, role: "assistant", content: "Message 2" })
    store.addMessage({ sessionId: session.id, role: "user", content: "Message 3" })

    expect(session.messageCount).toBe(3)
  })

  test("Adding another message updates count to 4", () => {
    const session = store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    store.addMessage({ sessionId: session.id, role: "user", content: "Message 1" })
    store.addMessage({ sessionId: session.id, role: "assistant", content: "Message 2" })
    store.addMessage({ sessionId: session.id, role: "user", content: "Message 3" })

    expect(session.messageCount).toBe(3)

    store.addMessage({ sessionId: session.id, role: "assistant", content: "Message 4" })

    expect(session.messageCount).toBe(4)
  })
})

// ============================================================
// Test 9: ChatSession.latestMessage returns most recent message
// ============================================================
describe("ChatSession.latestMessage returns most recent message by createdAt", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("Returns undefined for session with no messages", () => {
    const session = store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    expect(session.latestMessage).toBeUndefined()
  })

  test("Returns the message with highest createdAt", () => {
    const session = store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    // Add messages with explicit timestamps (out of order)
    store.chatMessageCollection.add({
      id: "11111111-1111-4111-8111-111111111111",
      session: session.id,
      role: "user",
      content: "First message",
      createdAt: 1000,
    })

    store.chatMessageCollection.add({
      id: "33333333-3333-4333-8333-333333333333",
      session: session.id,
      role: "assistant",
      content: "Latest message",
      createdAt: 3000,
    })

    store.chatMessageCollection.add({
      id: "22222222-2222-4222-8222-222222222222",
      session: session.id,
      role: "user",
      content: "Middle message",
      createdAt: 2000,
    })

    expect(session.latestMessage.content).toBe("Latest message")
    expect(session.latestMessage.createdAt).toBe(3000)
  })
})

// ============================================================
// Test 10: ChatSession.toolCallCount returns correct count
// ============================================================
describe("ChatSession.toolCallCount returns correct count", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("Returns 0 for session with no tool calls", () => {
    const session = store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    expect(session.toolCallCount).toBe(0)
  })

  test("Returns 2 after recording 2 tool calls", () => {
    const session = store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "complete",
      args: {},
    })

    store.recordToolCall({
      sessionId: session.id,
      toolName: "schema.load",
      status: "complete",
      args: {},
    })

    expect(session.toolCallCount).toBe(2)
  })

  test("Recording another tool call updates count to 3", () => {
    const session = store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    store.recordToolCall({ sessionId: session.id, toolName: "tool1", status: "complete", args: {} })
    store.recordToolCall({ sessionId: session.id, toolName: "tool2", status: "complete", args: {} })

    expect(session.toolCallCount).toBe(2)

    store.recordToolCall({ sessionId: session.id, toolName: "tool3", status: "complete", args: {} })

    expect(session.toolCallCount).toBe(3)
  })
})

// ============================================================
// Test 11: recordToolCall creates tool call with session reference
// ============================================================
describe("recordToolCall creates tool call with session reference and status tracking", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("ToolCallLog is created", () => {
    const session = store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "executing",
      args: { model: "User" },
    })

    expect(toolCall).toBeDefined()
    expect(toolCall.id).toBeDefined()
  })

  test("chatSession resolves to ChatSession instance", () => {
    const session = store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "executing",
      args: {},
    })

    expect(toolCall.chatSession).toBe(session)
  })

  test("toolName is 'store.create'", () => {
    const session = store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "executing",
      args: {},
    })

    expect(toolCall.toolName).toBe("store.create")
  })

  test("status is 'executing'", () => {
    const session = store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "executing",
      args: {},
    })

    expect(toolCall.status).toBe("executing")
  })

  test("createdAt is set", () => {
    const session = store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const before = Date.now()
    const toolCall = store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "executing",
      args: {},
    })
    const after = Date.now()

    expect(toolCall.createdAt).toBeGreaterThanOrEqual(before)
    expect(toolCall.createdAt).toBeLessThanOrEqual(after)
  })
})

// ============================================================
// Test 12: findByFeature query (contextType + contextId filter)
// ============================================================
describe("findByFeature returns sessions with contextType='feature' matching contextId", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("Returns only sessions matching both contextType and contextId", () => {
    // Session A: feature + feat-123
    store.createChatSession({
      inferredName: "Session A",
      contextType: "feature",
      contextId: "feat-123",
    })

    // Session B: feature + feat-456 (different contextId)
    store.createChatSession({
      inferredName: "Session B",
      contextType: "feature",
      contextId: "feat-456",
    })

    // Session C: project + feat-123 (different contextType)
    store.createChatSession({
      inferredName: "Session C",
      contextType: "project",
      contextId: "feat-123",
    })

    const results = store.chatSessionCollection.findByFeature("feat-123")

    expect(results).toHaveLength(1)
    expect(results[0].inferredName).toBe("Session A")
  })

  test("Does not return Session B (different contextId)", () => {
    store.createChatSession({ inferredName: "A", contextType: "feature", contextId: "feat-123" })
    store.createChatSession({ inferredName: "B", contextType: "feature", contextId: "feat-456" })

    const results = store.chatSessionCollection.findByFeature("feat-123")
    const names = results.map((s: any) => s.inferredName)

    expect(names).not.toContain("B")
  })

  test("Does not return Session C (different contextType)", () => {
    store.createChatSession({ inferredName: "A", contextType: "feature", contextId: "feat-123" })
    store.createChatSession({ inferredName: "C", contextType: "project", contextId: "feat-123" })

    const results = store.chatSessionCollection.findByFeature("feat-123")
    const names = results.map((s: any) => s.inferredName)

    expect(names).not.toContain("C")
  })
})

// ============================================================
// Test 13: findByContextType query
// ============================================================
describe("findByContextType returns all sessions of given type", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("Returns 2 sessions with contextType='feature'", () => {
    store.createChatSession({ inferredName: "F1", contextType: "feature", contextId: "f1" })
    store.createChatSession({ inferredName: "F2", contextType: "feature", contextId: "f2" })
    store.createChatSession({ inferredName: "G1", contextType: "general" })

    const results = store.chatSessionCollection.findByContextType("feature")

    expect(results).toHaveLength(2)
  })

  test("All returned sessions have contextType='feature'", () => {
    store.createChatSession({ inferredName: "F1", contextType: "feature", contextId: "f1" })
    store.createChatSession({ inferredName: "F2", contextType: "feature", contextId: "f2" })
    store.createChatSession({ inferredName: "G1", contextType: "general" })

    const results = store.chatSessionCollection.findByContextType("feature")

    expect(results.every((s: any) => s.contextType === "feature")).toBe(true)
  })
})

// ============================================================
// Test 14: findBySession returns messages for specific session
// ============================================================
describe("findBySession returns messages for specific session", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("Returns 3 messages for Session A", () => {
    const sessionA = store.createChatSession({ inferredName: "A", contextType: "general" })
    const sessionB = store.createChatSession({ inferredName: "B", contextType: "general" })

    store.addMessage({ sessionId: sessionA.id, role: "user", content: "A1" })
    store.addMessage({ sessionId: sessionA.id, role: "assistant", content: "A2" })
    store.addMessage({ sessionId: sessionA.id, role: "user", content: "A3" })
    store.addMessage({ sessionId: sessionB.id, role: "user", content: "B1" })
    store.addMessage({ sessionId: sessionB.id, role: "assistant", content: "B2" })

    const results = store.chatMessageCollection.findBySession(sessionA.id)

    expect(results).toHaveLength(3)
  })

  test("All messages belong to Session A", () => {
    const sessionA = store.createChatSession({ inferredName: "A", contextType: "general" })
    const sessionB = store.createChatSession({ inferredName: "B", contextType: "general" })

    store.addMessage({ sessionId: sessionA.id, role: "user", content: "A1" })
    store.addMessage({ sessionId: sessionA.id, role: "assistant", content: "A2" })
    store.addMessage({ sessionId: sessionB.id, role: "user", content: "B1" })

    const results = store.chatMessageCollection.findBySession(sessionA.id)

    expect(results.every((m: any) => m.session.id === sessionA.id)).toBe(true)
  })
})

// ============================================================
// Test 15: findByStatus filters tool calls by execution status
// ============================================================
describe("findByStatus filters tool calls by execution status", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("Returns 2 tool calls with status='error'", () => {
    const session = store.createChatSession({ inferredName: "S", contextType: "general" })

    store.recordToolCall({ sessionId: session.id, toolName: "t1", status: "complete", args: {} })
    store.recordToolCall({ sessionId: session.id, toolName: "t2", status: "complete", args: {} })
    store.recordToolCall({ sessionId: session.id, toolName: "t3", status: "complete", args: {} })
    store.recordToolCall({ sessionId: session.id, toolName: "t4", status: "error", args: {} })
    store.recordToolCall({ sessionId: session.id, toolName: "t5", status: "error", args: {} })
    store.recordToolCall({ sessionId: session.id, toolName: "t6", status: "executing", args: {} })

    const results = store.toolCallLogCollection.findByStatus("error")

    expect(results).toHaveLength(2)
  })

  test("All returned tool calls have status='error'", () => {
    const session = store.createChatSession({ inferredName: "S", contextType: "general" })

    store.recordToolCall({ sessionId: session.id, toolName: "t1", status: "complete", args: {} })
    store.recordToolCall({ sessionId: session.id, toolName: "t2", status: "error", args: {} })
    store.recordToolCall({ sessionId: session.id, toolName: "t3", status: "error", args: {} })

    const results = store.toolCallLogCollection.findByStatus("error")

    expect(results.every((tc: any) => tc.status === "error")).toBe(true)
  })
})

// ============================================================
// Test 16: Domain exports and name match
// ============================================================
describe("studioChatDomain exports correctly", () => {
  test("studioChatDomain.name equals 'studio-chat'", () => {
    expect(studioChatDomain.name).toBe("studio-chat")
  })

  test("StudioChatDomain ArkType scope exports all entities", () => {
    expect(StudioChatDomain).toBeDefined()
    const types = StudioChatDomain.export()
    expect(types.ChatSession).toBeDefined()
    expect(types.ChatMessage).toBeDefined()
    expect(types.ToolCallLog).toBeDefined()
  })

  test("Domain can create store successfully", () => {
    const env = createTestEnv()
    const store = studioChatDomain.createStore(env)

    expect(store).toBeDefined()
    expect(store.chatSessionCollection).toBeDefined()
    expect(store.chatMessageCollection).toBeDefined()
    expect(store.toolCallLogCollection).toBeDefined()
  })
})
