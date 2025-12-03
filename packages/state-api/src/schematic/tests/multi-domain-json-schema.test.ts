import { describe, test, expect } from "bun:test"
import { scope } from "arktype"

// This import will fail initially (TDD)
import { arkTypeToEnhancedJsonSchema } from "../arktype-to-json-schema"

describe("Multi-Domain JSON Schema Generation", () => {
  // Test domains
  const AuthDomain = scope({
    User: {
      id: "string.uuid",
      email: "string.email",
      roles: "Role[]"
    },
    Role: {
      id: "string.uuid",
      name: "string",
      permissions: "string[]"
    }
  })

  const InventoryDomain = scope({
    Product: {
      id: "string.uuid",
      name: "string",
      sku: "string",
      price: "number",
      category: "Category"
    },
    Category: {
      id: "string.uuid",
      name: "string",
      products: "Product[]"
    }
  })

  const OrdersDomain = scope({
    // Use export() to create submodules with dot notation
    auth: AuthDomain.export(),
    inventory: InventoryDomain.export(),

    Order: {
      id: "string.uuid",
      customer: "auth.User",
      items: "OrderItem[]",
      total: "number",
      status: "'pending' | 'shipped' | 'delivered'"
    },
    OrderItem: {
      id: "string.uuid",
      order: "Order",
      product: "inventory.Product",
      quantity: "number",
      price: "number"
    }
  })

  test("accepts Record<string, Scope> and creates namespaced definitions", () => {
    // When: Converting multiple domains
    const schema = arkTypeToEnhancedJsonSchema({
      auth: AuthDomain,
      inventory: InventoryDomain,
      orders: OrdersDomain
    })

    // Then: Schema has namespaced definitions
    expect(schema.$defs).toBeDefined()
    expect(schema?.$defs!["auth.User"]).toBeDefined()
    expect(schema?.$defs!["auth.Role"]).toBeDefined()
    expect(schema?.$defs!["inventory.Product"]).toBeDefined()
    expect(schema?.$defs!["inventory.Category"]).toBeDefined()
    expect(schema?.$defs!["orders.Order"]).toBeDefined()
    expect(schema?.$defs!["orders.OrderItem"]).toBeDefined()

    // And: Each definition has x-domain metadata
    expect(schema?.$defs!["auth.User"]["x-domain"]).toBe("auth")
    expect(schema?.$defs!["inventory.Product"]["x-domain"]).toBe("inventory")
  })

  test("preserves entity structure in namespaced definitions", () => {
    // When: Converting multiple domains
    const schema = arkTypeToEnhancedJsonSchema({
      auth: AuthDomain,
      inventory: InventoryDomain
    })

    // Then: Entity structure is preserved
    const userDef = schema?.$defs!["auth.User"]
    expect(userDef.type).toBe("object")
    expect(userDef.properties.id).toBeDefined()
    expect(userDef.properties.email).toBeDefined()
    expect(userDef.properties.roles).toBeDefined()
    expect(userDef.required).toContain("id")
    expect(userDef.required).toContain("email")
    expect(userDef.required).toContain("roles")

    // And: Property metadata is preserved
    expect(userDef.properties.id.format).toBe("uuid")
    expect(userDef.properties.email.format).toBe("email")
  })

  test("handles cross-domain references with proper $refs", () => {
    // When: Converting domains with cross-references
    const schema = arkTypeToEnhancedJsonSchema({
      auth: AuthDomain,
      inventory: InventoryDomain,
      orders: OrdersDomain
    })

    // Then: Cross-domain references use namespaced $refs
    const orderDef = schema?.$defs!["orders.Order"]
    expect(orderDef.properties.customer).toEqual({
      $ref: "#/$defs/auth.User",
      "x-reference-type": "single",
      "x-arktype": "auth.User"
    })

    const orderItemDef = schema?.$defs!["orders.OrderItem"]
    expect(orderItemDef.properties.product).toEqual({
      $ref: "#/$defs/inventory.Product",
      "x-reference-type": "single",
      "x-arktype": "inventory.Product"
    })
  })

  test("handles within-domain references correctly", () => {
    // When: Converting domains
    const schema = arkTypeToEnhancedJsonSchema({
      auth: AuthDomain,
      inventory: InventoryDomain,
      orders: OrdersDomain
    })

    // Then: Within-domain references also use namespaced $refs
    const userDef = schema?.$defs!["auth.User"]
    expect(userDef.properties.roles).toEqual({
      type: "array",
      items: {
        $ref: "#/$defs/auth.Role"
      },
      "x-reference-type": "array",
      "x-arktype": "Role[]"
    })

    const orderItemDef = schema?.$defs!["orders.OrderItem"]
    expect(orderItemDef.properties.order).toEqual({
      $ref: "#/$defs/orders.Order",
      "x-reference-type": "single",
      "x-arktype": "Order"
    })
  })

  test("detects computed arrays across domains", () => {
    // When: Converting with computed array detection
    const schema = arkTypeToEnhancedJsonSchema({
      auth: AuthDomain,
      inventory: InventoryDomain,
      orders: OrdersDomain
    }, {
      detectComputedArrays: true
    })

    // Then: Computed arrays are marked
    const categoryDef = schema?.$defs!["inventory.Category"]
    expect(categoryDef.properties.products["x-computed"]).toBe(true)
    expect(categoryDef.properties.products["x-inverse"]).toBe("category")

    // And: Required arrays don't include computed properties
    expect(categoryDef.required).not.toContain("products")
  })

  test("maintains single domain compatibility", () => {
    // When: Converting single domain (existing API)
    const schema = arkTypeToEnhancedJsonSchema(AuthDomain)

    // Then: Works as before (no namespacing)
    expect(schema.$defs).toBeDefined()
    expect(schema?.$defs!["User"]).toBeDefined()
    expect(schema?.$defs!["Role"]).toBeDefined()
    expect(schema?.$defs!["auth.User"]).toBeUndefined()
  })

  test("handles complex domain with multiple imports", () => {
    // Given: Domain that imports multiple other domains
    const ReportsDomain = scope({
      auth: AuthDomain.export(),
      inventory: InventoryDomain.export(),
      orders: OrdersDomain.export(),

      Report: {
        id: "string.uuid",
        title: "string",
        user: "auth.User",
        order: "orders.Order",
        products: "inventory.Product[]"
      }
    })

    // When: Converting
    const schema = arkTypeToEnhancedJsonSchema({
      auth: AuthDomain,
      inventory: InventoryDomain,
      orders: OrdersDomain,
      reports: ReportsDomain
    })

    // Then: All references resolve correctly
    const reportDef = schema?.$defs!["reports.Report"]
    expect(reportDef.properties.user.$ref).toBe("#/$defs/auth.User")
    expect(reportDef.properties.order.$ref).toBe("#/$defs/orders.Order")
    expect(reportDef.properties.products.items.$ref).toBe("#/$defs/inventory.Product")
  })

  test("handles namespace collisions gracefully", () => {
    // Given: Two domains with same entity names
    const Domain1 = scope({
      User: {
        id: "string.uuid",
        name: "string"
      }
    })

    const Domain2 = scope({
      User: {
        id: "string.uuid",
        email: "string.email"
      }
    })

    // When: Converting both
    const schema = arkTypeToEnhancedJsonSchema({
      domain1: Domain1,
      domain2: Domain2
    })

    // Then: Both are preserved with namespaces
    expect(schema?.$defs!["domain1.User"]).toBeDefined()
    expect(schema?.$defs!["domain2.User"]).toBeDefined()

    // And: They have different structures
    expect(schema?.$defs!["domain1.User"].properties.name).toBeDefined()
    expect(schema?.$defs!["domain1.User"].properties.email).toBeUndefined()

    expect(schema?.$defs!["domain2.User"].properties.email).toBeDefined()
    expect(schema?.$defs!["domain2.User"].properties.name).toBeUndefined()
  })

  test("preserves arkType constraints in namespaced definitions", () => {
    // Given: Domain with constraints
    const ConstrainedDomain = scope({
      User: {
        id: "string.uuid",
        name: "string >= 2",
        age: "number >= 18 & number <= 100"
      }
    })

    // When: Converting
    const schema = arkTypeToEnhancedJsonSchema({
      users: ConstrainedDomain
    })

    // Then: Constraints are preserved
    const userDef = schema?.$defs!["users.User"]
    expect(userDef.properties.name.minLength).toBe(2)
    expect(userDef.properties.age.minimum).toBe(18)
    expect(userDef.properties.age.maximum).toBe(100)

    // And: x-arktype metadata is preserved
    expect(userDef.properties.name["x-arktype"]).toBe("string >= 2")
    expect(userDef.properties.age["x-arktype"]).toBe("number >= 18 & number <= 100")
  })

})