import { describe, test, expect } from "bun:test"
import { scope } from "arktype"
import { getSnapshot, isStateTreeNode } from "mobx-state-tree"

// This import will fail initially (TDD)
import { enhancedJsonSchemaToMST } from "../enhanced-json-schema-to-mst"
import { arkTypeToEnhancedJsonSchema } from "../arktype-to-json-schema"

describe("Enhanced JSON Schema to MST", () => {
  test("converts basic enhanced schema with x-metadata", () => {
    // Given: Enhanced schema from arktype with constraints
    const UserType = scope({
      User: {
        id: "string.uuid",
        name: "string >= 2",
        age: "number >= 18"
      }
    })

    const enhancedSchema = arkTypeToEnhancedJsonSchema(UserType)

    // When: Converting to MST
    const result = enhancedJsonSchemaToMST(enhancedSchema)

    // Then: We get MST models with validation
    expect(result.models).toBeDefined()
    expect(result.models.User).toBeDefined()

    // Should create valid instances
    const user = result?.models?.User?.create({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Alice",
      age: 25
    })

    expect(user.id).toBe("550e8400-e29b-41d4-a716-446655440000")
    expect(user.name).toBe("Alice")
    expect(user.age).toBe(25)

    // Should reject invalid data
    expect(() => {
      result?.models?.User?.create({
        id: "not-a-uuid",
        name: "A", // Too short
        age: 16 // Too young
      })
    }).toThrow()
  })

  test("resolves $ref to MST references", () => {
    // Given: Schema with entity references
    const Domain = scope({
      User: {
        id: "string.uuid",
        name: "string",
        company: "Company"
      },
      Company: {
        id: "string.uuid",
        name: "string"
      }
    })

    const enhancedSchema = arkTypeToEnhancedJsonSchema(Domain)

    // When: Converting to MST
    const result = enhancedJsonSchemaToMST(enhancedSchema)

    // Then: References are properly set up
    const store = result.createStore()

    // Add a company first
    store.companyCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "TechCorp"
    })

    // Add user with company reference
    const user = store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Bob",
      company: "550e8400-e29b-41d4-a716-446655440001" // Reference by ID
    })

    // Reference should resolve
    expect(user.company).toBeDefined()
    expect(user.company.name).toBe("TechCorp")
  })

  test("handles array references with x-reference-type", () => {
    // Given: Schema with array references
    const Domain = scope({
      Company: {
        id: "string.uuid",
        name: "string",
        employees: "User[]"
      },
      User: {
        id: "string.uuid",
        name: "string"
      }
    })

    const enhancedSchema = arkTypeToEnhancedJsonSchema(Domain)

    // When: Converting to MST
    const result = enhancedJsonSchemaToMST(enhancedSchema)
    const store = result.createStore()

    // Then: Can work with array references
    store.userCollection.add({ id: "550e8400-e29b-41d4-a716-446655440003", name: "Alice" })
    store.userCollection.add({ id: "550e8400-e29b-41d4-a716-446655440004", name: "Bob" })

    const company = store.companyCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440005",
      name: "TechCorp",
      employees: ["550e8400-e29b-41d4-a716-446655440003", "550e8400-e29b-41d4-a716-446655440004"] // Array of IDs
    })

    expect(company.employees).toHaveLength(2)
    expect(company.employees[0].name).toBe("Alice")
    expect(company.employees[1].name).toBe("Bob")
  })

  test("creates computed views from x-computed metadata", () => {
    // Given: Schema with computed array detection
    const Domain = scope({
      User: {
        id: "string.uuid",
        name: "string",
        company: "Company" // Single reference
      },
      Company: {
        id: "string.uuid",
        name: "string",
        employees: "User[]" // Will be detected as computed
      }
    })

    const enhancedSchema = arkTypeToEnhancedJsonSchema(Domain)

    // When: Converting to MST
    const result = enhancedJsonSchemaToMST(enhancedSchema)
    const store = result.createStore()

    // Then: Company.employees is a computed view
    const company = store.companyCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440006",
      name: "TechCorp"
      // Note: no employees array in snapshot
    }) as typeof Domain.t.Company

    // Add users with company reference
    store.userCollection.add({ id: "550e8400-e29b-41d4-a716-446655440007", name: "Alice", company: "550e8400-e29b-41d4-a716-446655440006" })
    store.userCollection.add({ id: "550e8400-e29b-41d4-a716-446655440008", name: "Bob", company: "550e8400-e29b-41d4-a716-446655440006" })
    store.userCollection.add({ id: "550e8400-e29b-41d4-a716-446655440009", name: "Charlie", company: "550e8400-e29b-41d4-a716-446655440010" }) // Different company

    // Computed view automatically shows employees
    expect(company.employees).toHaveLength(2)
    expect(company.employees.map(e => e.name)).toEqual(["Alice", "Bob"])

    // Snapshot should not include computed property
    const snapshot = getSnapshot(company as any)
    expect(snapshot).not.toHaveProperty("employees")
  })

  test("uses types.identifier for x-mst-type fields", () => {
    // Given: Schema with identifier fields
    const UserType = scope({
      User: {
        id: "string.uuid",
        email: "string.email",
        name: "string"
      }
    })

    const enhancedSchema = arkTypeToEnhancedJsonSchema(UserType)

    // When: Converting to MST
    const result = enhancedJsonSchemaToMST(enhancedSchema)

    // Then: ID field uses types.identifier
    const store = result.createStore()
    const user = store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      email: "alice@example.com",
      name: "Alice"
    })

    // Can look up by identifier
    expect(store.userCollection.get("550e8400-e29b-41d4-a716-446655440011")).toBe(user)
    expect(user.id).toBe("550e8400-e29b-41d4-a716-446655440011")
  })

  test("preserves embedded arrays", () => {
    // Given: Schema with embedded arrays
    const UserType = scope({
      User: {
        id: "string",
        tags: "string[]",
        scores: "number[]",
        addresses: [{
          street: "string",
          city: "string"
        }]
      }
    })

    const enhancedSchema = arkTypeToEnhancedJsonSchema(UserType)

    // When: Converting to MST
    const result = enhancedJsonSchemaToMST(enhancedSchema)

    // Then: Arrays work as expected
    const user = result?.models?.User?.create({
      id: "550e8400-e29b-41d4-a716-446655440012",
      tags: ["developer", "designer"],
      scores: [95, 87, 92],
      addresses: [
        { street: "123 Main St", city: "Boston" },
        { street: "456 Oak Ave", city: "Cambridge" }
      ]
    })

    expect(user.tags).toEqual(["developer", "designer"])
    expect(user.scores).toEqual([95, 87, 92])
    expect(user.addresses[0].street).toBe("123 Main St")
    expect(user.addresses[1].city).toBe("Cambridge")

    // Arrays in MST are protected and cannot be mutated directly without actions
    // This is by design - all state changes must go through actions
    expect(() => user.tags.push("manager")).toThrow()
  })

  test("handles optional properties", () => {
    // Given: Schema with optional fields
    const UserType = scope({
      User: {
        id: "string",
        name: "string",
        "nickname?": "string",
        "age?": "number"
      }
    })

    const enhancedSchema = arkTypeToEnhancedJsonSchema(UserType)

    // When: Converting to MST
    const result = enhancedJsonSchemaToMST(enhancedSchema)

    // Then: Optional properties work correctly
    const user1 = result?.models?.User?.create({
      id: "550e8400-e29b-41d4-a716-446655440013",
      name: "Alice"
      // No nickname or age
    })

    expect(user1.name).toBe("Alice")
    expect(user1.nickname).toBeUndefined()
    expect(user1.age).toBeUndefined()

    const user2 = result?.models?.User?.create({
      id: "550e8400-e29b-41d4-a716-446655440014",
      name: "Bob",
      nickname: "Bobby",
      age: 30
    })

    expect(user2.nickname).toBe("Bobby")
    expect(user2.age).toBe(30)
  })

  test("creates field-level validation actions", () => {
    // Given: Schema with constraints
    const UserType = scope({
      User: {
        id: "string",
        name: "string >= 2",
        age: "number >= 0 & number <= 150"
      }
    })

    const enhancedSchema = arkTypeToEnhancedJsonSchema(UserType)

    // When: Converting to MST with action generation
    const result = enhancedJsonSchemaToMST(enhancedSchema, {
      generateActions: true,
      arkTypeScope: UserType
    })

    // Then: Models have setter actions with validation
    const user = result?.models?.User?.create({
      id: "550e8400-e29b-41d4-a716-446655440015",
      name: "Alice",
      age: 25
    })

    // Valid updates work
    user.setName("Alexandra")
    expect(user.name).toBe("Alexandra")

    user.setAge(30)
    expect(user.age).toBe(30)

    // Invalid updates throw
    expect(() => user.setName("A")).toThrow() // Too short
    expect(() => user.setAge(200)).toThrow() // Too old
    expect(() => user.setAge(-5)).toThrow() // Negative
  })

  test("handles JSON Schema integer type", () => {
    // Given: Raw JSON Schema with integer type (common in Claude-generated schemas)
    const enhancedSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Company: {
          type: "object",
          "x-original-name": "Company",  // Required for entity detection
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            employeeCount: { type: "integer" },  // integer, not number
            revenue: { type: "integer", minimum: 0 },  // integer with minimum
            rating: { type: "number" }  // regular number for comparison
          },
          required: ["id", "name", "employeeCount", "rating"]
        }
      }
    }

    // When: Converting to MST
    const result = enhancedJsonSchemaToMST(enhancedSchema)

    // Then: Integer fields work as numbers
    const company = result?.models?.Company?.create({
      id: "550e8400-e29b-41d4-a716-446655440099",
      name: "TechCorp",
      employeeCount: 50,
      revenue: 1000000,
      rating: 4.5
    })

    expect(company.employeeCount).toBe(50)
    expect(company.revenue).toBe(1000000)
    expect(company.rating).toBe(4.5)

    // Can update integer fields with numbers
    const store = result.createStore()
    const stored = store.companyCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440100",
      name: "StartupCo",
      employeeCount: 10,
      rating: 3.8
    })

    expect(stored.employeeCount).toBe(10)
  })

  test("full document conversion with all features", () => {
    // Given: Complete domain with all features
    const Domain = scope({
      User: {
        id: "string.uuid",
        name: "string >= 2",
        email: "string.email",
        company: "Company",
        "bio?": "string",
        tags: "string[]",
        scores: "number[]"
      },
      Company: {
        id: "string.uuid",
        name: "string",
        employees: "User[]", // Computed
        "description?": "string"
      }
    })

    const enhancedSchema = arkTypeToEnhancedJsonSchema(Domain)

    // When: Converting to MST
    const result = enhancedJsonSchemaToMST(enhancedSchema)

    // Then: Everything works together
    expect(result.models.User).toBeDefined()
    expect(result.models.Company).toBeDefined()
    expect(result.createStore).toBeDefined()

    const store = result.createStore()

    // Create a company
    const techCorp = store.companyCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440016",
      name: "TechCorp",
      description: "A tech company"
    })

    // Create users
    const alice = store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440017",
      name: "Alice",
      email: "alice@techcorp.com",
      company: "550e8400-e29b-41d4-a716-446655440016",
      tags: ["developer", "lead"],
      scores: [95, 92]
    })

    const bob = store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440018",
      name: "Bob",
      email: "bob@techcorp.com",
      company: "550e8400-e29b-41d4-a716-446655440016",
      bio: "Senior developer",
      tags: ["developer"],
      scores: [88, 90, 85]
    })

    // Test all features
    expect(alice.company).toBe(techCorp)
    expect(bob.company).toBe(techCorp)
    expect(techCorp.employees).toHaveLength(2)
    expect(techCorp.employees).toContain(alice)
    expect(techCorp.employees).toContain(bob)

    // Test validation still works
    expect(() => {
      store.userCollection.add({
        id: "550e8400-e29b-41d4-a716-446655440019",
        name: "C", // Too short
        email: "not-an-email",
        company: "550e8400-e29b-41d4-a716-446655440016",
        tags: [],
        scores: []
      })
    }).toThrow()

    // Test MST features
    expect(isStateTreeNode(alice)).toBe(true)
    expect(store.userCollection.get("550e8400-e29b-41d4-a716-446655440017")).toBe(alice)
  })
})