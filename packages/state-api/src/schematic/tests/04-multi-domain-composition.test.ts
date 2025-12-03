import { describe, test, expect } from "bun:test";
import { scope } from "arktype";

// This import will fail initially (TDD)
import { createStoreFromScope } from "../index";

describe("Multi-Domain Composition", () => {
  // Test domains for composition
  const AuthDomain = scope({
    User: {
      id: "string.uuid",
      email: "string.email",
      roles: "Role[]",
    },
    Role: {
      id: "string.uuid",
      name: "string",
      permissions: "string[]",
    },
  });

  const InventoryDomain = scope({
    Product: {
      id: "string.uuid",
      name: "string",
      sku: "string",
      price: "number",
      category: "Category", // Single reference for inverse relationship
    },
    Category: {
      id: "string.uuid",
      name: "string",
      products: "Product[]", // This should be computed from Product.category
    },
  });

  const OrdersDomain = scope({
    // Use export() to create submodules with dot notation
    auth: AuthDomain.export(),
    inventory: InventoryDomain.export(),

    Order: {
      id: "string.uuid",
      customer: "auth.User", // Cross-domain reference
      items: "OrderItem[]",
      total: "number",
      status: "'pending' | 'shipped' | 'delivered'",
    },
    OrderItem: {
      id: "string.uuid",
      order: "Order", // Single reference for inverse
      product: "inventory.Product", // Cross-domain reference
      quantity: "number",
      price: "number",
    },
  });

  // Enhanced domain with computed cross-domain views
  const EnhancedAuthDomain = scope({
    ...AuthDomain.export(),
    orders: OrdersDomain.export(),

    // Redefine User with computed orders property
    User: {
      id: "string.uuid",
      email: "string.email",
      roles: "Role[]",
      orders: "orders.Order[]", // Should be computed from Order.customer
    },
  });

  test("detects multi-domain input and returns correct structure", () => {
    // When: Creating a multi-domain store
    const result = createStoreFromScope({
      auth: AuthDomain,
      inventory: InventoryDomain,
      orders: OrdersDomain,
    });

    // Then: Result has multi-domain structure
    expect(result.domains).toBeDefined();
    expect(result.createStore).toBeDefined();
    expect(typeof result.createStore).toBe("function");

    // And: Each domain has expected structure
    expect(result.domains?.auth).toBeDefined();
    expect(result.domains?.auth?.models).toBeDefined();
    expect(result.domains?.auth?.models?.User).toBeDefined();
    expect(result.domains?.auth?.models?.Role).toBeDefined();
    expect(result.domains?.auth?.collectionModels).toBeDefined();
    expect(result.domains?.auth?.createStore).toBeDefined();

    expect(result.domains?.inventory).toBeDefined();
    expect(result.domains?.inventory?.models?.Product).toBeDefined();
    expect(result.domains?.inventory?.models?.Category).toBeDefined();

    expect(result.domains?.orders).toBeDefined();
    expect(result.domains?.orders?.models?.Order).toBeDefined();
    expect(result.domains?.orders?.models?.OrderItem).toBeDefined();
  });

  test("creates composed store with namespaced collections", () => {
    // Given: Multi-domain setup
    const result = createStoreFromScope({
      auth: AuthDomain,
      inventory: InventoryDomain,
      orders: OrdersDomain,
    });

    // When: Creating the composed store
    const store = result.createStore();

    // Then: Collections are namespaced under domain names
    expect(store.auth).toBeDefined();
    expect(store.auth.userCollection).toBeDefined();
    expect(store.auth.roleCollection).toBeDefined();

    expect(store.inventory).toBeDefined();
    expect(store.inventory.productCollection).toBeDefined();
    expect(store.inventory.categoryCollection).toBeDefined();

    expect(store.orders).toBeDefined();
    expect(store.orders.orderCollection).toBeDefined();
    expect(store.orders.orderItemCollection).toBeDefined();

    // And: Collections have expected methods
    expect(typeof store.auth.userCollection.add).toBe("function");
    expect(typeof store.auth.userCollection.get).toBe("function");
    expect(typeof store.auth.userCollection.has).toBe("function");
    expect(typeof store.auth.userCollection.all).toBe("function");
  });

  test("handles cross-domain references correctly", () => {
    // Given: Multi-domain store
    const result = createStoreFromScope({
      auth: AuthDomain,
      inventory: InventoryDomain,
      orders: OrdersDomain,
    });
    const store = result.createStore();

    // When: Creating entities with cross-domain references
    const user = store.auth.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440001",
      email: "alice@example.com",
      roles: [],
    });

    const product = store.inventory.productCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Widget",
      sku: "WDG-001",
      price: 29.99,
    });

    const order = store.orders.orderCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440003",
      customer: user.id, // Cross-domain reference
      items: [],
      total: 0,
      status: "pending",
    });

    const orderItem = store.orders.orderItemCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440004",
      product: product.id, // Cross-domain reference
      quantity: 2,
      price: 29.99,
    });

    // Then: Cross-domain references resolve correctly
    expect(order.customer).toBe(user);
    expect(order.customer.email).toBe("alice@example.com");

    expect(orderItem.product).toBe(product);
    expect(orderItem.product.name).toBe("Widget");
  });

  test("supports computed views within domains", () => {
    // Given: Multi-domain store with entities that have inverse relationships
    const result = createStoreFromScope({
      auth: AuthDomain,
      inventory: InventoryDomain,
      orders: OrdersDomain,
    });
    const store = result.createStore();

    // When: Creating entities with relationships
    const electronics = store.inventory.categoryCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440005",
      name: "Electronics",
    });

    const laptop = store.inventory.productCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440006",
      name: "Laptop",
      sku: "LAP-001",
      price: 999.99,
      category: electronics.id,
    });

    const mouse = store.inventory.productCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440007",
      name: "Mouse",
      sku: "MOU-001",
      price: 19.99,
      category: electronics.id,
    });

    // Then: Computed view works (Category.products is computed from Product.category)
    expect(electronics.products).toHaveLength(2);
    expect(electronics.products).toContain(laptop);
    expect(electronics.products).toContain(mouse);

    // And: Adding another product updates the computed view
    const keyboard = store.inventory.productCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440008",
      name: "Keyboard",
      sku: "KEY-001",
      price: 79.99,
      category: electronics.id,
    });

    expect(electronics.products).toHaveLength(3);
    expect(electronics.products).toContain(keyboard);
  });

  test("supports computed views across domains", () => {
    // Given: Multi-domain store with enhanced auth domain that has cross-domain computed views
    const result = createStoreFromScope({
      auth: EnhancedAuthDomain,
      inventory: InventoryDomain,
      orders: OrdersDomain,
    });
    const store = result.createStore();

    // When: Creating entities across domains
    const user = store.auth.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440009",
      email: "bob@example.com",
      roles: [],
    });

    const order1 = store.orders.orderCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440010",
      customer: user.id,
      items: [],
      total: 100,
      status: "pending",
    });

    const order2 = store.orders.orderCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440011",
      customer: user.id,
      items: [],
      total: 200,
      status: "shipped",
    });

    // Different user's order
    const otherUser = store.auth.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440012",
      email: "other@example.com",
      roles: [],
    });

    const otherOrder = store.orders.orderCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440013",
      customer: otherUser.id,
      items: [],
      total: 300,
      status: "pending",
    });

    // Then: User.orders computed view shows only their orders
    expect(user.orders).toHaveLength(2);
    expect(user.orders).toContain(order1);
    expect(user.orders).toContain(order2);
    expect(user.orders).not.toContain(otherOrder);

    // And: Other user has only their order
    expect(otherUser.orders).toHaveLength(1);
    expect(otherUser.orders).toContain(otherOrder);
  });

  test("validates references within and across domains", () => {
    // Given: Multi-domain store
    const result = createStoreFromScope({
      auth: AuthDomain,
      inventory: InventoryDomain,
      orders: OrdersDomain,
    });
    const store = result.createStore();

    // When: Creating entities with valid data
    const user = store.auth.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440014",
      email: "charlie@example.com",
      roles: [],
    });

    // Then: Valid cross-domain references work
    const order = store.orders.orderCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440015",
      customer: user.id,
      items: [],
      total: 0,
      status: "pending",
    });

    expect(order.customer).toBe(user);

    // And: Invalid data is rejected (arkType validation)
    expect(() => {
      store.orders.orderCollection.add({
        id: "not-a-uuid", // Invalid UUID
        customer: user.id,
        items: [],
        total: 0,
        status: "invalid-status", // Invalid enum value
      });
    }).toThrow();
  });

  test("handles missing cross-domain references gracefully", () => {
    // Given: Multi-domain store
    const result = createStoreFromScope({
      auth: AuthDomain,
      inventory: InventoryDomain,
      orders: OrdersDomain,
    });
    const store = result.createStore();

    // When: Creating entity with non-existent cross-domain reference
    const order = store.orders.orderCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440016",
      customer: "550e8400-e29b-41d4-a716-446655440999", // Non-existent user
      items: [],
      total: 0,
      status: "pending",
    });

    // Then: Reference resolves to undefined (lazy validation)
    expect(order.customer).toBeUndefined();
  });

  test("allows individual domain store creation", () => {
    // Given: Multi-domain result
    const result = createStoreFromScope({
      auth: AuthDomain,
      inventory: InventoryDomain,
      orders: OrdersDomain,
    });

    // When: Creating individual domain stores
    const authStore = result.domains?.auth?.createStore();
    const inventoryStore = result.domains?.inventory?.createStore();

    // Then: Individual stores work independently
    expect(authStore.userCollection).toBeDefined();
    expect(authStore.roleCollection).toBeDefined();
    expect(inventoryStore.productCollection).toBeDefined();
    expect(inventoryStore.categoryCollection).toBeDefined();

    // And: Can create entities in individual stores
    const user = authStore.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440017",
      email: "diana@example.com",
      roles: [],
    });

    expect(user.email).toBe("diana@example.com");
  });

  test("maintains backward compatibility with single domain", () => {
    // Given: Single domain (existing API)
    const singleResult = createStoreFromScope(AuthDomain);

    // Then: Returns single domain structure
    expect(singleResult.models).toBeDefined();
    expect(singleResult.collectionModels).toBeDefined();
    expect(singleResult.createStore).toBeDefined();
    expect(singleResult.domains).toBeUndefined();

    // And: Works as before
    const store = singleResult.createStore();
    const user = store.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440018",
      email: "eve@example.com",
      roles: [],
    });

    expect(user.email).toBe("eve@example.com");
  });

  test("shares single environment across all domains", () => {
    // Given: Multi-domain store with environment
    const result = createStoreFromScope({
      auth: AuthDomain,
      inventory: InventoryDomain,
      orders: OrdersDomain,
    });

    const environment = {
      logger: { log: (msg: string) => msg },
      apiClient: { get: () => Promise.resolve({}) },
      isServer: false,
    };

    const store = result.createStore(environment);

    // When: Creating entities in different domains
    const user = store.auth.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440019",
      email: "frank@example.com",
      roles: [],
    });

    const product = store.inventory.productCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440020",
      name: "Keyboard",
      sku: "KEY-001",
      price: 79.99,
    });

    // Then: All models have access to the same environment
    // (This would be tested through MST actions that use getEnv)
    expect(user).toBeDefined();
    expect(product).toBeDefined();
  });

  test("handles complex domain dependencies", () => {
    // Given: Domain that depends on multiple other domains
    const ComplexDomain = scope({
      auth: AuthDomain.export(),
      inventory: InventoryDomain.export(),
      orders: OrdersDomain.export(),

      Report: {
        id: "string.uuid",
        title: "string",
        user: "auth.User",
        order: "orders.Order",
        product: "inventory.Product",
      },
    });

    const result = createStoreFromScope({
      auth: AuthDomain,
      inventory: InventoryDomain,
      orders: OrdersDomain,
      reports: ComplexDomain,
    });

    const store = result.createStore();

    // When: Creating entities with multiple cross-domain references
    const user = store.auth.userCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440021",
      email: "grace@example.com",
      roles: [],
    });

    const product = store.inventory.productCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440022",
      name: "Monitor",
      sku: "MON-001",
      price: 299.99,
    });

    const order = store.orders.orderCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440023",
      customer: user.id,
      items: [],
      total: 299.99,
      status: "delivered",
    });

    const report = store.reports.reportCollection.add({
      id: "550e8400-e29b-41d4-a716-446655440024",
      title: "Order Report",
      user: user.id,
      order: order.id,
      product: product.id,
    });

    // Then: All cross-domain references resolve correctly
    expect(report.user).toBe(user);
    expect(report.order).toBe(order);
    expect(report.product).toBe(product);
  });
});
