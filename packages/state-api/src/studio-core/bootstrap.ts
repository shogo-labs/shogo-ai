/**
 * Studio Core Bootstrap Script
 *
 * Creates initial data for internal use:
 * - Shogo organization
 * - shogo-platform project
 * - Owner member for current user
 * - Links existing FeatureSessions to project
 *
 * Can be run idempotently - checks for existing data before creating.
 */

import { v4 as uuidv4 } from "uuid"

/**
 * Bootstrap data interface
 */
export interface BootstrapData {
  organization: {
    id: string
    name: string
    slug: string
    description: string
  }
  project: {
    id: string
    name: string
    organization: string
    tier: string
    status: string
    schemas: string[]
  }
  member?: {
    id: string
    userId: string
    role: string
    organization: string
  }
}

/**
 * Bootstrap result
 */
export interface BootstrapResult {
  alreadyBootstrapped: boolean
  organization: any
  project: any
  member?: any
  featureSessionsUpdated?: number
}

/**
 * Bootstrap the studio-core domain with initial data.
 *
 * Creates:
 * - Organization: { name: 'Shogo', slug: 'shogo', description: 'Shogo AI Platform' }
 * - Project: { name: 'shogo-platform', organization: shogo.id, tier: 'internal', status: 'active', schemas: ['platform-features', 'studio-core'] }
 * - Member: { userId: <provided or 'bootstrap-user'>, role: 'owner', organization: shogo.id }
 *
 * @param store - The studio-core store instance
 * @param userId - Optional user ID to assign as owner (defaults to 'bootstrap-user')
 * @returns BootstrapResult with created entities
 */
export function bootstrapStudioCore(
  store: any,
  userId: string = "bootstrap-user"
): BootstrapResult {
  // Check if already bootstrapped
  const existingOrg = store.organizationCollection
    .all()
    .find((org: any) => org.slug === "shogo")

  if (existingOrg) {
    console.log("Bootstrap already complete - organization 'shogo' exists")

    // Find the project
    const existingProject = store.projectCollection
      .all()
      .find((p: any) => p.name === "shogo-platform" && p.organization?.id === existingOrg.id)

    // Find the member
    const existingMember = store.memberCollection
      .all()
      .find((m: any) => m.organization?.id === existingOrg.id && m.role === "owner")

    return {
      alreadyBootstrapped: true,
      organization: existingOrg,
      project: existingProject,
      member: existingMember,
    }
  }

  console.log("Starting studio-core bootstrap...")

  // Create Shogo organization
  const orgId = uuidv4()
  const organization = store.organizationCollection.add({
    id: orgId,
    name: "Shogo",
    slug: "shogo",
    description: "Shogo AI Platform",
    createdAt: Date.now(),
  })
  console.log(`Created organization: ${organization.name} (${organization.id})`)

  // Create shogo-platform project
  const projectId = uuidv4()
  const project = store.projectCollection.add({
    id: projectId,
    name: "shogo-platform",
    description: "Internal Shogo AI platform development",
    organization: orgId,
    tier: "internal",
    status: "active",
    schemas: ["platform-features", "studio-core"],
    createdAt: Date.now(),
  })
  console.log(`Created project: ${project.name} (${project.id})`)

  // Create owner member
  const memberId = uuidv4()
  const member = store.createMember({
    id: memberId,
    userId,
    role: "owner",
    organization: orgId,
    createdAt: Date.now(),
  })
  console.log(`Created member: ${member.userId} as ${member.role} (${member.id})`)

  console.log("Studio-core bootstrap complete!")

  return {
    alreadyBootstrapped: false,
    organization,
    project,
    member,
  }
}

/**
 * Get bootstrap data for external use (e.g., updating FeatureSessions via MCP).
 *
 * @param store - The studio-core store instance
 * @returns BootstrapData with IDs and schema, or null if not bootstrapped
 */
export function getBootstrapData(store: any): BootstrapData | null {
  const organization = store.organizationCollection
    .all()
    .find((org: any) => org.slug === "shogo")

  if (!organization) {
    return null
  }

  const project = store.projectCollection
    .all()
    .find((p: any) => p.name === "shogo-platform" && p.organization?.id === organization.id)

  if (!project) {
    return null
  }

  const member = store.memberCollection
    .all()
    .find((m: any) => m.organization?.id === organization.id && m.role === "owner")

  return {
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      description: organization.description,
    },
    project: {
      id: project.id,
      name: project.name,
      organization: project.organization.id,
      tier: project.tier,
      status: project.status,
      schemas: project.schemas || [],
    },
    ...(member && {
      member: {
        id: member.id,
        userId: member.userId,
        role: member.role,
        organization: member.organization.id,
      },
    }),
  }
}
