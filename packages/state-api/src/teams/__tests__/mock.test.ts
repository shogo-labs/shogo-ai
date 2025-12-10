/**
 * MockTeamsService Tests
 *
 * Tests for the in-memory mock implementation of ITeamsService.
 * Generated from TestSpecifications for task-teams-mock.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { MockTeamsService } from '../mock'
import { Role, type ITeamsService } from '../types'

describe('MockTeamsService', () => {
  let service: MockTeamsService

  beforeEach(() => {
    service = new MockTeamsService()
  })

  describe('implements ITeamsService', () => {
    test('all methods exist and return appropriate types', async () => {
      // Type assertion - if this compiles, interface is satisfied
      const _typed: ITeamsService = service

      // All methods should be callable
      expect(typeof service.createOrganization).toBe('function')
      expect(typeof service.getOrganization).toBe('function')
      expect(typeof service.updateOrganization).toBe('function')
      expect(typeof service.deleteOrganization).toBe('function')
      expect(typeof service.createTeam).toBe('function')
      expect(typeof service.getTeam).toBe('function')
      expect(typeof service.updateTeam).toBe('function')
      expect(typeof service.deleteTeam).toBe('function')
      expect(typeof service.getTeamsForOrg).toBe('function')
      expect(typeof service.createApp).toBe('function')
      expect(typeof service.getApp).toBe('function')
      expect(typeof service.updateApp).toBe('function')
      expect(typeof service.deleteApp).toBe('function')
      expect(typeof service.getAppsForTeam).toBe('function')
      expect(typeof service.addMembership).toBe('function')
      expect(typeof service.removeMembership).toBe('function')
      expect(typeof service.getMembershipsForUser).toBe('function')
      expect(typeof service.getMembershipsForResource).toBe('function')
      expect(typeof service.createInvitation).toBe('function')
      expect(typeof service.acceptInvitation).toBe('function')
      expect(typeof service.declineInvitation).toBe('function')
      expect(typeof service.getInvitationsForResource).toBe('function')
    })
  })

  describe('in-memory storage', () => {
    test('stores and retrieves organizations', async () => {
      const result = await service.createOrganization({
        name: 'Acme Corp',
        slug: 'acme',
        ownerId: 'user-1',
      })

      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()

      const getResult = await service.getOrganization(result.data!.id)
      expect(getResult.success).toBe(true)
      expect(getResult.data!.name).toBe('Acme Corp')
    })
  })

  describe('configurable delays', () => {
    test('delays operations when latencyMs is set', async () => {
      const delayedService = new MockTeamsService({ latencyMs: 50 })
      const start = Date.now()

      await delayedService.createOrganization({
        name: 'Test',
        slug: 'test',
        ownerId: 'user-1',
      })

      const elapsed = Date.now() - start
      expect(elapsed).toBeGreaterThanOrEqual(45) // Allow some tolerance
    })
  })

  describe('createOrganization', () => {
    test('generates UUID and timestamps', async () => {
      const before = Date.now()
      const result = await service.createOrganization({
        name: 'Acme',
        slug: 'acme',
        ownerId: 'user-1',
      })
      const after = Date.now()

      expect(result.success).toBe(true)
      expect(result.data!.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      )
      expect(result.data!.createdAt).toBeGreaterThanOrEqual(before)
      expect(result.data!.createdAt).toBeLessThanOrEqual(after)
      expect(result.data!.name).toBe('Acme')
      expect(result.data!.slug).toBe('acme')
      expect(result.data!.ownerId).toBe('user-1')
    })
  })

  describe('createTeam', () => {
    test('validates organization exists', async () => {
      const result = await service.createTeam({
        name: 'Engineering',
        organizationId: 'non-existent',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error!.message).toContain('not found')
    })

    test('creates team when org exists', async () => {
      const orgResult = await service.createOrganization({
        name: 'Acme',
        slug: 'acme',
        ownerId: 'user-1',
      })

      const result = await service.createTeam({
        name: 'Engineering',
        organizationId: orgResult.data!.id,
      })

      expect(result.success).toBe(true)
      expect(result.data!.name).toBe('Engineering')
      expect(result.data!.organizationId).toBe(orgResult.data!.id)
    })
  })

  describe('createApp', () => {
    test('validates team exists', async () => {
      const result = await service.createApp({
        name: 'My App',
        slug: 'my-app',
        teamId: 'non-existent',
      })

      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error!.message).toContain('not found')
    })

    test('creates app when team exists', async () => {
      const orgResult = await service.createOrganization({
        name: 'Acme',
        slug: 'acme',
        ownerId: 'user-1',
      })
      const teamResult = await service.createTeam({
        name: 'Engineering',
        organizationId: orgResult.data!.id,
      })

      const result = await service.createApp({
        name: 'My App',
        slug: 'my-app',
        teamId: teamResult.data!.id,
      })

      expect(result.success).toBe(true)
      expect(result.data!.name).toBe('My App')
    })
  })

  describe('addMembership', () => {
    test('enforces org membership before team membership', async () => {
      const orgResult = await service.createOrganization({
        name: 'Acme',
        slug: 'acme',
        ownerId: 'owner-1',
      })
      const teamResult = await service.createTeam({
        name: 'Engineering',
        organizationId: orgResult.data!.id,
      })

      // Try to add team membership without org membership
      const result = await service.addMembership({
        userId: 'user-1',
        teamId: teamResult.data!.id,
        role: Role.member,
      })

      expect(result.success).toBe(false)
      expect(result.error!.message).toContain('organization membership')
    })

    test('allows team membership after org membership', async () => {
      const orgResult = await service.createOrganization({
        name: 'Acme',
        slug: 'acme',
        ownerId: 'owner-1',
      })
      const teamResult = await service.createTeam({
        name: 'Engineering',
        organizationId: orgResult.data!.id,
      })

      // First add org membership
      await service.addMembership({
        userId: 'user-1',
        organizationId: orgResult.data!.id,
        role: Role.member,
      })

      // Now add team membership
      const result = await service.addMembership({
        userId: 'user-1',
        teamId: teamResult.data!.id,
        role: Role.admin,
      })

      expect(result.success).toBe(true)
    })

    test('enforces exactly one reference set', async () => {
      const orgResult = await service.createOrganization({
        name: 'Acme',
        slug: 'acme',
        ownerId: 'owner-1',
      })

      const result = await service.addMembership({
        userId: 'user-1',
        organizationId: orgResult.data!.id,
        teamId: 'some-team', // Both org and team set!
        role: Role.member,
      })

      expect(result.success).toBe(false)
      expect(result.error!.message).toContain('exactly one')
    })
  })

  describe('createInvitation', () => {
    test('sets default 7-day expiration', async () => {
      const orgResult = await service.createOrganization({
        name: 'Acme',
        slug: 'acme',
        ownerId: 'owner-1',
      })

      const before = Date.now()
      const result = await service.createInvitation({
        email: 'new@example.com',
        inviterId: 'owner-1',
        organizationId: orgResult.data!.id,
        role: Role.member,
      })

      expect(result.success).toBe(true)
      expect(result.data!.status).toBe('pending')

      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
      const expectedExpiry = before + sevenDaysMs
      // Allow 1 second tolerance
      expect(result.data!.expiresAt).toBeGreaterThanOrEqual(expectedExpiry - 1000)
      expect(result.data!.expiresAt).toBeLessThanOrEqual(expectedExpiry + 1000)
    })
  })

  describe('acceptInvitation', () => {
    test('creates membership and updates status', async () => {
      const orgResult = await service.createOrganization({
        name: 'Acme',
        slug: 'acme',
        ownerId: 'owner-1',
      })

      const invResult = await service.createInvitation({
        email: 'new@example.com',
        inviterId: 'owner-1',
        organizationId: orgResult.data!.id,
        role: Role.member,
      })

      const acceptResult = await service.acceptInvitation(invResult.data!.id, 'user-new')

      expect(acceptResult.success).toBe(true)
      expect(acceptResult.data!.userId).toBe('user-new')
      expect(acceptResult.data!.role).toBe(Role.member)

      // Verify membership exists
      const memberships = await service.getMembershipsForUser('user-new')
      expect(memberships.data!.length).toBe(1)
      expect(memberships.data![0].organizationId).toBe(orgResult.data!.id)

      // Verify invitation status updated
      const invitations = await service.getInvitationsForResource(
        'organization',
        orgResult.data!.id
      )
      const accepted = invitations.data!.find((i) => i.id === invResult.data!.id)
      expect(accepted!.status).toBe('accepted')
    })
  })

  describe('getMembershipsForUser', () => {
    test('returns all memberships across org/team/app', async () => {
      const orgResult = await service.createOrganization({
        name: 'Acme',
        slug: 'acme',
        ownerId: 'owner-1',
      })
      const teamResult = await service.createTeam({
        name: 'Engineering',
        organizationId: orgResult.data!.id,
      })
      const appResult = await service.createApp({
        name: 'My App',
        slug: 'my-app',
        teamId: teamResult.data!.id,
      })

      // Add memberships at all levels
      await service.addMembership({
        userId: 'user-1',
        organizationId: orgResult.data!.id,
        role: Role.admin,
      })
      await service.addMembership({
        userId: 'user-1',
        teamId: teamResult.data!.id,
        role: Role.member,
      })
      await service.addMembership({
        userId: 'user-1',
        appId: appResult.data!.id,
        role: Role.viewer,
      })

      const result = await service.getMembershipsForUser('user-1')

      expect(result.success).toBe(true)
      expect(result.data!.length).toBe(3)

      const orgMembership = result.data!.find((m) => m.organizationId)
      const teamMembership = result.data!.find((m) => m.teamId)
      const appMembership = result.data!.find((m) => m.appId)

      expect(orgMembership).toBeDefined()
      expect(teamMembership).toBeDefined()
      expect(appMembership).toBeDefined()
    })
  })

  describe('clear()', () => {
    test('resets all storage', async () => {
      const orgResult = await service.createOrganization({
        name: 'Acme',
        slug: 'acme',
        ownerId: 'owner-1',
      })

      await service.addMembership({
        userId: 'user-1',
        organizationId: orgResult.data!.id,
        role: Role.member,
      })

      // Clear all data
      service.clear()

      // Verify all data gone
      const orgGet = await service.getOrganization(orgResult.data!.id)
      expect(orgGet.success).toBe(false)

      const memberships = await service.getMembershipsForUser('user-1')
      expect(memberships.data!.length).toBe(0)
    })
  })
})
