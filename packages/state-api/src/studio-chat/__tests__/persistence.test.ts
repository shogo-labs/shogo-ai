/**
 * Studio Chat Backend Persistence Tests
 *
 * Tests for task-cpbi-002: backend-persistence-wiring
 *
 * These tests verify that domain actions use async persistence methods
 * (insertOne) instead of synchronous MST-only .add(), ensuring data
 * reaches the backend and persists across store recreation.
 *
 * Test Specifications:
 * - test-cpbi-002-a: createChatSession uses insertOne for backend persistence
 * - test-cpbi-002-b: addMessage uses insertOne for backend persistence
 * - test-cpbi-002-c: recordToolCall uses insertOne for backend persistence
 * - test-cpbi-002-d: Data survives store recreation (persistence verification)
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { studioChatDomain } from "../domain"
import { NullPersistence } from "../../persistence/null"
import { MemoryBackend } from "../../query/backends/memory"
import { BackendRegistry } from "../../query/registry"
import type { IEnvironment } from "../../environment/types"

// ============================================================================
// Test Setup: Mock Backend for Persistence Verification
// ============================================================================

/**
 * MockPersistenceBackend simulates a backend that persists data externally.
 * Unlike MemoryBackend (which operates on MST directly), this backend:
 * 1. Stores data in its own Map (simulating database storage)
 * 2. Can be shared across multiple store instances
 * 3. Allows verification that data was written via insertOne
 */
class MockPersistenceBackend {
  // Shared storage maps keyed by model name
  readonly storage: Map<string, Map<string, any>> = new Map()

  // Track insert calls for verification
  insertCalls: Array<{ model: string; data: any }> = []
  updateCalls: Array<{ model: string; id: string; changes: any }> = []

  constructor() {
    // Initialize storage for all models
    this.storage.set("ChatSession", new Map())
    this.storage.set("ChatMessage", new Map())
    this.storage.set("ToolCallLog", new Map())
  }

  getModelStorage(modelName: string): Map<string, any> {
    if (!this.storage.has(modelName)) {
      this.storage.set(modelName, new Map())
    }
    return this.storage.get(modelName)!
  }

  // For debugging - get all data from a model
  getAllFromModel(modelName: string): any[] {
    return Array.from(this.getModelStorage(modelName).values())
  }

  // Clear tracking for next test
  clearTracking() {
    this.insertCalls = []
    this.updateCalls = []
  }

  // Clear all data
  clearAll() {
    for (const storage of this.storage.values()) {
      storage.clear()
    }
    this.clearTracking()
  }
}

/**
 * Create a query executor that uses MockPersistenceBackend.
 * Returns executorType: 'remote' to trigger MST sync in CollectionMutatable.
 */
function createMockExecutor(backend: MockPersistenceBackend, modelName: string) {
  return {
    executorType: "remote" as const,

    async insert(data: any): Promise<any> {
      const storage = backend.getModelStorage(modelName)
      storage.set(data.id, { ...data })
      backend.insertCalls.push({ model: modelName, data: { ...data } })
      return { ...data }
    },

    async update(id: string, changes: any): Promise<any | undefined> {
      const storage = backend.getModelStorage(modelName)
      const existing = storage.get(id)
      if (!existing) return undefined
      const updated = { ...existing, ...changes }
      storage.set(id, updated)
      backend.updateCalls.push({ model: modelName, id, changes })
      return updated
    },

    async delete(id: string): Promise<boolean> {
      const storage = backend.getModelStorage(modelName)
      return storage.delete(id)
    },

    async insertMany(entities: any[]): Promise<any[]> {
      const results: any[] = []
      for (const entity of entities) {
        results.push(await this.insert(entity))
      }
      return results
    },

    async updateMany(ast: any, changes: any): Promise<number> {
      const storage = backend.getModelStorage(modelName)
      let count = 0
      for (const [id, entity] of storage) {
        storage.set(id, { ...entity, ...changes })
        count++
      }
      return count
    },

    async deleteMany(ast: any): Promise<number> {
      const storage = backend.getModelStorage(modelName)
      const count = storage.size
      storage.clear()
      return count
    },

    async select(ast: any): Promise<any[]> {
      const storage = backend.getModelStorage(modelName)
      return Array.from(storage.values())
    },

    async first(ast: any): Promise<any | undefined> {
      const storage = backend.getModelStorage(modelName)
      return storage.values().next().value
    },

    async count(ast: any): Promise<number> {
      return backend.getModelStorage(modelName).size
    },

    async exists(ast: any): Promise<boolean> {
      return backend.getModelStorage(modelName).size > 0
    },
  }
}

