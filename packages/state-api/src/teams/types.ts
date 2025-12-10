/**
 * Teams Service Types
 *
 * Pure type definitions for teams, organizations, and permissions.
 * NO runtime imports - interface contract only.
 */

// ============================================================================
// Enums
// ============================================================================

/**
 * Role levels for permission hierarchy.
 * Higher numeric value = more permissions.
 * Used for additive permission resolution.
 */
export enum Role {
  viewer = 1,
  member = 2,
  admin = 3,
  owner = 4,
}

/**
 * Invitation status values
 */
export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired'

// ============================================================================
// Entity Types
// ============================================================================

/**
 * Organization - top-level container entity
 */
export interface Organization {
  id: string
  name: string
  slug: string
  ownerId: string
  settings?: Record<string, unknown>
  createdAt: number
  updatedAt?: number
}

/**
 * Team - belongs to an organization, supports hierarchy via parentTeamId
 */
export interface Team {
  id: string
  name: string
  description?: string
  organizationId: string
  parentTeamId?: string | null
  createdAt: number
  updatedAt?: number
}

/**
 * App - belongs to a team, the primary artifact users build
 */
export interface App {
  id: string
  name: string
  slug: string
  teamId: string
  settings?: Record<string, unknown>
  createdAt: number
  updatedAt?: number
}

/**
 * Membership - polymorphic, exactly one of organizationId/teamId/appId must be set
 */
export interface Membership {
  id: string
  userId: string
  organizationId?: string
  teamId?: string
  appId?: string
  role: Role
  createdAt: number
}

/**
 * Invitation - pending membership invitation
 */
export interface Invitation {
  id: string
  email: string
  inviterId: string
  organizationId?: string
  teamId?: string
  role: Role
  expiresAt: number
  status: InvitationStatus
  createdAt: number
}

// ============================================================================
// Service Result Types
// ============================================================================

export interface ServiceResult<T> {
  success: boolean
  data?: T
  error?: { code: string; message: string }
}

// ============================================================================
// Input Types
// ============================================================================

export interface CreateOrganizationInput {
  name: string
  slug: string
  ownerId: string
  settings?: Record<string, unknown>
}

export interface UpdateOrganizationInput {
  name?: string
  slug?: string
  settings?: Record<string, unknown>
}

export interface CreateTeamInput {
  name: string
  description?: string
  organizationId: string
  parentTeamId?: string | null
}

export interface UpdateTeamInput {
  name?: string
  description?: string
  parentTeamId?: string | null
}

export interface CreateAppInput {
  name: string
  slug: string
  teamId: string
  settings?: Record<string, unknown>
}

export interface UpdateAppInput {
  name?: string
  slug?: string
  settings?: Record<string, unknown>
}

export interface AddMembershipInput {
  userId: string
  organizationId?: string
  teamId?: string
  appId?: string
  role: Role
}

export interface CreateInvitationInput {
  email: string
  inviterId: string
  organizationId?: string
  teamId?: string
  role: Role
  expiresAt?: number
}

// ============================================================================
// Service Interface
// ============================================================================

/**
 * Teams service interface - contract for teams providers
 *
 * Implementations:
 * - MockTeamsService: In-memory mock for testing
 * - SupabaseTeamsService: Real Supabase backend (future)
 */
export interface ITeamsService {
  // Organization CRUD
  createOrganization(input: CreateOrganizationInput): Promise<ServiceResult<Organization>>
  getOrganization(id: string): Promise<ServiceResult<Organization>>
  updateOrganization(id: string, input: UpdateOrganizationInput): Promise<ServiceResult<Organization>>
  deleteOrganization(id: string): Promise<ServiceResult<void>>

  // Team CRUD
  createTeam(input: CreateTeamInput): Promise<ServiceResult<Team>>
  getTeam(id: string): Promise<ServiceResult<Team>>
  updateTeam(id: string, input: UpdateTeamInput): Promise<ServiceResult<Team>>
  deleteTeam(id: string): Promise<ServiceResult<void>>
  getTeamsForOrg(organizationId: string): Promise<ServiceResult<Team[]>>

  // App CRUD
  createApp(input: CreateAppInput): Promise<ServiceResult<App>>
  getApp(id: string): Promise<ServiceResult<App>>
  updateApp(id: string, input: UpdateAppInput): Promise<ServiceResult<App>>
  deleteApp(id: string): Promise<ServiceResult<void>>
  getAppsForTeam(teamId: string): Promise<ServiceResult<App[]>>

  // Membership
  addMembership(input: AddMembershipInput): Promise<ServiceResult<Membership>>
  removeMembership(id: string): Promise<ServiceResult<void>>
  getMembershipsForUser(userId: string): Promise<ServiceResult<Membership[]>>
  getMembershipsForResource(
    resourceType: 'organization' | 'team' | 'app',
    resourceId: string
  ): Promise<ServiceResult<Membership[]>>

  // Invitations
  createInvitation(input: CreateInvitationInput): Promise<ServiceResult<Invitation>>
  acceptInvitation(id: string, userId: string): Promise<ServiceResult<Membership>>
  declineInvitation(id: string): Promise<ServiceResult<void>>
  getInvitationsForResource(
    resourceType: 'organization' | 'team',
    resourceId: string
  ): Promise<ServiceResult<Invitation[]>>
}
