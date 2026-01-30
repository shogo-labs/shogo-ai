/**
 * GitHub Routes - GitHub App integration for project sync
 *
 * Endpoints:
 * - GET    /github/status           - Check if GitHub App is configured
 * - GET    /github/install-url      - Get GitHub App installation URL
 * - GET    /github/installations    - List user's installations
 * - GET    /github/repos            - List repositories for an installation
 * - POST   /github/repos            - Create a new repository
 *
 * Project-specific:
 * - GET    /projects/:projectId/github           - Get GitHub connection status
 * - POST   /projects/:projectId/github/connect   - Connect project to GitHub repo
 * - DELETE /projects/:projectId/github           - Disconnect from GitHub
 * - POST   /projects/:projectId/github/push      - Push to GitHub
 * - POST   /projects/:projectId/github/pull      - Pull from GitHub
 * - POST   /projects/:projectId/github/sync      - Full sync (pull + push)
 *
 * Webhooks:
 * - POST   /github/webhook          - Receive GitHub webhooks
 */

import { Hono } from 'hono';
import { join } from 'path';
import * as githubService from '../services/github.service';
import { prisma } from '../lib/prisma';

// =============================================================================
// Types
// =============================================================================

export interface GitHubRoutesConfig {
  /** Directory containing project workspaces */
  workspacesDir: string;
}

// =============================================================================
// Routes
// =============================================================================

