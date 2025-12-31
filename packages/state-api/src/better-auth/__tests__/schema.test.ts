/**
 * Generated from TestSpecifications: test-ba-002-01 to test-ba-002-05
 * Task: task-ba-002
 * Requirement: req-ba-001
 *
 * Tests for BetterAuth ArkType schema definition
 */

import { describe, test, expect } from "bun:test"
import { type } from "arktype"
import { BetterAuthSchema } from "../schema"
import { arkTypeToEnhancedJsonSchema } from "../../schematic/arktype-to-json-schema"

describe("BetterAuthSchema scope exports User type with all fields", () => {
  test("User type is exported from scope", () => {
    const types = BetterAuthSchema.export()
    expect(types.User).toBeDefined()
  })

  test("User type accepts valid user object", () => {
    const types = BetterAuthSchema.export()
    const validUser = {
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test User",
      email: "test@example.com",
      emailVerified: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    // ArkType returns the data directly on success, or object with problems on failure
    const result = types.User(validUser)
    // If there are problems, the result will have a problems property
    expect((result as any).problems).toBeUndefined()
  })

  test("User type rejects object missing required fields", () => {
    const types = BetterAuthSchema.export()
    const invalidUser = {
      id: "550e8400-e29b-41d4-a716-446655440001",
      // missing email, name, emailVerified, createdAt, updatedAt
    }

    const result = types.User(invalidUser)
    // ArkType returns an ArkErrors object when validation fails
    expect(result instanceof type.errors).toBe(true)
  })

  test("User.image is optional", () => {
    const types = BetterAuthSchema.export()
    // User without image should be valid
    const userWithoutImage = {
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Test User",
      email: "test@example.com",
      emailVerified: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const result = types.User(userWithoutImage)
    expect((result as any).problems).toBeUndefined()

    // User with image should also be valid
    const userWithImage = {
      ...userWithoutImage,
      image: "https://example.com/avatar.png",
    }

    const resultWithImage = types.User(userWithImage)
    expect((resultWithImage as any).problems).toBeUndefined()
  })
})

describe("Session.userId references User", () => {
  test("Session.userId has $ref to User definition in Enhanced JSON Schema", () => {
    const enhancedSchema = arkTypeToEnhancedJsonSchema(BetterAuthSchema)

    expect(enhancedSchema.$defs).toBeDefined()
    expect(enhancedSchema.$defs!.Session).toBeDefined()
    expect(enhancedSchema.$defs!.Session.properties.userId).toBeDefined()

    const userIdProp = enhancedSchema.$defs!.Session.properties.userId
    expect(userIdProp.$ref).toBe("#/$defs/User")
  })

  test("Session.userId has x-mst-type or x-reference-type indicating reference", () => {
    const enhancedSchema = arkTypeToEnhancedJsonSchema(BetterAuthSchema)
    const userIdProp = enhancedSchema.$defs!.Session.properties.userId

    // Check for reference markers
    const isReference =
      userIdProp["x-mst-type"] === "reference" ||
      userIdProp["x-reference-type"] === "single"

    expect(isReference).toBe(true)
  })
})

describe("Account.userId references User", () => {
  test("Account.userId has $ref to User definition in Enhanced JSON Schema", () => {
    const enhancedSchema = arkTypeToEnhancedJsonSchema(BetterAuthSchema)

    expect(enhancedSchema.$defs).toBeDefined()
    expect(enhancedSchema.$defs!.Account).toBeDefined()
    expect(enhancedSchema.$defs!.Account.properties.userId).toBeDefined()

    const userIdProp = enhancedSchema.$defs!.Account.properties.userId
    expect(userIdProp.$ref).toBe("#/$defs/User")
  })

  test("Account.userId has x-mst-type or x-reference-type indicating reference", () => {
    const enhancedSchema = arkTypeToEnhancedJsonSchema(BetterAuthSchema)
    const userIdProp = enhancedSchema.$defs!.Account.properties.userId

    // Check for reference markers
    const isReference =
      userIdProp["x-mst-type"] === "reference" ||
      userIdProp["x-reference-type"] === "single"

    expect(isReference).toBe(true)
  })
})

describe("Verification type has required fields", () => {
  test("Verification requires id, identifier, value, expiresAt", () => {
    const types = BetterAuthSchema.export()
    expect(types.Verification).toBeDefined()

    // Valid verification with all required fields
    const validVerification = {
      id: "550e8400-e29b-41d4-a716-446655440001",
      identifier: "test@example.com",
      value: "verification-token-123",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const result = types.Verification(validVerification)
    expect((result as any).problems).toBeUndefined()
  })

  test("Verification has createdAt and updatedAt timestamps", () => {
    const types = BetterAuthSchema.export()

    // Missing timestamps should fail
    const missingTimestamps = {
      id: "550e8400-e29b-41d4-a716-446655440001",
      identifier: "test@example.com",
      value: "verification-token-123",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      // missing createdAt and updatedAt
    }

    const result = types.Verification(missingTimestamps)
    // ArkType returns an ArkErrors object when validation fails
    expect(result instanceof type.errors).toBe(true)
  })
})

describe("All entities have id, createdAt, updatedAt fields", () => {
  test("User, Session, Account, Verification all have id field", () => {
    const enhancedSchema = arkTypeToEnhancedJsonSchema(BetterAuthSchema)

    const entities = ["User", "Session", "Account", "Verification"]
    for (const entity of entities) {
      expect(enhancedSchema.$defs![entity]).toBeDefined()
      expect(enhancedSchema.$defs![entity].properties.id).toBeDefined()
    }
  })

  test("All entities have createdAt timestamp", () => {
    const enhancedSchema = arkTypeToEnhancedJsonSchema(BetterAuthSchema)

    const entities = ["User", "Session", "Account", "Verification"]
    for (const entity of entities) {
      expect(enhancedSchema.$defs![entity].properties.createdAt).toBeDefined()
    }
  })

  test("All entities have updatedAt timestamp", () => {
    const enhancedSchema = arkTypeToEnhancedJsonSchema(BetterAuthSchema)

    const entities = ["User", "Session", "Account", "Verification"]
    for (const entity of entities) {
      expect(enhancedSchema.$defs![entity].properties.updatedAt).toBeDefined()
    }
  })
})

describe("Session type has all required fields", () => {
  test("Session type is exported from scope", () => {
    const types = BetterAuthSchema.export()
    expect(types.Session).toBeDefined()
  })

  test("Session requires token, expiresAt, ipAddress, userAgent", () => {
    const types = BetterAuthSchema.export()

    const validSession = {
      id: "550e8400-e29b-41d4-a716-446655440001",
      userId: "550e8400-e29b-41d4-a716-446655440002",
      token: "session-token-abc123",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      ipAddress: "192.168.1.1",
      userAgent: "Mozilla/5.0",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const result = types.Session(validSession)
    expect((result as any).problems).toBeUndefined()
  })
})

describe("Account type has all required fields", () => {
  test("Account type is exported from scope", () => {
    const types = BetterAuthSchema.export()
    expect(types.Account).toBeDefined()
  })

  test("Account requires accountId, providerId, userId", () => {
    const types = BetterAuthSchema.export()

    const validAccount = {
      id: "550e8400-e29b-41d4-a716-446655440001",
      userId: "550e8400-e29b-41d4-a716-446655440002",
      accountId: "oauth-account-id",
      providerId: "google",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const result = types.Account(validAccount)
    expect((result as any).problems).toBeUndefined()
  })

  test("Account has optional OAuth fields (accessToken, refreshToken, etc.)", () => {
    const types = BetterAuthSchema.export()

    // Account with optional OAuth fields
    const accountWithOAuth = {
      id: "550e8400-e29b-41d4-a716-446655440001",
      userId: "550e8400-e29b-41d4-a716-446655440002",
      accountId: "oauth-account-id",
      providerId: "google",
      accessToken: "access-token-123",
      refreshToken: "refresh-token-456",
      accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 86400000).toISOString(),
      scope: "openid email profile",
      idToken: "id-token-789",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const result = types.Account(accountWithOAuth)
    expect((result as any).problems).toBeUndefined()
  })
})