/**
 * Create a mock registry that returns executors using shared MockPersistenceBackend.
 */
function createMockRegistry(backend: MockPersistenceBackend) {
  return {
    resolve: (schemaName: string, modelName: string) => {
      return createMockExecutor(backend, modelName)
    },
    register: () => {},
    setDefault: () => {},
    get: () => null,
    has: () => true,
    list: () => [],
  }
}

/**
 * Create test environment with MockPersistenceBackend.
 */
function createTestEnvWithMockBackend(backend: MockPersistenceBackend): IEnvironment {
  return {
    services: {
      persistence: new NullPersistence(),
      backendRegistry: createMockRegistry(backend) as any,
    },
    context: {
      schemaName: "studio-chat",
    },
  }
}

/**
 * Create standard test environment (for comparison/fallback tests).
 */
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

// ============================================================================
// Test CPBI-002-A: createChatSession uses insertOne for backend persistence
// ============================================================================

describe("test-cpbi-002-a: createChatSession uses insertOne for backend persistence", () => {
  let backend: MockPersistenceBackend
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    backend = new MockPersistenceBackend()
    env = createTestEnvWithMockBackend(backend)
    store = studioChatDomain.createStore(env)
  })

  test("createChatSession is an async function returning Promise", async () => {
    // When: Call createChatSession
    const result = store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    // Then: Should return a Promise
    expect(result).toBeInstanceOf(Promise)
    await result // Resolve the promise
  })

  test("createChatSession calls insertOne on chatSessionCollection", async () => {
    // Given: Fresh store with mock backend tracking
    backend.clearTracking()

    // When: Create a chat session
    await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })

    // Then: Backend should have received an insert call for ChatSession
    expect(backend.insertCalls.length).toBeGreaterThanOrEqual(1)
    const sessionInsert = backend.insertCalls.find(
      (call) => call.model === "ChatSession"
    )
    expect(sessionInsert).toBeDefined()
    expect(sessionInsert?.data.inferredName).toBe("Test Session")
    expect(sessionInsert?.data.contextType).toBe("general")
  })

  test("createChatSession persists data to backend storage", async () => {
    // When: Create a chat session
    const session = await store.createChatSession({
      inferredName: "Persisted Session",
      contextType: "feature",
      contextId: "feat-123",
    })

    // Then: Data should be in backend storage (simulating database)
    const storedSessions = backend.getAllFromModel("ChatSession")
    expect(storedSessions.length).toBe(1)
    expect(storedSessions[0].id).toBe(session.id)
    expect(storedSessions[0].inferredName).toBe("Persisted Session")
    expect(storedSessions[0].contextType).toBe("feature")
    expect(storedSessions[0].contextId).toBe("feat-123")
  })

  test("createChatSession returns created entity with all fields", async () => {
    // When: Create a chat session
    const session = await store.createChatSession({
      name: "Named Session",
      inferredName: "Test",
      contextType: "project",
      contextId: "proj-456",
      phase: "discovery",
    })

    // Then: Returned entity has all expected fields
    expect(session).toBeDefined()
    expect(session.id).toBeDefined()
    expect(session.name).toBe("Named Session")
    expect(session.inferredName).toBe("Test")
    expect(session.contextType).toBe("project")
    expect(session.contextId).toBe("proj-456")
    expect(session.phase).toBe("discovery")
    expect(session.createdAt).toBeDefined()
    expect(session.lastActiveAt).toBeDefined()
  })
})

// ============================================================================
// Test CPBI-002-B: addMessage uses insertOne for backend persistence
// ============================================================================

