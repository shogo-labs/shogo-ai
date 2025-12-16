/**
 * Teams Multi-Tenancy Module
 *
 * Multi-tenant data model exports:
 * - TeamsMultiTenancyDomain: ArkType scope with User, Tenant, TenantMember, BillingAccount, Workspace
 * - teamsMultiTenancyDomain: Domain result with createStore() and enhancements
 */

export { TeamsMultiTenancyDomain, teamsMultiTenancyDomain } from "./domain"
