/**
 * Teams Domain Module
 *
 * Public API for teams and workspace management.
 * Exports domain scope and store factory.
 */

// Domain scope and store factory
export { TeamsDomain, teamsDomain, createTeamsStore } from "./domain"

// Types
export type { CreateTeamsStoreOptions } from "./domain"