describe("test-cpbi-002-b: addMessage uses insertOne for backend persistence", () => {
  let backend: MockPersistenceBackend
  let env: IEnvironment
  let store: any
  let session: any

  beforeEach(async () => {
    backend = new MockPersistenceBackend()
    env = createTestEnvWithMockBackend(backend)
    store = studioChatDomain.createStore(env)
    // Create a session first
    session = await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })
    backend.clearTracking()
  })

  test("addMessage is an async function returning Promise", async () => {
    // When: Call addMessage
    const result = store.addMessage({
      sessionId: session.id,
      role: "user",
      content: "Hello!",
    })

    // Then: Should return a Promise
    expect(result).toBeInstanceOf(Promise)
    await result
  })

  test("addMessage calls insertOne on chatMessageCollection", async () => {
    // When: Add a message
    await store.addMessage({
      sessionId: session.id,
      role: "user",
      content: "Test message",
    })

    // Then: Backend should have received an insert call for ChatMessage
    const messageInsert = backend.insertCalls.find(
      (call) => call.model === "ChatMessage"
    )
    expect(messageInsert).toBeDefined()
    expect(messageInsert?.data.content).toBe("Test message")
    expect(messageInsert?.data.role).toBe("user")
    expect(messageInsert?.data.session).toBe(session.id)
  })

  test("addMessage persists data to backend storage", async () => {
    // When: Add a message
    const message = await store.addMessage({
      sessionId: session.id,
      role: "assistant",
      content: "Persisted message content",
    })

    // Then: Data should be in backend storage
    const storedMessages = backend.getAllFromModel("ChatMessage")
    expect(storedMessages.length).toBe(1)
    expect(storedMessages[0].id).toBe(message.id)
    expect(storedMessages[0].content).toBe("Persisted message content")
    expect(storedMessages[0].role).toBe("assistant")
  })

  test("addMessage updates session.lastActiveAt via updateOne", async () => {
    // Given: Initial lastActiveAt
    const initialLastActive = session.lastActiveAt

    // Small delay to ensure timestamp difference
    await new Promise((resolve) => setTimeout(resolve, 10))

    // When: Add a message
    await store.addMessage({
      sessionId: session.id,
      role: "user",
      content: "Update timestamp",
    })

    // Then: updateOne should have been called on ChatSession
    const sessionUpdate = backend.updateCalls.find(
      (call) => call.model === "ChatSession" && call.id === session.id
    )
    expect(sessionUpdate).toBeDefined()
    expect(sessionUpdate?.changes.lastActiveAt).toBeGreaterThanOrEqual(
      initialLastActive
    )
  })

  test("addMessage returns created message with session reference", async () => {
    // When: Add a message
    const message = await store.addMessage({
      sessionId: session.id,
      role: "user",
      content: "Test content",
    })

    // Then: Returned message has all fields
    expect(message).toBeDefined()
    expect(message.id).toBeDefined()
    // Note: The raw backend result contains session as ID string.
    // MST reference resolution happens when reading from MST store.
    // For remote backends, verify the session reference exists (as ID or resolved)
    const sessionRef = message.session
    expect(sessionRef === session.id || sessionRef === session || sessionRef?.id === session.id).toBe(true)
    expect(message.role).toBe("user")
    expect(message.content).toBe("Test content")
    expect(message.createdAt).toBeDefined()
  })
})

// ============================================================================
// Test CPBI-002-C: recordToolCall uses insertOne for backend persistence
// ============================================================================