export function githubRoutes(config: GitHubRoutesConfig) {
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

  // ===========================================================================
  // General GitHub endpoints
  // ===========================================================================

  /**
   * GET /github/status - Check if GitHub App is configured
   */
  router.get('/github/status', async (c) => {
    try {
      const configured = githubService.isConfigured();
      return c.json({
        ok: true,
        configured,
        installUrl: configured ? githubService.getInstallationUrl() : null,
      });
    } catch (error: any) {
      return c.json(
        { error: { code: 'status_error', message: error.message } },
        500
      );
    }
  });

  /**
   * GET /github/install-url - Get GitHub App installation URL
   */
  router.get('/github/install-url', async (c) => {
    try {
      if (!githubService.isConfigured()) {
        return c.json(
          { error: { code: 'not_configured', message: 'GitHub App not configured' } },
          400
        );
      }

      return c.json({
        ok: true,
        url: githubService.getInstallationUrl(),
      });
    } catch (error: any) {
      return c.json(
        { error: { code: 'url_error', message: error.message } },
        500
      );
    }
  });

  /**
   * GET /github/installations - List installations for the GitHub App
   */
  router.get('/github/installations', async (c) => {
    try {
      if (!githubService.isConfigured()) {
        return c.json(
          { error: { code: 'not_configured', message: 'GitHub App not configured' } },
          400
        );
      }

      const installations = await githubService.listInstallations();
      return c.json({ ok: true, installations });
    } catch (error: any) {
      console.error('[GitHub] List installations error:', error);
      return c.json(
        { error: { code: 'list_error', message: error.message } },
        500
      );
    }
  });

  /**
   * GET /github/repos - List repositories for an installation
   */
  router.get('/github/repos', async (c) => {
    try {
      const installationIdStr = c.req.query('installation_id');
      if (!installationIdStr) {
        return c.json(
          { error: { code: 'invalid_request', message: 'installation_id is required' } },
          400
        );
      }

      const installationId = parseInt(installationIdStr, 10);
      if (isNaN(installationId)) {
        return c.json(
          { error: { code: 'invalid_request', message: 'Invalid installation_id' } },
          400
        );
      }

      const repos = await githubService.listRepositories(installationId);
      return c.json({ ok: true, repositories: repos });
    } catch (error: any) {
      console.error('[GitHub] List repos error:', error);
      return c.json(
        { error: { code: 'list_error', message: error.message } },
        500
      );
    }
  });

  /**
   * POST /github/repos - Create a new repository
   */
  router.post('/github/repos', async (c) => {
    try {
      const body = await c.req.json<{
        installation_id: number;
        name: string;
        description?: string;
        private?: boolean;
        org?: string;
      }>();

      if (!body.installation_id || !body.name) {
        return c.json(
          { error: { code: 'invalid_request', message: 'installation_id and name are required' } },
          400
        );
      }

      const repo = await githubService.createRepository(body.installation_id, {
        name: body.name,
        description: body.description,
        private: body.private ?? true,
        org: body.org,
      });

      return c.json({ ok: true, repository: repo }, 201);
    } catch (error: any) {
      console.error('[GitHub] Create repo error:', error);
      return c.json(
        { error: { code: 'create_error', message: error.message } },
        500
      );
    }
  });

  // ===========================================================================
  // Project-specific GitHub endpoints
  // ===========================================================================

  /**
   * GET /projects/:projectId/github - Get GitHub connection for project
   */
  router.get('/projects/:projectId/github', async (c) => {
    const projectId = c.req.param('projectId');

    try {
      const project = await validateProject(projectId);
      if (!project) {
        return c.json(
          { error: { code: 'project_not_found', message: 'Project not found' } },
          404
        );
      }

      const connection = await githubService.getConnection(projectId);

      if (!connection) {
        return c.json({
          ok: true,
          connected: false,
          connection: null,
        });
      }

      return c.json({
        ok: true,
        connected: true,
        connection: {
          id: connection.id,
          repoOwner: connection.repoOwner,
          repoName: connection.repoName,
          repoFullName: connection.repoFullName,
          defaultBranch: connection.defaultBranch,
          isPrivate: connection.isPrivate,
          syncEnabled: connection.syncEnabled,
          lastPushAt: connection.lastPushAt,
          lastPullAt: connection.lastPullAt,
          lastSyncError: connection.lastSyncError,
        },
      });
    } catch (error: any) {
      console.error('[GitHub] Get connection error:', error);
      return c.json(
        { error: { code: 'get_error', message: error.message } },
        500
      );
    }
  });

  /**
   * POST /projects/:projectId/github/connect - Connect project to GitHub
   */
  router.post('/projects/:projectId/github/connect', async (c) => {
    const projectId = c.req.param('projectId');

    try {
      const project = await validateProject(projectId);
      if (!project) {
        return c.json(
          { error: { code: 'project_not_found', message: 'Project not found' } },
          404
        );
      }

      const body = await c.req.json<{
        installation_id: number;
        repo_owner: string;
        repo_name: string;
      }>();

      if (!body.installation_id || !body.repo_owner || !body.repo_name) {
        return c.json(
          { error: { code: 'invalid_request', message: 'installation_id, repo_owner, and repo_name are required' } },
          400
        );
      }

      const { connection, repo } = await githubService.connectRepository({
        projectId,
        workspacePath: getWorkspacePath(projectId),
        installationId: body.installation_id,
        repoOwner: body.repo_owner,
        repoName: body.repo_name,
      });

      return c.json({
        ok: true,
        connection: {
          id: connection.id,
          repoOwner: connection.repoOwner,
          repoName: connection.repoName,
          repoFullName: connection.repoFullName,
          defaultBranch: connection.defaultBranch,
          isPrivate: connection.isPrivate,
        },
        repository: {
          id: repo.id,
          name: repo.name,
          full_name: repo.full_name,
          html_url: repo.html_url,
          private: repo.private,
        },
      }, 201);
    } catch (error: any) {
      console.error('[GitHub] Connect error:', error);
      return c.json(
        { error: { code: 'connect_error', message: error.message } },
        500
      );
    }
  });

  /**
   * DELETE /projects/:projectId/github - Disconnect from GitHub
   */
  router.delete('/projects/:projectId/github', async (c) => {
    const projectId = c.req.param('projectId');

    try {
      const project = await validateProject(projectId);
      if (!project) {
        return c.json(
          { error: { code: 'project_not_found', message: 'Project not found' } },
          404
        );
      }

      await githubService.disconnectRepository(projectId);
      return c.json({ ok: true });
    } catch (error: any) {
      console.error('[GitHub] Disconnect error:', error);
      return c.json(
        { error: { code: 'disconnect_error', message: error.message } },
        500
      );
    }
  });

  /**
   * POST /projects/:projectId/github/push - Push to GitHub
   */
  router.post('/projects/:projectId/github/push', async (c) => {
    const projectId = c.req.param('projectId');

    try {
      const project = await validateProject(projectId);
      if (!project) {
        return c.json(
          { error: { code: 'project_not_found', message: 'Project not found' } },
          404
        );
      }

      const result = await githubService.pushToGitHub(
        projectId,
        getWorkspacePath(projectId)
      );

      if (!result.success) {
        return c.json(
          { error: { code: 'push_failed', message: result.error || 'Push failed' } },
          400
        );
      }

      return c.json({ ok: true, ...result });
    } catch (error: any) {
      console.error('[GitHub] Push error:', error);
      return c.json(
        { error: { code: 'push_error', message: error.message } },
        500
      );
    }
  });

  /**
   * POST /projects/:projectId/github/pull - Pull from GitHub
   */
  router.post('/projects/:projectId/github/pull', async (c) => {
    const projectId = c.req.param('projectId');

    try {
      const project = await validateProject(projectId);
      if (!project) {
        return c.json(
          { error: { code: 'project_not_found', message: 'Project not found' } },
          404
        );
      }

      const result = await githubService.pullFromGitHub(
        projectId,
        getWorkspacePath(projectId)
      );

      if (!result.success) {
        return c.json(
          { error: { code: 'pull_failed', message: result.error || 'Pull failed' } },
          400
        );
      }

      return c.json({ ok: true, ...result });
    } catch (error: any) {
      console.error('[GitHub] Pull error:', error);
      return c.json(
        { error: { code: 'pull_error', message: error.message } },
        500
      );
    }
  });

  /**
   * POST /projects/:projectId/github/sync - Full sync (pull + push)
   */
  router.post('/projects/:projectId/github/sync', async (c) => {
    const projectId = c.req.param('projectId');

    try {
      const project = await validateProject(projectId);
      if (!project) {
        return c.json(
          { error: { code: 'project_not_found', message: 'Project not found' } },
          404
        );
      }

      const result = await githubService.syncWithGitHub(
        projectId,
        getWorkspacePath(projectId)
      );

      if (!result.success) {
        return c.json(
          { error: { code: 'sync_failed', message: result.error || 'Sync failed' } },
          400
        );
      }

      return c.json({ ok: true, ...result });
    } catch (error: any) {
      console.error('[GitHub] Sync error:', error);
      return c.json(
        { error: { code: 'sync_error', message: error.message } },
        500
      );
    }
  });

  // ===========================================================================
  // Webhook endpoint
  // ===========================================================================

  /**
   * POST /github/webhook - Receive GitHub webhooks
   */
  router.post('/github/webhook', async (c) => {
    try {
      const signature = c.req.header('x-hub-signature-256');
      const event = c.req.header('x-github-event');
      const payload = await c.req.text();

      // Verify webhook signature
      if (signature && !githubService.verifyWebhookSignature(payload, signature)) {
        console.warn('[GitHub] Invalid webhook signature');
        return c.json({ error: 'Invalid signature' }, 401);
      }

      const data = JSON.parse(payload);

      // Handle different event types
      switch (event) {
        case 'installation':
          await githubService.handleInstallationWebhook(
            data.action,
            data.installation
          );
          break;

        case 'push':
          if (data.installation?.id) {
            await githubService.handlePushWebhook(
              data.installation.id,
              data.repository.full_name,
              data.commits || []
            );
          }
          break;

        case 'ping':
          console.log('[GitHub] Webhook ping received');
          break;

        default:
          console.log(`[GitHub] Unhandled webhook event: ${event}`);
      }

      return c.json({ ok: true });
    } catch (error: any) {
      console.error('[GitHub] Webhook error:', error);
      return c.json(
        { error: { code: 'webhook_error', message: error.message } },
        500
      );
    }
  });

  return router;
}

export default githubRoutes;
