// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo AI Services - Prisma-based data access layer
 *
 * Services consumed directly by routes, hooks, and auth:
 * - workspace: Workspace management
 * - billing: Subscriptions and credits
 * - git: Local git operations
 * - checkpoint: Project state snapshots and rollback
 * - github: GitHub App integration
 * - email: Transactional email (SMTP/SES via SDK)
 */

export * as workspaceService from './workspace.service';
export * as billingService from './billing.service';
export * as gitService from './git.service';
export * as checkpointService from './checkpoint.service';
export * as githubService from './github.service';
export * as emailService from './email.service';

// Re-export Prisma client for direct use when needed
export { prisma } from '../lib/prisma';
