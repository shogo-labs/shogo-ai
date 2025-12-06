import { describe, test, expect } from "bun:test"
import { scope } from "arktype"

// This import will fail initially (TDD)
import { createStoreFromScope } from "../index"

describe("Basic arkType → MST transformation", () => {
  test("transforms a single entity type", () => {
    // Given: Simplest possible arkType scope
    const SimpleDomain = scope({
      User: {
        id: "string.uuid",
        name: "string"
      }
    })

    // When: we transform it
    const result = createStoreFromScope(SimpleDomain)

    // Then: we get the expected structure
    expect(result.models).toBeDefined()
    expect(result.models.User).toBeDefined()
    expect(result.collectionModels).toBeDefined()
    expect(result.collectionModels.UserCollection).toBeDefined()
    expect(result.createStore).toBeDefined()
    expect(typeof result.createStore).toBe("function")
  })

  test("generated models can create instances", () => {
    // Given: Simple domain
    const SimpleDomain = scope({
      User: {
        id: "string.uuid",
        name: "string"
      }
    })

    // When: we transform and create instances
    const result = createStoreFromScope(SimpleDomain)
    const user = result?.models?.User?.create({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Alice"
    })

    // Then: instance has expected properties
    expect(user.id).toBe("550e8400-e29b-41d4-a716-446655440000")
    expect(user.name).toBe("Alice")
  })

  test("generated store provides working collections", () => {
    // Given: Simple domain
    const SimpleDomain = scope({
      User: {
        id: "string.uuid",
        name: "string"
      }
    })

    // When: we create a store
    const result = createStoreFromScope(SimpleDomain)
    const store = result.createStore({}) // Empty environment for now

    // Then: we can use collections
    const alice = store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Alice"
    })

    expect(store.userCollection.get("550e8400-e29b-41d4-a716-446655440001")).toBe(alice)
    expect(store.userCollection.has("550e8400-e29b-41d4-a716-446655440001")).toBe(true)
    expect(store.userCollection.all()).toContain(alice)
  })

  test("preserves arkType validation", () => {
    // Given: Domain with validation constraints
    const ConstrainedDomain = scope({
      User: {
        id: "string.uuid",
        name: "string >= 2",
        age: "number >= 18"
      }
    })

    // When: we create a store
    const result = createStoreFromScope(ConstrainedDomain)
    const store = result.createStore({})

    // Then: valid data works
    const validUser = store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Alice",
      age: 25
    })
    expect(validUser.name).toBe("Alice")

    // And: invalid data is rejected
    expect(() => {
      store.userCollection.add({
        id: "not-a-uuid", // Invalid UUID format
        name: "A", // Too short
        age: 16    // Too young
      })
    }).toThrow()
  })

  test("handles optional fields with undefined values", () => {
    // Given: Domain with optional fields
    const DomainWithOptionals = scope({
      User: {
        id: "string.uuid",
        email: "string",           // Required
        "displayName?": "string",  // Optional
        "avatarUrl?": "string",    // Optional
      }
    })

    // When: we create a store
    const result = createStoreFromScope(DomainWithOptionals)
    const store = result.createStore({})

    // Then: we can add entities with undefined optional fields
    const user = store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440000",
      email: "test@example.com",
      displayName: undefined,  // Explicitly undefined
      // avatarUrl omitted entirely
    })

    expect(user.id).toBe("550e8400-e29b-41d4-a716-446655440000")
    expect(user.email).toBe("test@example.com")
    expect(user.displayName).toBeUndefined()
    expect(user.avatarUrl).toBeUndefined()
  })

  test("validates optional fields when present", () => {
    // Given: Domain with optional fields that have constraints
    const DomainWithOptionals = scope({
      User: {
        id: "string.uuid",
        email: "string",
        "bio?": "string >= 10",  // Optional but must be >= 10 chars if present
      }
    })

    const result = createStoreFromScope(DomainWithOptionals)
    const store = result.createStore({})

    // Then: valid optional field works
    const user = store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440000",
      email: "test@example.com",
      bio: "This is a long enough bio"
    })
    expect(user.bio).toBe("This is a long enough bio")

    // And: invalid optional field is rejected
    expect(() => {
      store.userCollection.add({
        id: "550e8400-e29b-41d4-a716-446655440001",
        email: "test2@example.com",
        bio: "short"  // Too short, should fail validation
      })
    }).toThrow()
  })

  test("still validates required fields", () => {
    // Given: Domain with required and optional fields
    const DomainWithOptionals = scope({
      User: {
        id: "string.uuid",
        email: "string",           // Required
        "displayName?": "string",  // Optional
      }
    })

    const result = createStoreFromScope(DomainWithOptionals)
    const store = result.createStore({})

    // Then: missing required field fails
    expect(() => {
      store.userCollection.add({
        id: "550e8400-e29b-41d4-a716-446655440000",
        // email missing - should fail
        displayName: "Alice"
      } as any)
    }).toThrow()
  })
})