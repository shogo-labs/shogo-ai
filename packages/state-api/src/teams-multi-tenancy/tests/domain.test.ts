/**
 * TDD Specs for Teams Multi-Tenancy Domain
 *
 * Tests for the multi-tenant data model with:
 * - User, Tenant, TenantMember, BillingAccount, Workspace entities
 * - Snake_case field names
 * - Reference resolution
 * - Computed views (isBillingAdmin)
 * - Collection queries (findByTenant)
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { isStateTreeNode } from "mobx-state-tree"

// These imports will initially fail (TDD RED phase)
import {
  TeamsMultiTenancyDomain,
  teamsMultiTenancyDomain,
} from "../domain"

// Test UUIDs for consistent testing
const TEST_UUIDS = {
  user1: "550e8400-e29b-41d4-a716-446655440001",
  user2: "550e8400-e29b-41d4-a716-446655440002",
  tenant1: "660e8400-e29b-41d4-a716-446655440001",
  tenant2: "660e8400-e29b-41d4-a716-446655440002",
  member1: "770e8400-e29b-41d4-a716-446655440001",
  member2: "770e8400-e29b-41d4-a716-446655440002",
  member3: "770e8400-e29b-41d4-a716-446655440003",
  member4: "770e8400-e29b-41d4-a716-446655440004",
  billing1: "880e8400-e29b-41d4-a716-446655440001",
  billing2: "880e8400-e29b-41d4-a716-446655440002",
  workspace1: "990e8400-e29b-41d4-a716-446655440001",
  workspace2: "990e8400-e29b-41d4-a716-446655440002",
  workspace3: "990e8400-e29b-41d4-a716-446655440003",
}

describe("Teams Multi-Tenancy Domain", () => {
  // ==========================================================
  // 1. DOMAIN SCHEMA NAME
  // ==========================================================

  describe("1. Domain schema name", () => {
    test("domain.name equals 'teams-multi-tenancy'", () => {
      // Given: teamsMultiTenancyDomain is imported
      // When: checking domain.name property
      // Then: domain.name equals 'teams-multi-tenancy'
      expect(teamsMultiTenancyDomain.name).toBe("teams-multi-tenancy")
    })

    test("TeamsMultiTenancyDomain ArkType scope exports entity types", () => {
      // Given: TeamsMultiTenancyDomain scope is exported
      // When: scope is introspected via .export()
      const exported = TeamsMultiTenancyDomain.export()

      // Then: all entities are defined
      expect(exported.User).toBeDefined()
      expect(exported.Tenant).toBeDefined()
      expect(exported.TenantMember).toBeDefined()
      expect(exported.BillingAccount).toBeDefined()
      expect(exported.Workspace).toBeDefined()
    })
  })

  // ==========================================================
  // 2. STORE CREATION
  // ==========================================================

  describe("2. Store creation", () => {
    test("createStore returns MST store with collections", () => {
      // When: createStore is called
      const store = teamsMultiTenancyDomain.createStore()

      // Then: store is valid MST node with all collections
      expect(isStateTreeNode(store)).toBe(true)
      expect(store.userCollection).toBeDefined()
      expect(store.tenantCollection).toBeDefined()
      expect(store.tenantMemberCollection).toBeDefined()
      expect(store.billingAccountCollection).toBeDefined()
      expect(store.workspaceCollection).toBeDefined()
    })

    test("collections have CollectionPersistable methods", () => {
      // Given: store is created
      const store = teamsMultiTenancyDomain.createStore()

      // Then: collections have loadAll/saveAll from CollectionPersistable
      expect(typeof store.userCollection.loadAll).toBe("function")
      expect(typeof store.userCollection.saveAll).toBe("function")
      expect(typeof store.tenantCollection.loadAll).toBe("function")
      expect(typeof store.workspaceCollection.loadAll).toBe("function")
    })
  })

  // ==========================================================
  // 3. USER ENTITY CRUD
  // ==========================================================

  describe("3. User entity CRUD", () => {
    test("create User with id, email, and name", () => {
      // Given: store is initialized
      const store = teamsMultiTenancyDomain.createStore()

      // When: creating a User
      const user = store.userCollection.add({
        id: TEST_UUIDS.user1,
        email: "alice@example.com",
        name: "Alice Smith",
      })

      // Then: User is created with correct values
      expect(user.id).toBe(TEST_UUIDS.user1)
      expect(user.email).toBe("alice@example.com")
      expect(user.name).toBe("Alice Smith")

      // And: User can be retrieved from collection
      expect(store.userCollection.get(TEST_UUIDS.user1)).toBe(user)
    })
  })

  // ==========================================================
  // 4. TENANT ENTITY CRUD
  // ==========================================================

  describe("4. Tenant entity CRUD", () => {
    test("create Tenant with id, name, and sso_settings", () => {
      // Given: store is initialized
      const store = teamsMultiTenancyDomain.createStore()

      // When: creating a Tenant with SSO config
      const tenant = store.tenantCollection.add({
        id: TEST_UUIDS.tenant1,
        name: "Acme Corp",
        sso_settings: '{"provider":"okta","domain":"acme.okta.com"}',
      })

      // Then: Tenant is created with correct values
      expect(tenant.id).toBe(TEST_UUIDS.tenant1)
      expect(tenant.name).toBe("Acme Corp")
      expect(tenant.sso_settings).toBe('{"provider":"okta","domain":"acme.okta.com"}')
    })

    test("create Tenant with empty sso_settings", () => {
      // Given: store is initialized
      const store = teamsMultiTenancyDomain.createStore()

      // When: creating a Tenant without SSO
      const tenant = store.tenantCollection.add({
        id: TEST_UUIDS.tenant1,
        name: "Small Startup",
      })

      // Then: Tenant is created (sso_settings is optional)
      expect(tenant.id).toBe(TEST_UUIDS.tenant1)
      expect(tenant.name).toBe("Small Startup")
    })
  })

  // ==========================================================
  // 5. TENANT MEMBER ENTITY (Junction Table)
  // ==========================================================

  describe("5. TenantMember entity (junction)", () => {
    test("create TenantMember with references and role", () => {
      // Given: store with User and Tenant
      const store = teamsMultiTenancyDomain.createStore()
      store.userCollection.add({
        id: TEST_UUIDS.user1,
        email: "alice@example.com",
        name: "Alice",
      })
      store.tenantCollection.add({
        id: TEST_UUIDS.tenant1,
        name: "Acme Corp",
      })

      // When: creating TenantMember
      const member = store.tenantMemberCollection.add({
        id: TEST_UUIDS.member1,
        user_id: TEST_UUIDS.user1,
        tenant_id: TEST_UUIDS.tenant1,
        role: "admin",
      })

      // Then: TenantMember is created with references
      expect(member.id).toBe(TEST_UUIDS.member1)
      expect(member.role).toBe("admin")
    })

    test("TenantMember.user_id resolves to User instance", () => {
      // Given: store with User and TenantMember
      const store = teamsMultiTenancyDomain.createStore()
      const user = store.userCollection.add({
        id: TEST_UUIDS.user1,
        email: "alice@example.com",
        name: "Alice",
      })
      store.tenantCollection.add({
        id: TEST_UUIDS.tenant1,
        name: "Acme Corp",
      })
      const member = store.tenantMemberCollection.add({
        id: TEST_UUIDS.member1,
        user_id: TEST_UUIDS.user1,
        tenant_id: TEST_UUIDS.tenant1,
        role: "member",
      })

      // Then: user_id reference resolves to User instance
      expect(member.user_id).toBe(user)
      expect(member.user_id.name).toBe("Alice")
    })

    test("TenantMember.tenant_id resolves to Tenant instance", () => {
      // Given: store with Tenant and TenantMember
      const store = teamsMultiTenancyDomain.createStore()
      store.userCollection.add({
        id: TEST_UUIDS.user1,
        email: "alice@example.com",
        name: "Alice",
      })
      const tenant = store.tenantCollection.add({
        id: TEST_UUIDS.tenant1,
        name: "Acme Corp",
      })
      const member = store.tenantMemberCollection.add({
        id: TEST_UUIDS.member1,
        user_id: TEST_UUIDS.user1,
        tenant_id: TEST_UUIDS.tenant1,
        role: "editor",
      })

      // Then: tenant_id reference resolves to Tenant instance
      expect(member.tenant_id).toBe(tenant)
      expect(member.tenant_id.name).toBe("Acme Corp")
    })
  })

  // ==========================================================
  // 6. ROLE ENUM VALIDATION
  // ==========================================================

  describe("6. Role enum validation", () => {
    test("role 'admin' is accepted", () => {
      const store = teamsMultiTenancyDomain.createStore()
      store.userCollection.add({ id: TEST_UUIDS.user1, email: "a@b.com", name: "A" })
      store.tenantCollection.add({ id: TEST_UUIDS.tenant1, name: "T" })

      const member = store.tenantMemberCollection.add({
        id: TEST_UUIDS.member1,
        user_id: TEST_UUIDS.user1,
        tenant_id: TEST_UUIDS.tenant1,
        role: "admin",
      })

      expect(member.role).toBe("admin")
    })

    test("role 'billing_admin' is accepted", () => {
      const store = teamsMultiTenancyDomain.createStore()
      store.userCollection.add({ id: TEST_UUIDS.user1, email: "a@b.com", name: "A" })
      store.tenantCollection.add({ id: TEST_UUIDS.tenant1, name: "T" })

      const member = store.tenantMemberCollection.add({
        id: TEST_UUIDS.member1,
        user_id: TEST_UUIDS.user1,
        tenant_id: TEST_UUIDS.tenant1,
        role: "billing_admin",
      })

      expect(member.role).toBe("billing_admin")
    })

    test("role 'editor' is accepted", () => {
      const store = teamsMultiTenancyDomain.createStore()
      store.userCollection.add({ id: TEST_UUIDS.user1, email: "a@b.com", name: "A" })
      store.tenantCollection.add({ id: TEST_UUIDS.tenant1, name: "T" })

      const member = store.tenantMemberCollection.add({
        id: TEST_UUIDS.member1,
        user_id: TEST_UUIDS.user1,
        tenant_id: TEST_UUIDS.tenant1,
        role: "editor",
      })

      expect(member.role).toBe("editor")
    })

    test("role 'member' is accepted", () => {
      const store = teamsMultiTenancyDomain.createStore()
      store.userCollection.add({ id: TEST_UUIDS.user1, email: "a@b.com", name: "A" })
      store.tenantCollection.add({ id: TEST_UUIDS.tenant1, name: "T" })

      const member = store.tenantMemberCollection.add({
        id: TEST_UUIDS.member1,
        user_id: TEST_UUIDS.user1,
        tenant_id: TEST_UUIDS.tenant1,
        role: "member",
      })

      expect(member.role).toBe("member")
    })
  })

  // ==========================================================
  // 7. BILLING ACCOUNT ENTITY
  // ==========================================================

  describe("7. BillingAccount entity", () => {
    test("create BillingAccount with tenant_id and stripe references", () => {
      // Given: store with Tenant
      const store = teamsMultiTenancyDomain.createStore()
      store.tenantCollection.add({
        id: TEST_UUIDS.tenant1,
        name: "Acme Corp",
      })

      // When: creating BillingAccount
      const billing = store.billingAccountCollection.add({
        id: TEST_UUIDS.billing1,
        tenant_id: TEST_UUIDS.tenant1,
        stripe_customer_id: "cus_abc123",
        tax_id: "VAT123456",
        credits_balance: 1000,
      })

      // Then: BillingAccount is created with correct values
      expect(billing.id).toBe(TEST_UUIDS.billing1)
      expect(billing.stripe_customer_id).toBe("cus_abc123")
      expect(billing.tax_id).toBe("VAT123456")
      expect(billing.credits_balance).toBe(1000)
    })

    test("BillingAccount.tenant_id resolves to Tenant instance", () => {
      // Given: store with Tenant and BillingAccount
      const store = teamsMultiTenancyDomain.createStore()
      const tenant = store.tenantCollection.add({
        id: TEST_UUIDS.tenant1,
        name: "Acme Corp",
      })
      const billing = store.billingAccountCollection.add({
        id: TEST_UUIDS.billing1,
        tenant_id: TEST_UUIDS.tenant1,
        credits_balance: 500,
      })

      // Then: tenant_id resolves to Tenant
      expect(billing.tenant_id).toBe(tenant)
      expect(billing.tenant_id.name).toBe("Acme Corp")
    })

    test("credits_balance is a non-negative integer", () => {
      const store = teamsMultiTenancyDomain.createStore()
      store.tenantCollection.add({ id: TEST_UUIDS.tenant1, name: "T" })

      // Create with 0 credits (valid)
      const billing = store.billingAccountCollection.add({
        id: TEST_UUIDS.billing1,
        tenant_id: TEST_UUIDS.tenant1,
        credits_balance: 0,
      })

      expect(billing.credits_balance).toBe(0)
    })

    test("stripe_customer_id and tax_id can be empty strings", () => {
      const store = teamsMultiTenancyDomain.createStore()
      store.tenantCollection.add({ id: TEST_UUIDS.tenant1, name: "T" })

      const billing = store.billingAccountCollection.add({
        id: TEST_UUIDS.billing1,
        tenant_id: TEST_UUIDS.tenant1,
        stripe_customer_id: "",
        tax_id: "",
        credits_balance: 0,
      })

      expect(billing.stripe_customer_id).toBe("")
      expect(billing.tax_id).toBe("")
    })
  })

  // ==========================================================
  // 8. WORKSPACE ENTITY (Dual References)
  // ==========================================================

  describe("8. Workspace entity (dual references)", () => {
    test("create Workspace with name, tenant_id, billing_account_id", () => {
      // Given: store with Tenant and BillingAccount
      const store = teamsMultiTenancyDomain.createStore()
      store.tenantCollection.add({
        id: TEST_UUIDS.tenant1,
        name: "Acme Corp",
      })
      store.billingAccountCollection.add({
        id: TEST_UUIDS.billing1,
        tenant_id: TEST_UUIDS.tenant1,
        credits_balance: 1000,
      })

      // When: creating Workspace
      const workspace = store.workspaceCollection.add({
        id: TEST_UUIDS.workspace1,
        name: "Production",
        tenant_id: TEST_UUIDS.tenant1,
        billing_account_id: TEST_UUIDS.billing1,
      })

      // Then: Workspace is created with correct values
      expect(workspace.id).toBe(TEST_UUIDS.workspace1)
      expect(workspace.name).toBe("Production")
    })

    test("Workspace.tenant_id resolves to Tenant instance", () => {
      // Given: store with Tenant, BillingAccount, Workspace
      const store = teamsMultiTenancyDomain.createStore()
      const tenant = store.tenantCollection.add({
        id: TEST_UUIDS.tenant1,
        name: "Acme Corp",
      })
      store.billingAccountCollection.add({
        id: TEST_UUIDS.billing1,
        tenant_id: TEST_UUIDS.tenant1,
        credits_balance: 1000,
      })
      const workspace = store.workspaceCollection.add({
        id: TEST_UUIDS.workspace1,
        name: "Production",
        tenant_id: TEST_UUIDS.tenant1,
        billing_account_id: TEST_UUIDS.billing1,
      })

      // Then: tenant_id resolves to Tenant
      expect(workspace.tenant_id).toBe(tenant)
      expect(workspace.tenant_id.name).toBe("Acme Corp")
    })

    test("Workspace.billing_account_id resolves to BillingAccount instance", () => {
      // Given: store with Tenant, BillingAccount, Workspace
      const store = teamsMultiTenancyDomain.createStore()
      store.tenantCollection.add({
        id: TEST_UUIDS.tenant1,
        name: "Acme Corp",
      })
      const billing = store.billingAccountCollection.add({
        id: TEST_UUIDS.billing1,
        tenant_id: TEST_UUIDS.tenant1,
        credits_balance: 1000,
      })
      const workspace = store.workspaceCollection.add({
        id: TEST_UUIDS.workspace1,
        name: "Production",
        tenant_id: TEST_UUIDS.tenant1,
        billing_account_id: TEST_UUIDS.billing1,
      })

      // Then: billing_account_id resolves to BillingAccount
      expect(workspace.billing_account_id).toBe(billing)
      expect(workspace.billing_account_id.credits_balance).toBe(1000)
    })
  })

  // ==========================================================
  // 9. COMPUTED VIEW: isBillingAdmin
  // ==========================================================

  describe("9. TenantMember.isBillingAdmin computed view", () => {
    test("returns true for role 'billing_admin'", () => {
      const store = teamsMultiTenancyDomain.createStore()
      store.userCollection.add({ id: TEST_UUIDS.user1, email: "a@b.com", name: "A" })
      store.tenantCollection.add({ id: TEST_UUIDS.tenant1, name: "T" })

      const member = store.tenantMemberCollection.add({
        id: TEST_UUIDS.member1,
        user_id: TEST_UUIDS.user1,
        tenant_id: TEST_UUIDS.tenant1,
        role: "billing_admin",
      })

      expect(member.isBillingAdmin).toBe(true)
    })

    test("returns false for role 'admin'", () => {
      const store = teamsMultiTenancyDomain.createStore()
      store.userCollection.add({ id: TEST_UUIDS.user1, email: "a@b.com", name: "A" })
      store.tenantCollection.add({ id: TEST_UUIDS.tenant1, name: "T" })

      const member = store.tenantMemberCollection.add({
        id: TEST_UUIDS.member1,
        user_id: TEST_UUIDS.user1,
        tenant_id: TEST_UUIDS.tenant1,
        role: "admin",
      })

      expect(member.isBillingAdmin).toBe(false)
    })

    test("returns false for role 'editor'", () => {
      const store = teamsMultiTenancyDomain.createStore()
      store.userCollection.add({ id: TEST_UUIDS.user1, email: "a@b.com", name: "A" })
      store.tenantCollection.add({ id: TEST_UUIDS.tenant1, name: "T" })

      const member = store.tenantMemberCollection.add({
        id: TEST_UUIDS.member1,
        user_id: TEST_UUIDS.user1,
        tenant_id: TEST_UUIDS.tenant1,
        role: "editor",
      })

      expect(member.isBillingAdmin).toBe(false)
    })

    test("returns false for role 'member'", () => {
      const store = teamsMultiTenancyDomain.createStore()
      store.userCollection.add({ id: TEST_UUIDS.user1, email: "a@b.com", name: "A" })
      store.tenantCollection.add({ id: TEST_UUIDS.tenant1, name: "T" })

      const member = store.tenantMemberCollection.add({
        id: TEST_UUIDS.member1,
        user_id: TEST_UUIDS.user1,
        tenant_id: TEST_UUIDS.tenant1,
        role: "member",
      })

      expect(member.isBillingAdmin).toBe(false)
    })
  })

  // ==========================================================
  // 10. COLLECTION METHOD: findByTenant
  // ==========================================================

  describe("10. Collection findByTenant methods", () => {
    describe("tenantMemberCollection.findByTenant", () => {
      test("returns members for specific tenant", () => {
        // Given: store with 2 tenants and 3 members
        const store = teamsMultiTenancyDomain.createStore()
        store.userCollection.add({ id: TEST_UUIDS.user1, email: "a@b.com", name: "A" })
        store.userCollection.add({ id: TEST_UUIDS.user2, email: "b@b.com", name: "B" })
        store.tenantCollection.add({ id: TEST_UUIDS.tenant1, name: "Tenant A" })
        store.tenantCollection.add({ id: TEST_UUIDS.tenant2, name: "Tenant B" })

        // 2 members for Tenant A
        store.tenantMemberCollection.add({
          id: TEST_UUIDS.member1,
          user_id: TEST_UUIDS.user1,
          tenant_id: TEST_UUIDS.tenant1,
          role: "admin",
        })
        store.tenantMemberCollection.add({
          id: TEST_UUIDS.member2,
          user_id: TEST_UUIDS.user2,
          tenant_id: TEST_UUIDS.tenant1,
          role: "member",
        })
        // 1 member for Tenant B
        store.tenantMemberCollection.add({
          id: TEST_UUIDS.member3,
          user_id: TEST_UUIDS.user1,
          tenant_id: TEST_UUIDS.tenant2,
          role: "editor",
        })

        // When: calling findByTenant for Tenant A
        const membersA = store.tenantMemberCollection.findByTenant(TEST_UUIDS.tenant1)

        // Then: returns 2 members for Tenant A
        expect(membersA.length).toBe(2)
        expect(membersA.every((m: any) => m.tenant_id.id === TEST_UUIDS.tenant1)).toBe(true)
      })

      test("does not include members from other tenants", () => {
        const store = teamsMultiTenancyDomain.createStore()
        store.userCollection.add({ id: TEST_UUIDS.user1, email: "a@b.com", name: "A" })
        store.tenantCollection.add({ id: TEST_UUIDS.tenant1, name: "Tenant A" })
        store.tenantCollection.add({ id: TEST_UUIDS.tenant2, name: "Tenant B" })

        store.tenantMemberCollection.add({
          id: TEST_UUIDS.member1,
          user_id: TEST_UUIDS.user1,
          tenant_id: TEST_UUIDS.tenant1,
          role: "admin",
        })
        store.tenantMemberCollection.add({
          id: TEST_UUIDS.member2,
          user_id: TEST_UUIDS.user1,
          tenant_id: TEST_UUIDS.tenant2,
          role: "member",
        })

        // When: calling findByTenant for Tenant B
        const membersB = store.tenantMemberCollection.findByTenant(TEST_UUIDS.tenant2)

        // Then: only 1 member (not the one from Tenant A)
        expect(membersB.length).toBe(1)
        expect(membersB[0].id).toBe(TEST_UUIDS.member2)
      })
    })

    describe("workspaceCollection.findByTenant", () => {
      test("returns workspaces for specific tenant", () => {
        // Given: store with 2 tenants and 3 workspaces
        const store = teamsMultiTenancyDomain.createStore()
        store.tenantCollection.add({ id: TEST_UUIDS.tenant1, name: "Tenant A" })
        store.tenantCollection.add({ id: TEST_UUIDS.tenant2, name: "Tenant B" })
        store.billingAccountCollection.add({
          id: TEST_UUIDS.billing1,
          tenant_id: TEST_UUIDS.tenant1,
          credits_balance: 100,
        })
        store.billingAccountCollection.add({
          id: TEST_UUIDS.billing2,
          tenant_id: TEST_UUIDS.tenant2,
          credits_balance: 200,
        })

        // 2 workspaces for Tenant A
        store.workspaceCollection.add({
          id: TEST_UUIDS.workspace1,
          name: "Production",
          tenant_id: TEST_UUIDS.tenant1,
          billing_account_id: TEST_UUIDS.billing1,
        })
        store.workspaceCollection.add({
          id: TEST_UUIDS.workspace2,
          name: "Staging",
          tenant_id: TEST_UUIDS.tenant1,
          billing_account_id: TEST_UUIDS.billing1,
        })
        // 1 workspace for Tenant B
        store.workspaceCollection.add({
          id: TEST_UUIDS.workspace3,
          name: "Dev",
          tenant_id: TEST_UUIDS.tenant2,
          billing_account_id: TEST_UUIDS.billing2,
        })

        // When: calling findByTenant for Tenant A
        const workspacesA = store.workspaceCollection.findByTenant(TEST_UUIDS.tenant1)

        // Then: returns 2 workspaces for Tenant A
        expect(workspacesA.length).toBe(2)
        expect(workspacesA.every((w: any) => w.tenant_id.id === TEST_UUIDS.tenant1)).toBe(true)
      })

      test("does not include workspaces from other tenants", () => {
        const store = teamsMultiTenancyDomain.createStore()
        store.tenantCollection.add({ id: TEST_UUIDS.tenant1, name: "Tenant A" })
        store.tenantCollection.add({ id: TEST_UUIDS.tenant2, name: "Tenant B" })
        store.billingAccountCollection.add({
          id: TEST_UUIDS.billing1,
          tenant_id: TEST_UUIDS.tenant1,
          credits_balance: 100,
        })
        store.billingAccountCollection.add({
          id: TEST_UUIDS.billing2,
          tenant_id: TEST_UUIDS.tenant2,
          credits_balance: 200,
        })

        store.workspaceCollection.add({
          id: TEST_UUIDS.workspace1,
          name: "Production",
          tenant_id: TEST_UUIDS.tenant1,
          billing_account_id: TEST_UUIDS.billing1,
        })
        store.workspaceCollection.add({
          id: TEST_UUIDS.workspace2,
          name: "Dev",
          tenant_id: TEST_UUIDS.tenant2,
          billing_account_id: TEST_UUIDS.billing2,
        })

        // When: calling findByTenant for Tenant B
        const workspacesB = store.workspaceCollection.findByTenant(TEST_UUIDS.tenant2)

        // Then: only 1 workspace
        expect(workspacesB.length).toBe(1)
        expect(workspacesB[0].name).toBe("Dev")
      })
    })
  })
})
