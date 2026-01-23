/**
 * Project Service - Prisma-based project operations
 * Handles projects, folders, and starred projects
 */

import { prisma, type Prisma, ProjectTier, ProjectStatus, AccessLevel } from '../lib/prisma';

/**
 * Get all projects in a workspace
 */
export async function getProjects(workspaceId: string) {
  return prisma.project.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: 'desc' },
  });
}

/**
 * Get a project by ID
 */
export async function getProject(projectId: string) {
  return prisma.project.findUnique({
    where: { id: projectId },
    include: {
      workspace: true,
      folder: true,
    },
  });
}

/**
 * Get a project by published subdomain
 */
export async function getProjectBySubdomain(subdomain: string) {
  return prisma.project.findUnique({
    where: { publishedSubdomain: subdomain },
  });
}

/**
 * Check if a subdomain is available
 */
export async function isSubdomainAvailable(subdomain: string): Promise<boolean> {
  const existing = await prisma.project.findUnique({
    where: { publishedSubdomain: subdomain },
    select: { id: true },
  });
  return !existing;
}

/**
 * Create a new project
 */
export async function createProject(data: {
  name: string;
  workspaceId: string;
  description?: string;
  tier?: ProjectTier;
  createdBy?: string;
  folderId?: string;
}) {
  return prisma.project.create({
    data: {
      name: data.name,
      workspaceId: data.workspaceId,
      description: data.description,
      tier: data.tier ?? 'starter',
      status: 'draft',
      createdBy: data.createdBy,
      folderId: data.folderId,
    },
  });
}

/**
 * Update a project
 */
export async function updateProject(
  projectId: string,
  data: Prisma.ProjectUpdateInput
) {
  return prisma.project.update({
    where: { id: projectId },
    data,
  });
}

/**
 * Publish a project (set subdomain and publish timestamp)
 */
export async function publishProject(
  projectId: string,
  subdomain: string,
  options?: {
    accessLevel?: AccessLevel;
    siteTitle?: string;
    siteDescription?: string;
  }
) {
  return prisma.project.update({
    where: { id: projectId },
    data: {
      publishedSubdomain: subdomain,
      publishedAt: new Date(),
      status: 'active',
      accessLevel: options?.accessLevel,
      siteTitle: options?.siteTitle,
      siteDescription: options?.siteDescription,
    },
  });
}

/**
 * Unpublish a project
 */
export async function unpublishProject(projectId: string) {
  return prisma.project.update({
    where: { id: projectId },
    data: {
      publishedSubdomain: null,
      publishedAt: null,
      status: 'draft',
    },
  });
}

/**
 * Delete a project
 */
export async function deleteProject(projectId: string) {
  return prisma.project.delete({
    where: { id: projectId },
  });
}

/**
 * Get starred projects for a user
 */
export async function getStarredProjects(userId: string, workspaceId?: string) {
  const where: Prisma.StarredProjectWhereInput = { userId };
  if (workspaceId) {
    where.workspaceId = workspaceId;
  }

  return prisma.starredProject.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Star a project
 */
export async function starProject(
  userId: string,
  projectId: string,
  workspaceId: string
) {
  return prisma.starredProject.upsert({
    where: {
      userId_projectId: { userId, projectId },
    },
    create: {
      userId,
      projectId,
      workspaceId,
    },
    update: {},
  });
}

/**
 * Unstar a project
 */
export async function unstarProject(userId: string, projectId: string) {
  return prisma.starredProject.delete({
    where: {
      userId_projectId: { userId, projectId },
    },
  });
}

// ============================================================================
// Folders
// ============================================================================

/**
 * Get all folders in a workspace
 */
export async function getFolders(workspaceId: string) {
  return prisma.folder.findMany({
    where: { workspaceId },
    orderBy: { name: 'asc' },
  });
}

/**
 * Create a folder
 */
export async function createFolder(data: {
  name: string;
  workspaceId: string;
  parentId?: string;
  createdBy?: string;
}) {
  return prisma.folder.create({
    data: {
      name: data.name,
      workspaceId: data.workspaceId,
      parentId: data.parentId,
      createdBy: data.createdBy,
    },
  });
}

/**
 * Update a folder
 */
export async function updateFolder(
  folderId: string,
  data: Prisma.FolderUpdateInput
) {
  return prisma.folder.update({
    where: { id: folderId },
    data,
  });
}

/**
 * Delete a folder
 */
export async function deleteFolder(folderId: string) {
  return prisma.folder.delete({
    where: { id: folderId },
  });
}
