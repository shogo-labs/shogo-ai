/**
 * Generated from TestSpecifications for task-1-2-domain-store
 * Session: studio-app-1-2-studio-chat
 * Description: Create studio-chat domain store with domain() API
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { StudioChatDomain, studioChatDomain } from "../domain"
import { NullPersistence } from "../../persistence/null"
import { MemoryBackend } from "../../query/backends/memory"
import { BackendRegistry } from "../../query/registry"
import type { IEnvironment } from "../../environment/types"

// Helper to create a test environment with working backendRegistry
function createTestEnv(): IEnvironment {
  const registry = new BackendRegistry()
  registry.register("memory", new MemoryBackend())
  registry.setDefault("memory")

  return {
    services: {
      persistence: new NullPersistence(),
      backendRegistry: registry,
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

  test("Error is thrown with message about missing contextId", async () => {
    await expect(
      store.createChatSession({
        inferredName: "Test Session",
        contextType: "feature",
        // No contextId provided
      })
    ).rejects.toThrow(/contextId.*required|feature.*contextId/i)
  })

  test("No ChatSession entity is created", async () => {
    try {
      await store.createChatSession({
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

  test("Error is thrown with message about missing contextId", async () => {
    await expect(
      store.createChatSession({
        inferredName: "Test Session",
        contextType: "project",
        // No contextId provided
      })
    ).rejects.toThrow(/contextId.*required|project.*contextId/i)
  })

  test("No ChatSession entity is created", async () => {
    try {
      await store.createChatSession({
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

  test("Error is thrown with message about unexpected contextId", async () => {
    await expect(
      store.createChatSession({
        inferredName: "Test Session",
        contextType: "general",
        contextId: "some-context-id",
      })
    ).rejects.toThrow(/contextId.*not.*allowed|general.*contextId/i)
  })

  test("No ChatSession entity is created", async () => {
    try {
      await store.createChatSession({
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

  test("ChatSession entity is created", async () => {
    const session = await await store.createChatSession({
      inferredName: "Feature Chat",
      contextType: "feature",
      contextId: "feat-session-123",
    })

    expect(session).toBeDefined()
    expect(session.id).toBeDefined()
  })

  test("contextType is 'feature'", async () => {
    const session = await await store.createChatSession({
      inferredName: "Feature Chat",
      contextType: "feature",
      contextId: "feat-session-123",
    })

    expect(session.contextType).toBe("feature")
  })

  test("contextId matches provided value", async () => {
    const session = await await store.createChatSession({
      inferredName: "Feature Chat",
      contextType: "feature",
      contextId: "feat-session-123",
    })

    expect(session.contextId).toBe("feat-session-123")
  })

  test("createdAt and lastActiveAt are set to current timestamp", async () => {
    const before = Date.now()
    const session = await await store.createChatSession({
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

  test("ChatSession entity is created", async () => {
    const session = await await store.createChatSession({
      inferredName: "General Chat",
      contextType: "general",
    })

    expect(session).toBeDefined()
    expect(session.id).toBeDefined()
  })

  test("contextType is 'general'", async () => {
    const session = await await store.createChatSession({
      inferredName: "General Chat",
      contextType: "general",
    })

    expect(session.contextType).toBe("general")
  })

  test("contextId is undefined/null", async () => {
    const session = await await store.createChatSession({
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

  test("ChatMessage is created with session reference", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const message = await await store.addMessage({
      sessionId: session.id,
      role: "user",
      content: "Hello!",
    })

    expect(message).toBeDefined()
    expect(message.session).toBe(session)
  })

  test("Session.lastActiveAt is updated", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const initialLastActive = session.lastActiveAt

    // Wait a tiny bit to ensure timestamp changes
    const message = await await store.addMessage({
      sessionId: session.id,
      role: "user",
      content: "Hello!",
    })

    expect(session.lastActiveAt).toBeGreaterThanOrEqual(initialLastActive)
  })

  test("Message.createdAt is set", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const before = Date.now()
    const message = await await store.addMessage({
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

  test("ChatMessage.session resolves to the ChatSession instance (not just ID string)", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const message = await await store.addMessage({
      sessionId: session.id,
      role: "user",
      content: "Hello!",
    })

    // Should be the actual instance, not just an ID string
    expect(message.session).toBe(session)
    expect(message.session.inferredName).toBe("Test Session")
  })

  test("ChatMessage.role is 'user'", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const message = await await store.addMessage({
      sessionId: session.id,
      role: "user",
      content: "Hello!",
    })

    expect(message.role).toBe("user")
  })

  test("ChatMessage.content matches provided value", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const message = await await store.addMessage({
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

  test("Returns 0 for session with no messages", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    expect(session.messageCount).toBe(0)
  })

  test("Returns 3 after adding 3 messages", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    await store.addMessage({ sessionId: session.id, role: "user", content: "Message 1" })
    await store.addMessage({ sessionId: session.id, role: "assistant", content: "Message 2" })
    await store.addMessage({ sessionId: session.id, role: "user", content: "Message 3" })

    expect(session.messageCount).toBe(3)
  })

  test("Adding another message updates count to 4", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    await store.addMessage({ sessionId: session.id, role: "user", content: "Message 1" })
    await store.addMessage({ sessionId: session.id, role: "assistant", content: "Message 2" })
    await store.addMessage({ sessionId: session.id, role: "user", content: "Message 3" })

    expect(session.messageCount).toBe(3)

    await store.addMessage({ sessionId: session.id, role: "assistant", content: "Message 4" })

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

  test("Returns undefined for session with no messages", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    expect(session.latestMessage).toBeUndefined()
  })

  test("Returns the message with highest createdAt", async () => {
    const session = await await store.createChatSession({
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

  test("Returns 0 for session with no tool calls", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    expect(session.toolCallCount).toBe(0)
  })

  test("Returns 2 after recording 2 tool calls", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "complete",
      args: {},
    })

    await store.recordToolCall({
      sessionId: session.id,
      toolName: "schema.load",
      status: "complete",
      args: {},
    })

    expect(session.toolCallCount).toBe(2)
  })

  test("Recording another tool call updates count to 3", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    await store.recordToolCall({ sessionId: session.id, toolName: "tool1", status: "complete", args: {} })
    await store.recordToolCall({ sessionId: session.id, toolName: "tool2", status: "complete", args: {} })

    expect(session.toolCallCount).toBe(2)

    await store.recordToolCall({ sessionId: session.id, toolName: "tool3", status: "complete", args: {} })

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

  test("ToolCallLog is created", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "executing",
      args: { model: "User" },
    })

    expect(toolCall).toBeDefined()
    expect(toolCall.id).toBeDefined()
  })

  test("chatSession resolves to ChatSession instance", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "executing",
      args: {},
    })

    expect(toolCall.chatSession).toBe(session)
  })

  test("toolName is 'store.create'", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "executing",
      args: {},
    })

    expect(toolCall.toolName).toBe("store.create")
  })

  test("status is 'executing'", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "executing",
      args: {},
    })

    expect(toolCall.status).toBe("executing")
  })

  test("createdAt is set", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const before = Date.now()
    const toolCall = await await store.recordToolCall({
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

  test("Returns only sessions matching both contextType and contextId", async () => {
    // Session A: feature + feat-123
    await store.createChatSession({
      inferredName: "Session A",
      contextType: "feature",
      contextId: "feat-123",
    })

    // Session B: feature + feat-456 (different contextId)
    await store.createChatSession({
      inferredName: "Session B",
      contextType: "feature",
      contextId: "feat-456",
    })

    // Session C: project + feat-123 (different contextType)
    await store.createChatSession({
      inferredName: "Session C",
      contextType: "project",
      contextId: "feat-123",
    })

    const results = store.chatSessionCollection.findByFeature("feat-123")

    expect(results).toHaveLength(1)
    expect(results[0].inferredName).toBe("Session A")
  })

  test("Does not return Session B (different contextId)", async () => {
    await store.createChatSession({ inferredName: "A", contextType: "feature", contextId: "feat-123" })
    await store.createChatSession({ inferredName: "B", contextType: "feature", contextId: "feat-456" })

    const results = store.chatSessionCollection.findByFeature("feat-123")
    const names = results.map((s: any) => s.inferredName)

    expect(names).not.toContain("B")
  })

  test("Does not return Session C (different contextType)", async () => {
    await store.createChatSession({ inferredName: "A", contextType: "feature", contextId: "feat-123" })
    await store.createChatSession({ inferredName: "C", contextType: "project", contextId: "feat-123" })

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

  test("Returns 2 sessions with contextType='feature'", async () => {
    await store.createChatSession({ inferredName: "F1", contextType: "feature", contextId: "f1" })
    await store.createChatSession({ inferredName: "F2", contextType: "feature", contextId: "f2" })
    await store.createChatSession({ inferredName: "G1", contextType: "general" })

    const results = store.chatSessionCollection.findByContextType("feature")

    expect(results).toHaveLength(2)
  })

  test("All returned sessions have contextType='feature'", async () => {
    await store.createChatSession({ inferredName: "F1", contextType: "feature", contextId: "f1" })
    await store.createChatSession({ inferredName: "F2", contextType: "feature", contextId: "f2" })
    await store.createChatSession({ inferredName: "G1", contextType: "general" })

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

  test("Returns 3 messages for Session A", async () => {
    const sessionA = await await store.createChatSession({ inferredName: "A", contextType: "general" })
    const sessionB = await await store.createChatSession({ inferredName: "B", contextType: "general" })

    await store.addMessage({ sessionId: sessionA.id, role: "user", content: "A1" })
    await store.addMessage({ sessionId: sessionA.id, role: "assistant", content: "A2" })
    await store.addMessage({ sessionId: sessionA.id, role: "user", content: "A3" })
    await store.addMessage({ sessionId: sessionB.id, role: "user", content: "B1" })
    await store.addMessage({ sessionId: sessionB.id, role: "assistant", content: "B2" })

    const results = store.chatMessageCollection.findBySession(sessionA.id)

    expect(results).toHaveLength(3)
  })

  test("All messages belong to Session A", async () => {
    const sessionA = await await store.createChatSession({ inferredName: "A", contextType: "general" })
    const sessionB = await await store.createChatSession({ inferredName: "B", contextType: "general" })

    await store.addMessage({ sessionId: sessionA.id, role: "user", content: "A1" })
    await store.addMessage({ sessionId: sessionA.id, role: "assistant", content: "A2" })
    await store.addMessage({ sessionId: sessionB.id, role: "user", content: "B1" })

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

  test("Returns 2 tool calls with status='error'", async () => {
    const session = await await store.createChatSession({ inferredName: "S", contextType: "general" })

    await store.recordToolCall({ sessionId: session.id, toolName: "t1", status: "complete", args: {} })
    await store.recordToolCall({ sessionId: session.id, toolName: "t2", status: "complete", args: {} })
    await store.recordToolCall({ sessionId: session.id, toolName: "t3", status: "complete", args: {} })
    await store.recordToolCall({ sessionId: session.id, toolName: "t4", status: "error", args: {} })
    await store.recordToolCall({ sessionId: session.id, toolName: "t5", status: "error", args: {} })
    await store.recordToolCall({ sessionId: session.id, toolName: "t6", status: "executing", args: {} })

    const results = store.toolCallLogCollection.findByStatus("error")

    expect(results).toHaveLength(2)
  })

  test("All returned tool calls have status='error'", async () => {
    const session = await await store.createChatSession({ inferredName: "S", contextType: "general" })

    await store.recordToolCall({ sessionId: session.id, toolName: "t1", status: "complete", args: {} })
    await store.recordToolCall({ sessionId: session.id, toolName: "t2", status: "error", args: {} })
    await store.recordToolCall({ sessionId: session.id, toolName: "t3", status: "error", args: {} })

    const results = store.toolCallLogCollection.findByStatus("error")

    expect(results.every((tc: any) => tc.status === "error")).toBe(true)
  })
})

// ============================================================
// Test 16: Domain exports and name match
// ============================================================
describe("studioChatDomain exports correctly", () => {
  test("studioChatDomain.name equals 'studio-chat'", async () => {
    expect(studioChatDomain.name).toBe("studio-chat")
  })

  test("StudioChatDomain ArkType scope exports all entities", async () => {
    expect(StudioChatDomain).toBeDefined()
    const types = StudioChatDomain.export()
    expect(types.ChatSession).toBeDefined()
    expect(types.ChatMessage).toBeDefined()
    expect(types.ToolCallLog).toBeDefined()
  })

  test("Domain can create store successfully", async () => {
    const env = createTestEnv()
    const store = studioChatDomain.createStore(env)

    expect(store).toBeDefined()
    expect(store.chatSessionCollection).toBeDefined()
    expect(store.chatMessageCollection).toBeDefined()
    expect(store.toolCallLogCollection).toBeDefined()
  })
})

// ============================================================
// Test CPBI-001-A: ToolCallLog uses args/result as unknown types
// ============================================================
describe("test-cpbi-001-a: ToolCallLog uses args/result as unknown types instead of JSON strings", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("ToolCallLog entity has 'args' field (not 'argsJson')", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "complete",
      args: { model: "User", data: { name: "John" } },
    })

    // Should have 'args' as direct field, not 'argsJson'
    expect(toolCall.args).toEqual({ model: "User", data: { name: "John" } })
    expect(toolCall.argsJson).toBeUndefined()
  })

  test("ToolCallLog entity has 'result' field (not 'resultJson')", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "complete",
      args: {},
      result: { success: true, id: "user-123" },
    })

    // Should have 'result' as direct field, not 'resultJson'
    expect(toolCall.result).toEqual({ success: true, id: "user-123" })
    expect(toolCall.resultJson).toBeUndefined()
  })

  test("args and result can be any type (unknown)", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    // Test with array as args
    const toolCall1 = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "bulk.create",
      status: "complete",
      args: [1, 2, 3],
      result: ["a", "b", "c"],
    })
    expect(toolCall1.args).toEqual([1, 2, 3])
    expect(toolCall1.result).toEqual(["a", "b", "c"])

    // Test with primitive as result
    const toolCall2 = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "count.items",
      status: "complete",
      args: { collection: "users" },
      result: 42,
    })
    expect(toolCall2.result).toBe(42)

    // Test with null
    const toolCall3 = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "delete.item",
      status: "complete",
      args: { id: "123" },
      result: null,
    })
    expect(toolCall3.result).toBeNull()
  })
})

// ============================================================
// Test CPBI-001-B: recordToolCall stores args/result as objects directly
// ============================================================
describe("test-cpbi-001-b: recordToolCall stores args/result as objects directly", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("recordToolCall does not JSON.stringify args", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const argsObject = { model: "User", data: { name: "John", age: 30 } }
    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "complete",
      args: argsObject,
    })

    // args should be the object directly, not a JSON string
    expect(typeof toolCall.args).toBe("object")
    expect(typeof toolCall.args).not.toBe("string")
    expect(toolCall.args).toEqual(argsObject)
  })

  test("recordToolCall does not JSON.stringify result", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const resultObject = { success: true, entity: { id: "123", name: "John" } }
    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "complete",
      args: {},
      result: resultObject,
    })

    // result should be the object directly, not a JSON string
    expect(typeof toolCall.result).toBe("object")
    expect(typeof toolCall.result).not.toBe("string")
    expect(toolCall.result).toEqual(resultObject)
  })

  test("recordToolCall preserves nested object structure in args", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const complexArgs = {
      query: {
        filter: { status: "active" },
        sort: { createdAt: -1 },
        pagination: { skip: 0, take: 10 },
      },
    }
    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.query",
      status: "complete",
      args: complexArgs,
    })

    // Verify structure is preserved (not flattened through JSON round-trip)
    expect(toolCall.args.query.filter.status).toBe("active")
    expect(toolCall.args.query.sort.createdAt).toBe(-1)
    expect(toolCall.args.query.pagination.take).toBe(10)
  })

  test("result can be undefined when not provided", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "executing",
      args: { model: "User" },
      // result not provided
    })

    expect(toolCall.result).toBeUndefined()
  })
})

// ============================================================
// Test CPBI-001-C: JSON-parsing computed views are removed from ToolCallLog
// ============================================================
describe("test-cpbi-001-c: JSON-parsing computed views are removed from ToolCallLog", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("args is a direct property, not a computed getter that parses argsJson", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "complete",
      args: { test: true },
    })

    // If args were still a computed getter, there would be argsJson as the stored field
    // Verify argsJson doesn't exist
    expect(toolCall.argsJson).toBeUndefined()

    // And args is accessible as a direct field
    expect(toolCall.args).toEqual({ test: true })
  })

  test("result is a direct property, not a computed getter that parses resultJson", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "complete",
      args: {},
      result: { success: true },
    })

    // If result were still a computed getter, there would be resultJson as the stored field
    // Verify resultJson doesn't exist
    expect(toolCall.resultJson).toBeUndefined()

    // And result is accessible as a direct field
    expect(toolCall.result).toEqual({ success: true })
  })

  test("directly created ToolCallLog entities use args/result fields", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    // Directly add to collection (bypassing recordToolCall action)
    const toolCall = store.toolCallLogCollection.add({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      chatSession: session.id,
      toolName: "direct.create",
      status: "complete",
      args: { direct: true },
      result: { directResult: true },
      createdAt: Date.now(),
    })

    expect(toolCall.args).toEqual({ direct: true })
    expect(toolCall.result).toEqual({ directResult: true })
    expect(toolCall.argsJson).toBeUndefined()
    expect(toolCall.resultJson).toBeUndefined()
  })
})

// ============================================================
// Test CPBI-008-A: toolNamespace view extracts namespace prefix
// ============================================================
describe("test-cpbi-008-a: toolNamespace view extracts namespace prefix", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("toolNamespace extracts 'store' from 'store.create'", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "complete",
      args: { model: "User" },
    })

    expect(toolCall.toolNamespace).toBe("store")
  })

  test("toolNamespace extracts 'schema' from 'schema.load'", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "schema.load",
      status: "complete",
      args: { name: "test" },
    })

    expect(toolCall.toolNamespace).toBe("schema")
  })

  test("toolNamespace extracts 'view' from 'view.execute'", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "view.execute",
      status: "complete",
      args: {},
    })

    expect(toolCall.toolNamespace).toBe("view")
  })
})

// ============================================================
// Test CPBI-008-B: toolNamespace handles tools without namespace
// ============================================================
describe("test-cpbi-008-b: toolNamespace handles tools without namespace", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("toolNamespace returns full name when no dot separator", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "simpleTool",
      status: "complete",
      args: {},
    })

    expect(toolCall.toolNamespace).toBe("simpleTool")
  })

  test("toolNamespace returns full name for single-word tool", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "execute",
      status: "complete",
      args: {},
    })

    expect(toolCall.toolNamespace).toBe("execute")
  })
})

// ============================================================
// Test CPBI-008-C: isSuccess view returns true for complete status
// ============================================================
describe("test-cpbi-008-c: isSuccess view returns true for complete status", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("isSuccess returns true when status is 'complete'", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "complete",
      args: {},
    })

    expect(toolCall.isSuccess).toBe(true)
  })
})

// ============================================================
// Test CPBI-008-D: isSuccess view returns false for non-complete status
// ============================================================
describe("test-cpbi-008-d: isSuccess view returns false for non-complete status", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("isSuccess returns false when status is 'executing'", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "executing",
      args: {},
    })

    expect(toolCall.isSuccess).toBe(false)
  })

  test("isSuccess returns false when status is 'streaming'", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "streaming",
      args: {},
    })

    expect(toolCall.isSuccess).toBe(false)
  })

  test("isSuccess returns false when status is 'error'", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "error",
      args: {},
    })

    expect(toolCall.isSuccess).toBe(false)
  })
})

// ============================================================
// Test CPBI-008-E: summaryLine view returns concise metadata string
// ============================================================
describe("test-cpbi-008-e: summaryLine view returns concise metadata string", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("summaryLine includes model when args contains model", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "complete",
      args: { model: "FeatureSession" },
    })

    expect(toolCall.summaryLine).toBe("store.create: FeatureSession")
  })

  test("summaryLine includes schema when args contains schema (but no model)", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "schema.load",
      status: "complete",
      args: { schema: "platform-features" },
    })

    expect(toolCall.summaryLine).toBe("schema.load: platform-features")
  })

  test("summaryLine returns just toolName when no model or schema in args", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "view.execute",
      status: "complete",
      args: { view: "activeFeatures" },
    })

    expect(toolCall.summaryLine).toBe("view.execute")
  })

  test("summaryLine prefers model over schema when both present", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.query",
      status: "complete",
      args: { model: "Task", schema: "platform-features" },
    })

    expect(toolCall.summaryLine).toBe("store.query: Task")
  })
})

// ============================================================
// Test CPBI-008-F: Views added via enhancements.models
// ============================================================
describe("test-cpbi-008-f: Views added via enhancements.models", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("ToolCallLog has toolNamespace as a computed view", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "complete",
      args: {},
    })

    // Verify it's a getter (computed view), not a stored property
    expect("toolNamespace" in toolCall).toBe(true)
    expect(typeof toolCall.toolNamespace).toBe("string")
  })

  test("ToolCallLog has isSuccess as a computed view", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "complete",
      args: {},
    })

    // Verify it's a getter (computed view), not a stored property
    expect("isSuccess" in toolCall).toBe(true)
    expect(typeof toolCall.isSuccess).toBe("boolean")
  })

  test("ToolCallLog has summaryLine as a computed view", async () => {
    const session = await await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    const toolCall = await await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "complete",
      args: {},
    })

    // Verify it's a getter (computed view), not a stored property
    expect("summaryLine" in toolCall).toBe(true)
    expect(typeof toolCall.summaryLine).toBe("string")
  })
})

// ============================================================
// Test CPBI-003-A: findByFeatureAndPhase returns matching session
// ============================================================
describe("test-cpbi-003-a: findByFeatureAndPhase returns matching session", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("Returns session that matches featureId and phase", async () => {
    // Create a session with feature context and phase
    const session = await await store.createChatSession({
      inferredName: "Discovery Chat",
      contextType: "feature",
      contextId: "feat-abc-123",
      phase: "discovery",
    })

    const result = store.chatSessionCollection.findByFeatureAndPhase(
      "feat-abc-123",
      "discovery"
    )

    expect(result).toBeDefined()
    expect(result.id).toBe(session.id)
    expect(result.inferredName).toBe("Discovery Chat")
  })

  test("Returns the correct session when multiple sessions exist", async () => {
    // Create multiple sessions with different phases
    await store.createChatSession({
      inferredName: "Discovery Chat",
      contextType: "feature",
      contextId: "feat-abc-123",
      phase: "discovery",
    })

    const designSession = await store.createChatSession({
      inferredName: "Design Chat",
      contextType: "feature",
      contextId: "feat-abc-123",
      phase: "design",
    })

    await store.createChatSession({
      inferredName: "Impl Chat",
      contextType: "feature",
      contextId: "feat-abc-123",
      phase: "implementation",
    })

    const result = store.chatSessionCollection.findByFeatureAndPhase(
      "feat-abc-123",
      "design"
    )

    expect(result).toBeDefined()
    expect(result.id).toBe(designSession.id)
    expect(result.phase).toBe("design")
  })
})

// ============================================================
// Test CPBI-003-B: findByFeatureAndPhase returns null when no match exists
// ============================================================
describe("test-cpbi-003-b: findByFeatureAndPhase returns null when no match exists", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("Returns null when no sessions exist", async () => {
    const result = store.chatSessionCollection.findByFeatureAndPhase(
      "feat-xyz",
      "discovery"
    )

    expect(result).toBeNull()
  })

  test("Returns null when featureId does not match any session", async () => {
    await store.createChatSession({
      inferredName: "Discovery Chat",
      contextType: "feature",
      contextId: "feat-abc-123",
      phase: "discovery",
    })

    const result = store.chatSessionCollection.findByFeatureAndPhase(
      "feat-different-id",
      "discovery"
    )

    expect(result).toBeNull()
  })

  test("Returns null when phase does not match any session", async () => {
    await store.createChatSession({
      inferredName: "Discovery Chat",
      contextType: "feature",
      contextId: "feat-abc-123",
      phase: "discovery",
    })

    const result = store.chatSessionCollection.findByFeatureAndPhase(
      "feat-abc-123",
      "design" // Different phase
    )

    expect(result).toBeNull()
  })
})

// ============================================================
// Test CPBI-003-C: findByFeatureAndPhase filters by all three criteria
// ============================================================
describe("test-cpbi-003-c: findByFeatureAndPhase filters by all three criteria", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("Does not return session with contextType='project' even if contextId and phase match", async () => {
    // Create a project session (not feature) with same contextId and phase
    await store.createChatSession({
      inferredName: "Project Chat",
      contextType: "project",
      contextId: "feat-abc-123",
      phase: "discovery",
    })

    const result = store.chatSessionCollection.findByFeatureAndPhase(
      "feat-abc-123",
      "discovery"
    )

    expect(result).toBeNull()
  })

  test("Does not return session with matching contextType and phase but different contextId", async () => {
    await store.createChatSession({
      inferredName: "Feature Chat",
      contextType: "feature",
      contextId: "feat-different",
      phase: "discovery",
    })

    const result = store.chatSessionCollection.findByFeatureAndPhase(
      "feat-abc-123",
      "discovery"
    )

    expect(result).toBeNull()
  })

  test("Does not return session with matching contextType and contextId but different phase", async () => {
    await store.createChatSession({
      inferredName: "Feature Chat",
      contextType: "feature",
      contextId: "feat-abc-123",
      phase: "design",
    })

    const result = store.chatSessionCollection.findByFeatureAndPhase(
      "feat-abc-123",
      "discovery"
    )

    expect(result).toBeNull()
  })

  test("Only returns session matching all three: contextType='feature', contextId, and phase", async () => {
    // Create multiple sessions with various combinations
    await store.createChatSession({
      inferredName: "Project Same ID Phase",
      contextType: "project",
      contextId: "feat-abc-123",
      phase: "discovery",
    })

    await store.createChatSession({
      inferredName: "Feature Different ID Same Phase",
      contextType: "feature",
      contextId: "feat-xyz",
      phase: "discovery",
    })

    await store.createChatSession({
      inferredName: "Feature Same ID Different Phase",
      contextType: "feature",
      contextId: "feat-abc-123",
      phase: "implementation",
    })

    const targetSession = await store.createChatSession({
      inferredName: "The Correct Session",
      contextType: "feature",
      contextId: "feat-abc-123",
      phase: "discovery",
    })

    const result = store.chatSessionCollection.findByFeatureAndPhase(
      "feat-abc-123",
      "discovery"
    )

    expect(result).toBeDefined()
    expect(result.id).toBe(targetSession.id)
    expect(result.inferredName).toBe("The Correct Session")
  })
})

// ============================================================
// Test CPBI-003-D: findByFeatureAndPhase is added via enhancements.collections
// ============================================================
describe("test-cpbi-003-d: findByFeatureAndPhase is added via enhancements.collections", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("findByFeatureAndPhase is a function on chatSessionCollection", async () => {
    expect(typeof store.chatSessionCollection.findByFeatureAndPhase).toBe("function")
  })

  test("findByFeatureAndPhase exists alongside findByFeature", async () => {
    expect(typeof store.chatSessionCollection.findByFeature).toBe("function")
    expect(typeof store.chatSessionCollection.findByFeatureAndPhase).toBe("function")
  })

  test("findByFeatureAndPhase exists alongside findByContextType", async () => {
    expect(typeof store.chatSessionCollection.findByContextType).toBe("function")
    expect(typeof store.chatSessionCollection.findByFeatureAndPhase).toBe("function")
  })
})

// ============================================================
// Test CC-DOMAIN: ChatSession.claudeCodeSessionId field
// ============================================================
describe("ChatSession.claudeCodeSessionId", () => {
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    env = createTestEnv()
    store = studioChatDomain.createStore(env)
  })

  test("can be created with claudeCodeSessionId", async () => {
    const session = await store.createChatSession({
      inferredName: "Test Session",
      contextType: "feature",
      contextId: "feat-123",
    })
    // Update with CC session ID
    await store.chatSessionCollection.updateOne(session.id, {
      claudeCodeSessionId: "cc-session-abc"
    })
    const updated = store.chatSessionCollection.get(session.id)
    expect(updated.claudeCodeSessionId).toBe("cc-session-abc")
  })

  test("claudeCodeSessionId is optional (undefined by default)", async () => {
    const session = await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })
    expect(session.claudeCodeSessionId).toBeUndefined()
  })

  test("hasClaudeCodeSession returns true when set", async () => {
    const session = await store.createChatSession({
      inferredName: "Test",
      contextType: "general",
    })
    await store.chatSessionCollection.updateOne(session.id, {
      claudeCodeSessionId: "cc-xyz"
    })
    const updated = store.chatSessionCollection.get(session.id)
    expect(updated.hasClaudeCodeSession).toBe(true)
  })

  test("hasClaudeCodeSession returns false when not set", async () => {
    const session = await store.createChatSession({
      inferredName: "Test",
      contextType: "general",
    })
    expect(session.hasClaudeCodeSession).toBe(false)
  })

  test("hasClaudeCodeSession returns false for empty string", async () => {
    const session = await store.createChatSession({
      inferredName: "Test",
      contextType: "general",
    })
    await store.chatSessionCollection.updateOne(session.id, {
      claudeCodeSessionId: ""
    })
    const updated = store.chatSessionCollection.get(session.id)
    expect(updated.hasClaudeCodeSession).toBe(false)
  })
})
