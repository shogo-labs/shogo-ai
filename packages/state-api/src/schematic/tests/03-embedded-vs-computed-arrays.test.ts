import { describe, test, expect } from "bun:test"
import { scope } from "arktype"
import { getSnapshot } from "mobx-state-tree"

// This import will fail initially (TDD)
import { createStoreFromScope } from "../index"

describe("Embedded vs Computed Arrays", () => {
  test("embedded primitive arrays are stored directly", () => {
    // Given: Domain with embedded primitive arrays
    const Domain = scope({
      User: {
        id: "string.uuid",
        name: "string",
        tags: "string[]",
        scores: "number[]"
      }
    })

    const result = createStoreFromScope(Domain)
    const store = result.createStore({})

    // When: Creating entity with array data
    const user = store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Alice",
      tags: ["frontend", "react", "typescript"],
      scores: [95, 87, 91]
    })

    // Then: Arrays are stored in snapshot
    const snapshot = getSnapshot(user)
    expect(snapshot).toEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Alice",
      tags: ["frontend", "react", "typescript"],
      scores: [95, 87, 91]
    })

    // And: Arrays can be mutated using actions
    user.addTagsItem("nodejs")
    user.updateScoresItem(0, 98)

    expect(user.tags).toEqual(["frontend", "react", "typescript", "nodejs"])
    expect(user.scores[0]).toBe(98)
  })

  test("embedded object arrays are stored directly", () => {
    // Given: Domain with embedded object arrays
    const Domain = scope({
      User: {
        id: "string.uuid",
        name: "string",
        addresses: [{
          street: "string",
          city: "string",
          zip: "string"
        }],
        phoneNumbers: [{
          type: "'home' | 'work' | 'mobile'",
          number: "string"
        }]
      }
    })

    const result = createStoreFromScope(Domain)
    const store = result.createStore({})

    // When: Creating entity with complex array data
    const user = store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Alice",
      addresses: [
        { street: "123 Main St", city: "Boston", zip: "02101" }
      ],
      phoneNumbers: [
        { type: "home", number: "555-1234" }
      ]
    })

    // Then: Complex arrays are stored in snapshot
    const snapshot = getSnapshot(user) as (typeof Domain.t.User);
    expect(snapshot.addresses).toHaveLength(1)
    expect(snapshot.addresses[0].street).toBe("123 Main St")
    expect(snapshot.phoneNumbers[0].type).toBe("home")

    // And: Can mutate complex arrays
    user.addAddressesItem({ street: "789 Elm St", city: "Somerville", zip: "02144" })
    expect(user.addresses).toHaveLength(2)
  })

  test("entity reference arrays are computed views", () => {
    // Given: Domain with entity references
    const Domain = scope({
      User: {
        id: "string.uuid",
        name: "string",
        company: "Company",
        projects: "Project[]"  // Could be computed or embedded?
      },
      Company: {
        id: "string.uuid",
        name: "string",
        employees: "User[]"  // Definitely computed (inverse of User.company)
      },
      Project: {
        id: "string.uuid",
        title: "string",
        members: "User[]"  // Computed view
      }
    })

    const result = createStoreFromScope(Domain)
    const store = result.createStore({})

    // Create company
    const acme = store.companyCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "ACME"
      // Note: no employees array in creation
    })

    // Create user
    const alice = store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440003",
      name: "Alice",
      company: "550e8400-e29b-41d4-a716-446655440002"
      // Note: projects might be computed too
    })

    // Then: Company snapshot has no employees array
    const companySnapshot = getSnapshot(acme)
    expect(companySnapshot).toEqual({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "ACME"
      // No employees in snapshot!
    })

    // But: Computed view still works
    expect(acme.employees).toHaveLength(1)
    expect(acme.employees[0]).toBe(alice)

    // And: Cannot mutate computed arrays
    expect(() => {
      acme.addEmployeesItem(alice)  // Should throw - computed arrays cannot be mutated
    }).toThrow()
  })

  test("mixed arrays in same model", () => {
    // Given: Model with both embedded and computed arrays
    const Domain = scope({
      User: {
        id: "string.uuid",
        name: "string",
        tags: "string[]",  // Embedded
        company: "Company"
      },
      Company: {
        id: "string.uuid",
        name: "string",
        locations: "string[]",  // Embedded
        employees: "User[]"     // Computed
      }
    })

    const result = createStoreFromScope(Domain)
    const store = result.createStore({})

    // Create company with embedded data
    const acme = store.companyCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440004",
      name: "ACME",
      locations: ["Boston", "New York", "SF"]
    })

    // Create user
    store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440005",
      name: "Alice",
      tags: ["engineer", "senior"],
      company: "550e8400-e29b-41d4-a716-446655440004"
    })

    // Then: Snapshot shows only embedded arrays
    const snapshot = getSnapshot(acme)
    expect(snapshot).toEqual({
      id: "550e8400-e29b-41d4-a716-446655440004",
      name: "ACME",
      locations: ["Boston", "New York", "SF"]
      // No employees array
    })

    // Embedded array is mutable
    acme.addLocationsItem("Seattle")
    expect(acme.locations).toHaveLength(4)

    // Computed array is read-only but reactive
    expect(acme.employees).toHaveLength(1)
  })

  test("arkType validation applies to embedded arrays", () => {
    // Given: Domain with constrained arrays
    const Domain = scope({
      User: {
        id: "string.uuid",
        name: "string",
        tags: "(string >= 2)[]",  // Each tag must be 2+ chars
        scores: "(number >= 0 & number <= 100)[]"  // Each score 0-100
      }
    })

    const result = createStoreFromScope(Domain)
    const store = result.createStore({})

    // Then: Valid data works
    const user = store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440006",
      name: "Alice",
      tags: ["frontend", "backend"],
      scores: [95, 87]
    })
    expect(user.tags).toEqual(["frontend", "backend"])

    // And: Invalid data in arrays is rejected
    expect(() => {
      store.userCollection.add({
        id: "550e8400-e29b-41d4-a716-446655440007",
        name: "Bob",
        tags: ["a"],  // Too short
        scores: [95]
      })
    }).toThrow()

    expect(() => {
      store.userCollection.add({
        id: "550e8400-e29b-41d4-a716-446655440008",
        name: "Charlie",
        tags: ["valid"],
        scores: [101]  // Out of range
      })
    }).toThrow()
  })

  test("updates to normalized data affect computed views", () => {
    // Given: Domain with relationships
    const Domain = scope({
      User: {
        id: "string.uuid",
        name: "string",
        "company?": "Company"  // Optional to allow transfers
      },
      Company: {
        id: "string.uuid",
        name: "string",
        employees: "User[]"  // Computed from User.company
      }
    })

    const result = createStoreFromScope(Domain)
    const store = result.createStore({})

    // Create two companies
    const acme = store.companyCollection.add({ id: "550e8400-e29b-41d4-a716-446655440009", name: "ACME" })
    const tech = store.companyCollection.add({ id: "550e8400-e29b-41d4-a716-446655440010", name: "TechCorp" })

    // Create users at different companies
    const alice = store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      name: "Alice",
      company: "550e8400-e29b-41d4-a716-446655440009"
    })
    const bob = store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440012",
      name: "Bob",
      company: "550e8400-e29b-41d4-a716-446655440009"
    })

    // Initial state
    expect(acme.employees).toHaveLength(2)
    expect(tech.employees).toHaveLength(0)

    // When: Transfer employee
    alice.setCompany(tech)  // Update references using action

    // Then: Both computed views update
    expect(acme.employees).toHaveLength(1)
    expect(acme.employees[0]).toBe(bob)
    expect(tech.employees).toHaveLength(1)
    expect(tech.employees[0]).toBe(alice)
  })
})