describe("test-cpbi-002-c: recordToolCall uses insertOne for backend persistence", () => {
  let backend: MockPersistenceBackend
  let env: IEnvironment
  let store: any
  let session: any

  beforeEach(async () => {
    backend = new MockPersistenceBackend()
    env = createTestEnvWithMockBackend(backend)
    store = studioChatDomain.createStore(env)
    // Create a session first
    session = await store.createChatSession({
      inferredName: "Test Session",
      contextType: "general",
    })
    backend.clearTracking()
  })

  test("recordToolCall is an async function returning Promise", async () => {
    // When: Call recordToolCall
    const result = store.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "executing",
      args: { model: "User" },
    })

    // Then: Should return a Promise
    expect(result).toBeInstanceOf(Promise)
    await result
  })

  test("recordToolCall calls insertOne on toolCallLogCollection", async () => {
    // When: Record a tool call
    await store.recordToolCall({
      sessionId: session.id,
      toolName: "store.query",
      status: "complete",
      args: { filter: { status: "active" } },
      result: [{ id: "1" }],
    })

    // Then: Backend should have received an insert call for ToolCallLog
    const toolCallInsert = backend.insertCalls.find(
      (call) => call.model === "ToolCallLog"
    )
    expect(toolCallInsert).toBeDefined()
    expect(toolCallInsert?.data.toolName).toBe("store.query")
    expect(toolCallInsert?.data.status).toBe("complete")
    expect(toolCallInsert?.data.args).toEqual({ filter: { status: "active" } })
    expect(toolCallInsert?.data.result).toEqual([{ id: "1" }])
  })

  test("recordToolCall persists data to backend storage", async () => {
    // When: Record a tool call
    const toolCall = await store.recordToolCall({
      sessionId: session.id,
      messageId: "msg-123",
      toolName: "schema.load",
      status: "executing",
      args: { name: "users" },
      duration: 150,
    })

    // Then: Data should be in backend storage
    const storedToolCalls = backend.getAllFromModel("ToolCallLog")
    expect(storedToolCalls.length).toBe(1)
    expect(storedToolCalls[0].id).toBe(toolCall.id)
    expect(storedToolCalls[0].toolName).toBe("schema.load")
    expect(storedToolCalls[0].messageId).toBe("msg-123")
    expect(storedToolCalls[0].duration).toBe(150)
  })

  test("recordToolCall returns created tool call with all fields", async () => {
    // When: Record a tool call with all fields
    const toolCall = await store.recordToolCall({
      sessionId: session.id,
      messageId: "msg-456",
      toolName: "view.execute",
      status: "error",
      args: { view: "userList" },
      result: { error: "View not found" },
      duration: 50,
    })

    // Then: Returned tool call has all fields
    expect(toolCall).toBeDefined()
    expect(toolCall.id).toBeDefined()
    // Note: The raw backend result contains chatSession as ID string.
    // MST reference resolution happens when reading from MST store.
    // For remote backends, verify the session reference exists (as ID or resolved)
    const sessionRef = toolCall.chatSession
    expect(sessionRef === session.id || sessionRef === session || sessionRef?.id === session.id).toBe(true)
    expect(toolCall.messageId).toBe("msg-456")
    expect(toolCall.toolName).toBe("view.execute")
    expect(toolCall.status).toBe("error")
    expect(toolCall.args).toEqual({ view: "userList" })
    expect(toolCall.result).toEqual({ error: "View not found" })
    expect(toolCall.duration).toBe(50)
    expect(toolCall.createdAt).toBeDefined()
  })

  test("recordToolCall handles args/result as unknown types correctly", async () => {
    // When: Record tool calls with various arg/result types
    const toolCall1 = await store.recordToolCall({
      sessionId: session.id,
      toolName: "test1",
      status: "complete",
      args: [1, 2, 3], // Array
      result: 42, // Number
    })

    const toolCall2 = await store.recordToolCall({
      sessionId: session.id,
      toolName: "test2",
      status: "complete",
      args: "string-arg", // String
      result: null, // Null
    })

    // Then: Args/result preserved as-is (not stringified)
    expect(toolCall1.args).toEqual([1, 2, 3])
    expect(toolCall1.result).toBe(42)
    expect(toolCall2.args).toBe("string-arg")
    expect(toolCall2.result).toBeNull()

    // Also verify in backend storage
    const storedToolCalls = backend.getAllFromModel("ToolCallLog")
    const stored1 = storedToolCalls.find((tc) => tc.toolName === "test1")
    expect(stored1?.args).toEqual([1, 2, 3])
    expect(stored1?.result).toBe(42)
  })
})

// ============================================================================
// Test CPBI-002-D: Data survives store recreation (persistence verification)
// ============================================================================

