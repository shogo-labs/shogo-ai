import { describe, test, expect } from "bun:test"
import { scope } from "arktype"

// This import will fail initially (TDD)
import { createStoreFromScope } from "../index"

describe("Reference transformation", () => {
  test("transforms single entity references", () => {
    // Given: Domain with single reference
    const BusinessDomain = scope({
      User: { 
        id: "string.uuid", 
        name: "string",
        company: "Company"  // Reference to Company
      },
      Company: {
        id: "string.uuid",
        name: "string"
      }
    })

    // When: we create a store
    const result = createStoreFromScope(BusinessDomain)
    const store = result.createStore({})

    // First create the company
    const acme = store.companyCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "ACME Corp"
    })

    // Then create user with reference
    const alice = store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Alice",
      company: "550e8400-e29b-41d4-a716-446655440000"  // Reference by ID
    })

    // Then: MST resolves the reference
    expect(alice.company).toBe(acme)
    expect(alice.company.name).toBe("ACME Corp")
  })

  test("transforms array references as computed views", () => {
    // Given: Domain with array reference
    const BusinessDomain = scope({
      User: { 
        id: "string.uuid", 
        name: "string",
        company: "Company"  // Normalized: each user has one company
      },
      Company: {
        id: "string.uuid",
        name: "string",
        employees: "User[]"  // Computed: all users with this company
      }
    })

    // When: we create a store
    const result = createStoreFromScope(BusinessDomain)
    const store = result.createStore({})

    // Create company (no employees field needed)
    const acme = store.companyCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "ACME Corp"
    })

    // Initially, computed employees view is empty
    expect(acme.employees).toHaveLength(0)

    // Create users with company reference
    const alice = store.userCollection.add({ 
      id: "550e8400-e29b-41d4-a716-446655440003", 
      name: "Alice",
      company: "550e8400-e29b-41d4-a716-446655440002"  // This establishes the relationship
    })
    
    // Then: Company.employees updates automatically
    expect(acme.employees).toHaveLength(1)
    expect(acme.employees[0]).toBe(alice)

    // Add another employee
    const bob = store.userCollection.add({ 
      id: "550e8400-e29b-41d4-a716-446655440004", 
      name: "Bob",
      company: "550e8400-e29b-41d4-a716-446655440002"
    })

    // Computed view updates again
    expect(acme.employees).toHaveLength(2)
    expect(acme.employees).toContain(alice)
    expect(acme.employees).toContain(bob)
  })

  test("array references update when normalized data changes", () => {
    // Given: Domain with relationships
    const BusinessDomain = scope({
      User: { 
        id: "string.uuid", 
        name: "string",
        company: "Company"
      },
      Company: {
        id: "string.uuid",
        name: "string",
        employees: "User[]"  // Computed view
      }
    })

    const result = createStoreFromScope(BusinessDomain)
    const store = result.createStore({})

    // Create two companies
    const acme = store.companyCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440005",
      name: "ACME Corp"
    })

    const newCorp = store.companyCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440006",
      name: "NewCorp"
    })

    // Create user at ACME
    const alice = store.userCollection.add({ 
      id: "550e8400-e29b-41d4-a716-446655440007", 
      name: "Alice",
      company: "550e8400-e29b-41d4-a716-446655440005"
    })

    // Verify initial state
    expect(acme.employees).toHaveLength(1)
    expect(newCorp.employees).toHaveLength(0)

    // When: Alice changes companies (however we implement this)
    // This is a design decision - could be:
    // alice.setCompany("c2") or
    // alice.company = newCorp or
    // alice.update({ company: "c2" })
    alice.setCompany(newCorp)  // Using MST action for reference assignment

    // Then: Both computed views update
    expect(acme.employees).toHaveLength(0)
    expect(newCorp.employees).toHaveLength(1)
    expect(newCorp.employees[0]).toBe(alice)
  })

  test("handles optional references", () => {
    // Given: Domain with optional references
    const BusinessDomain = scope({
      User: { 
        id: "string.uuid", 
        name: "string",
        "company?": "Company"  // Optional reference
      },
      Company: {
        id: "string.uuid",
        name: "string",
        employees: "User[]"  // Only includes users with this company
      }
    })

    const result = createStoreFromScope(BusinessDomain)
    const store = result.createStore({})

    // Create user without company
    const freelancer = store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440008",
      name: "Freelancer"
      // No company specified
    })

    // Then: Optional reference is undefined
    expect(freelancer.company).toBeUndefined()

    // Create company and employee
    const acme = store.companyCollection.add({ 
      id: "550e8400-e29b-41d4-a716-446655440009", 
      name: "ACME"
    })
    
    const employee = store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      name: "Employee",
      company: "550e8400-e29b-41d4-a716-446655440009"
    })

    // Verify relationships
    expect(employee.company).toBe(acme)
    expect(acme.employees).toHaveLength(1)
    expect(acme.employees).toContain(employee)
    expect(acme.employees).not.toContain(freelancer)  // Freelancer not included
  })

  test("handles missing reference targets gracefully", () => {
    // Given: Domain with required reference
    const BusinessDomain = scope({
      User: { 
        id: "string.uuid", 
        name: "string",
        company: "Company"  // Required reference
      },
      Company: {
        id: "string.uuid",
        name: "string",
        employees: "User[]"
      }
    })

    const result = createStoreFromScope(BusinessDomain)
    const store = result.createStore({})

    // When: Creating user with non-existent company reference
    const user = store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      name: "Alice",
      company: "550e8400-e29b-41d4-a716-446655440999"  // Non-existent but valid UUID
    })

    // Then: User is created successfully (lazy validation)
    expect(user.id).toBe("550e8400-e29b-41d4-a716-446655440011")
    expect(user.name).toBe("Alice")
    
    // But: Accessing the invalid reference returns undefined (graceful handling)
    expect(user.company).toBeUndefined()
  })

  test("handles self-references with computed views", () => {
    // Given: Domain with self-reference
    const OrgDomain = scope({
      Employee: {
        id: "string.uuid",
        name: "string",
        "manager?": "Employee",  // Normalized: who this person reports to
        reports: "Employee[]"    // Computed: who reports to this person
      }
    })

    const result = createStoreFromScope(OrgDomain)
    const store = result.createStore({})

    // Create organizational hierarchy
    const ceo = store.employeeCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440012",
      name: "CEO"
      // No manager
    })

    const manager = store.employeeCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440013",
      name: "Manager",
      manager: "550e8400-e29b-41d4-a716-446655440012"
    })

    const employee = store.employeeCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440014",
      name: "Employee",
      manager: "550e8400-e29b-41d4-a716-446655440013"
    })

    // Then: Normalized references work
    expect(manager.manager).toBe(ceo)
    expect(employee.manager).toBe(manager)
    expect(ceo.manager).toBeUndefined()
    
    // And: Computed views work
    expect(ceo.reports).toHaveLength(1)
    expect(ceo.reports[0]).toBe(manager)
    expect(manager.reports).toHaveLength(1)
    expect(manager.reports[0]).toBe(employee)
    expect(employee.reports).toHaveLength(0)
  })

  test("handles multi-word entity names with proper camelCase collection naming", () => {
    // Given: Domain with multi-word entity names (camelCase)
    // This tests that "AuthUser" → "authUserCollection" (not "authuserCollection")
    const AuthDomain = scope({
      AuthUser: {
        id: "string.uuid",
        email: "string",
      },
      AuthSession: {
        id: "string.uuid",
        user: "AuthUser",  // Reference to multi-word entity
        expiresAt: "number",
      }
    })

    // When: we create a store
    const result = createStoreFromScope(AuthDomain)
    const store = result.createStore({})

    // Then: collections use proper camelCase naming
    expect(store.authUserCollection).toBeDefined()
    expect(store.authSessionCollection).toBeDefined()

    // And: we can add entities and resolve references
    const user = store.authUserCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440020",
      email: "test@example.com"
    })

    const session = store.authSessionCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440021",
      user: "550e8400-e29b-41d4-a716-446655440020",
      expiresAt: Date.now() + 3600000
    })

    // Then: reference resolves correctly through camelCase collection
    expect(session.user).toBe(user)
    expect(session.user.email).toBe("test@example.com")
  })

  test("handles three-word entity names", () => {
    // Given: Domain with three-word entity name
    const InventoryDomain = scope({
      ProductCategory: {
        id: "string.uuid",
        name: "string",
      },
      ProductCategoryItem: {
        id: "string.uuid",
        category: "ProductCategory",  // Reference to three-word entity
        sku: "string",
      }
    })

    const result = createStoreFromScope(InventoryDomain)
    const store = result.createStore({})

    // Then: collections use proper camelCase naming
    expect(store.productCategoryCollection).toBeDefined()
    expect(store.productCategoryItemCollection).toBeDefined()

    // And: references work correctly
    const category = store.productCategoryCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440030",
      name: "Electronics"
    })

    const item = store.productCategoryItemCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440031",
      category: "550e8400-e29b-41d4-a716-446655440030",
      sku: "ELEC-001"
    })

    expect(item.category).toBe(category)
    expect(item.category.name).toBe("Electronics")
  })
})

