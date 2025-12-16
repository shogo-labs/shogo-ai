/**
 * Teams Multi-Tenancy Domain Store
 *
 * Multi-tenant data model with User, Tenant, TenantMember, BillingAccount,
 * and Workspace entities. Uses the domain() composition API with:
 * - Snake_case field names (user_id, tenant_id, etc.)
 * - isBillingAdmin computed view on TenantMember
 * - findByTenant collection queries
 *
 * Schema: .schemas/teams-multi-tenancy/schema.json
 */

import { scope } from "arktype"
import { domain } from "../domain"

// ============================================================
// 1. DOMAIN SCHEMA (ArkType)
// ============================================================

export const TeamsMultiTenancyDomain = scope({
  User: {
    id: "string.uuid",
    email: "string",
    name: "string",
  },

  Tenant: {
    id: "string.uuid",
    name: "string",
    "sso_settings?": "string", // SSO configuration JSON or empty
  },

  TenantMember: {
    id: "string.uuid",
    user_id: "User", // Reference to User
    tenant_id: "Tenant", // Reference to Tenant
    role: "'admin' | 'billing_admin' | 'editor' | 'member'",
  },

  BillingAccount: {
    id: "string.uuid",
    tenant_id: "Tenant", // Reference to Tenant (owner)
    "stripe_customer_id?": "string", // Stripe customer ID reference
    "tax_id?": "string", // VAT/GST identifier
    credits_balance: "number", // Prepaid AI credits (non-negative)
  },

  Workspace: {
    id: "string.uuid",
    name: "string",
    tenant_id: "Tenant", // Who controls this workspace
    billing_account_id: "BillingAccount", // Who pays for this workspace
  },
})

// ============================================================
// 2. DOMAIN DEFINITION WITH ENHANCEMENTS
// ============================================================

/**
 * Teams multi-tenancy domain with all enhancements.
 * - TenantMember.isBillingAdmin computed view
 * - tenantMemberCollection.findByTenant query
 * - workspaceCollection.findByTenant query
 */
export const teamsMultiTenancyDomain = domain({
  name: "teams-multi-tenancy",
  from: TeamsMultiTenancyDomain,
  enhancements: {
    // --------------------------------------------------------
    // models: Add computed views to individual entities
    // --------------------------------------------------------
    models: (models) => ({
      ...models,

      // TenantMember.isBillingAdmin - check if user has billing_admin role
      TenantMember: models.TenantMember.views((self: any) => ({
        /**
         * Check if this member has billing_admin role.
         * Billing admins can manage billing accounts (payment methods, invoices, credits).
         */
        get isBillingAdmin(): boolean {
          return self.role === "billing_admin"
        },
      })),
    }),

    // --------------------------------------------------------
    // collections: Add query methods (CollectionPersistable auto-composed)
    // --------------------------------------------------------
    collections: (collections) => ({
      ...collections,

      TenantMemberCollection: collections.TenantMemberCollection.views((self: any) => ({
        /**
         * Find all members belonging to a specific tenant.
         * @param tenantId - The tenant ID to filter by
         * @returns Array of TenantMember instances
         */
        findByTenant(tenantId: string): any[] {
          return self.all().filter((m: any) => m.tenant_id?.id === tenantId)
        },
      })),

      WorkspaceCollection: collections.WorkspaceCollection.views((self: any) => ({
        /**
         * Find all workspaces controlled by a specific tenant.
         * @param tenantId - The tenant ID to filter by
         * @returns Array of Workspace instances
         */
        findByTenant(tenantId: string): any[] {
          return self.all().filter((w: any) => w.tenant_id?.id === tenantId)
        },
      })),
    }),
  },
})
