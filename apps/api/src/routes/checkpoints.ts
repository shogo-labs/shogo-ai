// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Checkpoint Routes - Project state snapshots and rollback
 *
 * Endpoints:
 * - POST   /projects/:projectId/checkpoints        - Create a checkpoint
 * - GET    /projects/:projectId/checkpoints        - List checkpoints
 * - GET    /projects/:projectId/checkpoints/:id    - Get checkpoint details
 * - POST   /projects/:projectId/checkpoints/:id/rollback - Rollback to checkpoint
 * - GET    /projects/:projectId/checkpoints/:id/diff     - Get diff from checkpoint
 * - GET    /projects/:projectId/git/status         - Get git status
 */

import { Hono } from 'hono';
import { join } from 'path';
import * as checkpointService from '../services/checkpoint.service';
import { prisma } from '../lib/prisma';

// =============================================================================
// Types
// =============================================================================

export interface CheckpointRoutesConfig {
  /** Directory containing project workspaces */
  workspacesDir: string;
}

// =============================================================================
// Routes
// =============================================================================

export function checkpointRoutes(config: CheckpointRoutesConfig) {
  const { workspacesDir } = config;
  const router = new Hono();

  /**
   * Get workspace path for a project.
   */
  function getWorkspacePath(projectId: string): string {
    return join(workspacesDir, projectId);
  }

  /**
   * Validate project exists.
   */
  async function validateProject(projectId: string) {
    return prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, workspaceId: true },
    });
  }

  /**
   * POST /projects/:projectId/checkpoints - Create a checkpoint
   */
  router.post('/projects/:projectId/checkpoints', async (c) => {
    const projectId = c.req.param('projectId');

    try {
      // Validate project exists
      const project = await validateProject(projectId);
      if (!project) {
        return c.json(
          { error: { code: 'project_not_found', message: 'Project not found' } },
          404
        );
      }

      const body = await c.req.json<{
        message: string;
        name?: string;
        description?: string;
        includeDatabase?: boolean;
      }>();

      if (!body.message) {
        return c.json(
          { error: { code: 'invalid_request', message: 'Message is required' } },
          400
        );
      }

      // Get user ID from context (set by auth middleware)
      const auth = c.get('auth');
      const userId = auth?.userId;

      const checkpoint = await checkpointService.createCheckpoint({
        projectId,
        workspacePath: getWorkspacePath(projectId),
        message: body.message,
        name: body.name,
        description: body.description,
        includeDatabase: body.includeDatabase,
        createdBy: userId,
      });

      return c.json({ ok: true, checkpoint }, 201);
    } catch (error: any) {
      console.error('[Checkpoints] Create error:', error);
      return c.json(
        { error: { code: 'checkpoint_failed', message: error.message || 'Failed to create checkpoint' } },
        500
      );
    }
  });

  /**
   * GET /projects/:projectId/checkpoints - List checkpoints
   */
  router.get('/projects/:projectId/checkpoints', async (c) => {
    const projectId = c.req.param('projectId');
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const before = c.req.query('before');

    try {
      // Validate project exists
      const project = await validateProject(projectId);
      if (!project) {
        return c.json(
          { error: { code: 'project_not_found', message: 'Project not found' } },
          404
        );
      }

      const checkpoints = await checkpointService.listCheckpoints(projectId, {
        limit: Math.min(limit, 100),
        before,
      });

      return c.json({
        ok: true,
        checkpoints,
        hasMore: checkpoints.length === limit,
      });
    } catch (error: any) {
      console.error('[Checkpoints] List error:', error);
      return c.json(
        { error: { code: 'list_failed', message: error.message || 'Failed to list checkpoints' } },
        500
      );
    }
  });

  /**
   * GET /projects/:projectId/checkpoints/:checkpointId - Get checkpoint details
   */
  router.get('/projects/:projectId/checkpoints/:checkpointId', async (c) => {
    const projectId = c.req.param('projectId');
    const checkpointId = c.req.param('checkpointId');

    try {
      const checkpoint = await checkpointService.getCheckpoint(checkpointId);
      if (!checkpoint) {
        return c.json(
          { error: { code: 'checkpoint_not_found', message: 'Checkpoint not found' } },
          404
        );
      }

      // Verify checkpoint belongs to this project (implicit from DB relation)
      const dbCheckpoint = await prisma.projectCheckpoint.findUnique({
        where: { id: checkpointId },
        select: { projectId: true },
      });

      if (dbCheckpoint?.projectId !== projectId) {
        return c.json(
          { error: { code: 'checkpoint_not_found', message: 'Checkpoint not found' } },
          404
        );
      }

      return c.json({ ok: true, checkpoint });
    } catch (error: any) {
      console.error('[Checkpoints] Get error:', error);
      return c.json(
        { error: { code: 'get_failed', message: error.message || 'Failed to get checkpoint' } },
        500
      );
    }
  });

  /**
   * POST /projects/:projectId/checkpoints/:checkpointId/rollback - Rollback to checkpoint
   */
  router.post('/projects/:projectId/checkpoints/:checkpointId/rollback', async (c) => {
    const projectId = c.req.param('projectId');
    const checkpointId = c.req.param('checkpointId');

    try {
      // Validate project exists
      const project = await validateProject(projectId);
      if (!project) {
        return c.json(
          { error: { code: 'project_not_found', message: 'Project not found' } },
          404
        );
      }

      const body = await c.req.json<{
        includeDatabase?: boolean;
      }>().catch(() => ({ includeDatabase: undefined }));

      const auth = c.get('auth');
      const userId = auth?.userId;

      const result = await checkpointService.rollback({
        projectId,
        workspacePath: getWorkspacePath(projectId),
        checkpointId,
        includeDatabase: body.includeDatabase,
        createdBy: userId,
      });

      if (!result.success) {
        return c.json(
          { error: { code: 'rollback_failed', message: result.error || 'Rollback failed' } },
          400
        );
      }

      return c.json({
        ok: true,
        rolledBackTo: result.previousCheckpoint,
        newCheckpoint: result.newCheckpoint,
      });
    } catch (error: any) {
      console.error('[Checkpoints] Rollback error:', error);
      return c.json(
        { error: { code: 'rollback_failed', message: error.message || 'Failed to rollback' } },
        500
      );
    }
  });

  /**
   * GET /projects/:projectId/checkpoints/:checkpointId/diff - Get diff from checkpoint to HEAD
   */
  router.get('/projects/:projectId/checkpoints/:checkpointId/diff', async (c) => {
    const projectId = c.req.param('projectId');
    const checkpointId = c.req.param('checkpointId');
    const toCheckpointId = c.req.query('to'); // Optional: compare to another checkpoint

    try {
      // Validate project exists
      const project = await validateProject(projectId);
      if (!project) {
        return c.json(
          { error: { code: 'project_not_found', message: 'Project not found' } },
          404
        );
      }

      const diff = await checkpointService.getDiff(
        getWorkspacePath(projectId),
        checkpointId,
        toCheckpointId
      );

      if (!diff) {
        return c.json(
          { error: { code: 'checkpoint_not_found', message: 'Checkpoint not found' } },
          404
        );
      }

      return c.json({ ok: true, diff });
    } catch (error: any) {
      console.error('[Checkpoints] Diff error:', error);
      return c.json(
        { error: { code: 'diff_failed', message: error.message || 'Failed to get diff' } },
        500
      );
    }
  });

  /**
   * GET /projects/:projectId/git/status - Get git status for project
   */
  router.get('/projects/:projectId/git/status', async (c) => {
    const projectId = c.req.param('projectId');

    try {
      // Validate project exists
      const project = await validateProject(projectId);
      if (!project) {
        return c.json(
          { error: { code: 'project_not_found', message: 'Project not found' } },
          404
        );
      }

      const status = await checkpointService.getProjectStatus(
        getWorkspacePath(projectId)
      );

      return c.json({ ok: true, status });
    } catch (error: any) {
      console.error('[Checkpoints] Status error:', error);
      return c.json(
        { error: { code: 'status_failed', message: error.message || 'Failed to get status' } },
        500
      );
    }
  });

  return router;
}

export default checkpointRoutes;