describe("Collection filtering with references", () => {
  test("where() filters by reference field using ID string", () => {
    // Given: Domain with references
    const BusinessDomain = scope({
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

    const result = createStoreFromScope(BusinessDomain)
    const store = result.createStore({})

    // Create companies
    store.companyCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440100",
      name: "ACME Corp"
    })
    store.companyCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440101",
      name: "NewCorp"
    })

    // Create users at different companies
    store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440102",
      name: "Alice",
      company: "550e8400-e29b-41d4-a716-446655440100"
    })
    store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440103",
      name: "Bob",
      company: "550e8400-e29b-41d4-a716-446655440100"
    })
    store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440104",
      name: "Charlie",
      company: "550e8400-e29b-41d4-a716-446655440101"
    })

    // When: filtering by reference field with ID string
    const acmeUsers = store.userCollection.where({ company: "550e8400-e29b-41d4-a716-446655440100" })

    // Then: returns users with matching reference
    expect(acmeUsers).toHaveLength(2)
    expect(acmeUsers.map((u: any) => u.name).sort()).toEqual(["Alice", "Bob"])
  })

  test("findBy() filters by reference field using ID string", () => {
    // Given: Domain with references
    const BusinessDomain = scope({
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

    const result = createStoreFromScope(BusinessDomain)
    const store = result.createStore({})

    store.companyCollection.add({ id: "550e8400-e29b-41d4-a716-446655440110", name: "ACME" })
    store.userCollection.add({ id: "550e8400-e29b-41d4-a716-446655440111", name: "Alice", company: "550e8400-e29b-41d4-a716-446655440110" })
    store.userCollection.add({ id: "550e8400-e29b-41d4-a716-446655440112", name: "Bob", company: "550e8400-e29b-41d4-a716-446655440110" })

    // When: using findBy with reference field
    const acmeUsers = store.userCollection.findBy("company", "550e8400-e29b-41d4-a716-446655440110")

    // Then: returns matching users
    expect(acmeUsers).toHaveLength(2)
  })

  test("where() still works with scalar fields", () => {
    // Ensure we don't break existing scalar filtering
    const BusinessDomain = scope({
      User: {
        id: "string.uuid",
        name: "string",
        role: "string"
      }
    })

    const result = createStoreFromScope(BusinessDomain)
    const store = result.createStore({})

    store.userCollection.add({ id: "550e8400-e29b-41d4-a716-446655440120", name: "Alice", role: "admin" })
    store.userCollection.add({ id: "550e8400-e29b-41d4-a716-446655440121", name: "Bob", role: "user" })
    store.userCollection.add({ id: "550e8400-e29b-41d4-a716-446655440122", name: "Charlie", role: "admin" })

    const admins = store.userCollection.where({ role: "admin" })
    expect(admins).toHaveLength(2)
  })

  test("where() handles optional reference fields", () => {
    const BusinessDomain = scope({
      User: {
        id: "string.uuid",
        name: "string",
        "company?": "Company"
      },
      Company: {
        id: "string.uuid",
        name: "string"
      }
    })

    const result = createStoreFromScope(BusinessDomain)
    const store = result.createStore({})

    store.companyCollection.add({ id: "550e8400-e29b-41d4-a716-446655440130", name: "ACME" })
    store.userCollection.add({ id: "550e8400-e29b-41d4-a716-446655440131", name: "Alice", company: "550e8400-e29b-41d4-a716-446655440130" })
    store.userCollection.add({ id: "550e8400-e29b-41d4-a716-446655440132", name: "Freelancer" }) // No company

    // Filter for users with specific company
    const acmeUsers = store.userCollection.where({ company: "550e8400-e29b-41d4-a716-446655440130" })
    expect(acmeUsers).toHaveLength(1)
    expect(acmeUsers[0].name).toBe("Alice")
  })
})