describe("test-cpbi-002-d: Data survives store recreation (persistence verification)", () => {
  let backend: MockPersistenceBackend

  beforeEach(() => {
    backend = new MockPersistenceBackend()
  })

  test("ChatSession data persists across store recreation", async () => {
    // Given: Create first store and add a session
    const env1 = createTestEnvWithMockBackend(backend)
    const store1 = studioChatDomain.createStore(env1)

    const session = await store1.createChatSession({
      name: "Persistent Session",
      inferredName: "Testing persistence",
      contextType: "feature",
      contextId: "feat-persist-001",
      phase: "discovery",
    })

    const sessionId = session.id
    const sessionCreatedAt = session.createdAt

    // When: Create a completely new store with the SAME backend
    const env2 = createTestEnvWithMockBackend(backend)
    const store2 = studioChatDomain.createStore(env2)

    // Then: The data should still be in the backend storage
    const persistedSessions = backend.getAllFromModel("ChatSession")
    expect(persistedSessions.length).toBe(1)
    expect(persistedSessions[0].id).toBe(sessionId)
    expect(persistedSessions[0].name).toBe("Persistent Session")
    expect(persistedSessions[0].contextType).toBe("feature")
    expect(persistedSessions[0].contextId).toBe("feat-persist-001")
    expect(persistedSessions[0].createdAt).toBe(sessionCreatedAt)
  })

  test("ChatMessage data persists across store recreation", async () => {
    // Given: Create first store with session and messages
    const env1 = createTestEnvWithMockBackend(backend)
    const store1 = studioChatDomain.createStore(env1)

    const session = await store1.createChatSession({
      inferredName: "Message Test",
      contextType: "general",
    })

    const msg1 = await store1.addMessage({
      sessionId: session.id,
      role: "user",
      content: "First persistent message",
    })

    const msg2 = await store1.addMessage({
      sessionId: session.id,
      role: "assistant",
      content: "Second persistent message",
    })

    // When: Create a new store (simulating app restart)
    const env2 = createTestEnvWithMockBackend(backend)
    const store2 = studioChatDomain.createStore(env2)

    // Then: Messages should still be in backend
    const persistedMessages = backend.getAllFromModel("ChatMessage")
    expect(persistedMessages.length).toBe(2)

    const persistedMsg1 = persistedMessages.find((m) => m.id === msg1.id)
    const persistedMsg2 = persistedMessages.find((m) => m.id === msg2.id)

    expect(persistedMsg1?.content).toBe("First persistent message")
    expect(persistedMsg1?.role).toBe("user")
    expect(persistedMsg2?.content).toBe("Second persistent message")
    expect(persistedMsg2?.role).toBe("assistant")
  })

  test("ToolCallLog data persists across store recreation", async () => {
    // Given: Create first store with session and tool calls
    const env1 = createTestEnvWithMockBackend(backend)
    const store1 = studioChatDomain.createStore(env1)

    const session = await store1.createChatSession({
      inferredName: "Tool Call Test",
      contextType: "general",
    })

    const toolCall = await store1.recordToolCall({
      sessionId: session.id,
      toolName: "persistent.tool",
      status: "complete",
      args: { complex: { nested: { data: [1, 2, 3] } } },
      result: { success: true, count: 42 },
      duration: 250,
    })

    // When: Create a new store (simulating app restart)
    const env2 = createTestEnvWithMockBackend(backend)
    const store2 = studioChatDomain.createStore(env2)

    // Then: Tool call should still be in backend
    const persistedToolCalls = backend.getAllFromModel("ToolCallLog")
    expect(persistedToolCalls.length).toBe(1)

    const persistedToolCall = persistedToolCalls[0]
    expect(persistedToolCall.id).toBe(toolCall.id)
    expect(persistedToolCall.toolName).toBe("persistent.tool")
    expect(persistedToolCall.status).toBe("complete")
    expect(persistedToolCall.args).toEqual({
      complex: { nested: { data: [1, 2, 3] } },
    })
    expect(persistedToolCall.result).toEqual({ success: true, count: 42 })
    expect(persistedToolCall.duration).toBe(250)
  })

  test("Full workflow data persists: session -> messages -> tool calls", async () => {
    // Given: Complete workflow in first store
    const env1 = createTestEnvWithMockBackend(backend)
    const store1 = studioChatDomain.createStore(env1)

    // Create session
    const session = await store1.createChatSession({
      name: "Full Workflow Test",
      inferredName: "Complete persistence test",
      contextType: "feature",
      contextId: "feat-full-001",
    })

    // Add messages
    await store1.addMessage({
      sessionId: session.id,
      role: "user",
      content: "Build me an app",
    })

    await store1.addMessage({
      sessionId: session.id,
      role: "assistant",
      content: "I'll help you build that. Let me start by loading the schema.",
    })

    // Record tool calls
    await store1.recordToolCall({
      sessionId: session.id,
      toolName: "schema.load",
      status: "complete",
      args: { name: "app-schema" },
      result: { loaded: true },
    })

    await store1.recordToolCall({
      sessionId: session.id,
      toolName: "store.create",
      status: "complete",
      args: { model: "App", data: { name: "MyApp" } },
      result: { id: "app-001" },
    })

    // When: Verify data in backend (simulating data retrieval after restart)
    const sessions = backend.getAllFromModel("ChatSession")
    const messages = backend.getAllFromModel("ChatMessage")
    const toolCalls = backend.getAllFromModel("ToolCallLog")

    // Then: All data should be present
    expect(sessions.length).toBe(1)
    expect(sessions[0].name).toBe("Full Workflow Test")

    expect(messages.length).toBe(2)
    expect(messages.some((m) => m.content === "Build me an app")).toBe(true)
    expect(
      messages.some((m) =>
        m.content.includes("I'll help you build that")
      )
    ).toBe(true)

    expect(toolCalls.length).toBe(2)
    expect(toolCalls.some((tc) => tc.toolName === "schema.load")).toBe(true)
    expect(toolCalls.some((tc) => tc.toolName === "store.create")).toBe(true)
  })
})

