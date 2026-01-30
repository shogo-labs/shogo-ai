/**
 * Shogo AI Services - Prisma-based data access layer
 *
 * These services replace the MobX-State-Tree domain stores with direct Prisma operations.
 * Each service corresponds to a domain:
 * - workspace: Workspace management (replaces studioCoreDomain)
 * - billing: Subscriptions and credits (replaces billingDomain)
 * - project: Projects and folders
 * - member: Members, invitations, notifications
 * - chat: Chat sessions and messages
 * - git: Local git operations
 * - checkpoint: Project state snapshots and rollback
 * - github: GitHub App integration
 */

export * as workspaceService from './workspace.service';
export * as billingService from './billing.service';
export * as projectService from './project.service';
export * as memberService from './member.service';
export * as chatService from './chat.service';
export * as gitService from './git.service';
export * as checkpointService from './checkpoint.service';
export * as githubService from './github.service';

// Re-export Prisma client for direct use when needed
export { prisma } from '../lib/prisma';
