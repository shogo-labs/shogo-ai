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
import * as gitService from '../services/git.service';
import { prisma } from '../lib/prisma';
import { hydrateRepo } from '../services/git-repo-store';

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
   * Ensure the project's git repo is present on this (stateless) API pod
   * before a read-only git operation (graph/commit/diff/status). The
   * durable repo lives in object storage; this hydrates it on demand so
   * any pod can serve the request. No-op when already local, no object
   * storage is configured, or no durable repo exists yet.
   */
  async function withHydratedRepo(projectId: string): Promise<string> {
    const workspacePath = getWorkspacePath(projectId);
    await hydrateRepo(projectId, workspacePath).catch((err) =>
      console.warn(`[Checkpoints] hydrate for ${projectId} failed:`, err?.message ?? err),
    );
    return workspacePath;
  }

  /**
   * Validate project exists.
   */
  async function validateProject(projectId: string) {
    return prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, workspaceId: true, workingMode: true } as any,
    });
  }

  /**
   * External (folder-linked) projects never have checkpoints — Shogo
   * doesn't manage their git. Return a typed 409 so the CheckpointsPanel
   * UI can render the "use your own git" banner with a single round
   * trip (versus the 500 a `createCheckpoint` call would surface).
   */
  function externalModeResponse(c: any) {
    return c.json(
      {
        error: {
          code: 'checkpoints_disabled_in_external_mode',
          message:
            "Checkpoints are disabled for folder-linked projects. Use your own git workflow — Shogo doesn't manage the repo.",
        },
      },
      409,
    );
  }

  function isExternal(project: { workingMode?: string } | null | undefined): boolean {
    return project?.workingMode === 'external';
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
      if (isExternal(project as any)) return externalModeResponse(c);

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
      if (isExternal(project as any)) return externalModeResponse(c);

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
      if (isExternal(project as any)) return externalModeResponse(c);

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
      if (isExternal(project as any)) return externalModeResponse(c);

      const diff = await checkpointService.getDiff(
        await withHydratedRepo(projectId),
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
      if (isExternal(project as any)) return externalModeResponse(c);

      const status = await checkpointService.getProjectStatus(
        await withHydratedRepo(projectId)
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

  /**
   * GET /projects/:projectId/git/graph - Commit DAG for the GitKraken view.
   * Returns commits (with parents + ref decorations + co-authors), the
   * branch + tag lists, and the current HEAD.
   */
  router.get('/projects/:projectId/git/graph', async (c) => {
    const projectId = c.req.param('projectId');
    const limit = Math.min(parseInt(c.req.query('limit') || '200', 10) || 200, 1000);
    const skip = Math.max(parseInt(c.req.query('skip') || '0', 10) || 0, 0);

    try {
      const project = await validateProject(projectId);
      if (!project) {
        return c.json(
          { error: { code: 'project_not_found', message: 'Project not found' } },
          404
        );
      }
      if (isExternal(project as any)) return externalModeResponse(c);

      const workspacePath = await withHydratedRepo(projectId);
      const [commits, branches, tags, head, currentBranch] = await Promise.all([
        gitService.getGraph(workspacePath, { limit, skip }),
        gitService.listBranches(workspacePath),
        gitService.listTags(workspacePath),
        gitService.getHeadSha(workspacePath),
        gitService.getCurrentBranch(workspacePath),
      ]);

      return c.json({
        ok: true,
        graph: { commits, branches, tags, head, currentBranch },
        hasMore: commits.length === limit,
      });
    } catch (error: any) {
      console.error('[Checkpoints] Graph error:', error);
      return c.json(
        { error: { code: 'graph_failed', message: error.message || 'Failed to get graph' } },
        500
      );
    }
  });

  /**
   * GET /projects/:projectId/git/commit/:sha - Full detail for one commit
   * (metadata, parents, co-authors, and the files it changed).
   */
  router.get('/projects/:projectId/git/commit/:sha', async (c) => {
    const projectId = c.req.param('projectId');
    const sha = c.req.param('sha');

    // Reject anything that isn't a plausible git object id / ref so the value
    // can't smuggle args into the git CLI.
    if (!/^[0-9a-zA-Z][0-9a-zA-Z._/-]{0,199}$/.test(sha)) {
      return c.json(
        { error: { code: 'invalid_request', message: 'Invalid commit ref' } },
        400
      );
    }

    try {
      const project = await validateProject(projectId);
      if (!project) {
        return c.json(
          { error: { code: 'project_not_found', message: 'Project not found' } },
          404
        );
      }
      if (isExternal(project as any)) return externalModeResponse(c);

      const detail = await gitService.getCommitDetail(await withHydratedRepo(projectId), sha);
      if (!detail) {
        return c.json(
          { error: { code: 'commit_not_found', message: 'Commit not found' } },
          404
        );
      }

      return c.json({ ok: true, commit: detail });
    } catch (error: any) {
      console.error('[Checkpoints] Commit detail error:', error);
      return c.json(
        { error: { code: 'commit_failed', message: error.message || 'Failed to get commit' } },
        500
      );
    }
  });

  return router;
}

export default checkpointRoutes;