// ============================================================================
// Edge Case: Validation still works with async actions
// ============================================================================

describe("Validation still works with async persistence actions", () => {
  let backend: MockPersistenceBackend
  let env: IEnvironment
  let store: any

  beforeEach(() => {
    backend = new MockPersistenceBackend()
    env = createTestEnvWithMockBackend(backend)
    store = studioChatDomain.createStore(env)
  })

  test("createChatSession throws when contextType='feature' without contextId", async () => {
    // When/Then: Should throw validation error
    await expect(
      store.createChatSession({
        inferredName: "Test",
        contextType: "feature",
        // Missing contextId
      })
    ).rejects.toThrow(/contextId.*required|feature.*contextId/i)

    // And no data should be persisted
    expect(backend.getAllFromModel("ChatSession").length).toBe(0)
  })

  test("createChatSession throws when contextType='general' has contextId", async () => {
    // When/Then: Should throw validation error
    await expect(
      store.createChatSession({
        inferredName: "Test",
        contextType: "general",
        contextId: "should-not-exist",
      })
    ).rejects.toThrow(/contextId.*not.*allowed|general.*contextId/i)

    // And no data should be persisted
    expect(backend.getAllFromModel("ChatSession").length).toBe(0)
  })

  test("addMessage throws when session not found", async () => {
    // When/Then: Should throw error
    await expect(
      store.addMessage({
        sessionId: "nonexistent-session-id",
        role: "user",
        content: "Test",
      })
    ).rejects.toThrow(/ChatSession.*not found/i)

    // And no message should be persisted
    expect(backend.getAllFromModel("ChatMessage").length).toBe(0)
  })

  test("recordToolCall throws when session not found", async () => {
    // When/Then: Should throw error
    await expect(
      store.recordToolCall({
        sessionId: "nonexistent-session-id",
        toolName: "test.tool",
        status: "executing",
        args: {},
      })
    ).rejects.toThrow(/ChatSession.*not found/i)

    // And no tool call should be persisted
    expect(backend.getAllFromModel("ToolCallLog").length).toBe(0)
  })
})
