// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GitHub Routes - GitHub integration for project sync (GitHub App or user access token)
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
 * - POST   /projects/:projectId/github/authorize - Link to authorize the GitHub App for a repo
 * - GET    /github/callback                      - App Setup URL / OAuth callback (public)
 * - DELETE /projects/:projectId/github           - Disconnect from GitHub
 * - POST   /projects/:projectId/github/push      - Push to GitHub
 * - POST   /projects/:projectId/github/pull      - Pull from GitHub
 * - POST   /projects/:projectId/github/sync      - Full sync (pull + push)
 *
 * Webhooks:
 * - POST   /github/webhook          - Receive GitHub webhooks
 */

import { Hono } from 'hono';
import * as githubService from '../services/github.service';
import { runtimeGitHubWorkspace, type GitHubWorkspace } from '../services/github-workspace';
import { createAuthorizeUrl, handleAuthorizeCallback } from '../services/github-authorize';
import { getFrontendUrl } from '../lib/cloud-urls';
import { grantAccess } from '../services/integration-credentials';
import { isPersonalConnectState, verifyPersonalConnectState } from '../services/integration-credentials/connect-state';
import { ensureDefaultCredentialProviders, githubAdapter } from '../services/integration-credentials/defaults';
import { connectedPage, connectFailedPage } from './integration-credentials';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
import { prisma } from '../lib/prisma';

// =============================================================================
// Types
// =============================================================================

export interface GitHubRoutesConfig {
  /**
   * Where a project's git operations run. Defaults to the project's runtime,
   * which owns its files; the API has no authoritative copy.
   */
  workspaceFor?: (projectId: string) => GitHubWorkspace;
}

// =============================================================================
// Routes
// =============================================================================

export function githubRoutes(config: GitHubRoutesConfig = {}) {
  const workspaceFor = config.workspaceFor ?? runtimeGitHubWorkspace;
  const router = new Hono();

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
          branch: connection.branch ?? connection.defaultBranch,
          authType: connection.authType,
          tokenLogin: connection.tokenLogin,
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
   *
   * Body: `repo_owner`, `repo_name`, and exactly one of `installation_id`
   * (Shogo GitHub App) or `token` (personal access / OAuth token, stored
   * encrypted and never returned).
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
        installation_id?: number;
        token?: string;
        repo_owner: string;
        repo_name: string;
        branch?: string;
      }>();

      const token = typeof body.token === 'string' ? body.token.trim() : '';
      const hasInstallation = typeof body.installation_id === 'number' && body.installation_id > 0;
      if (!body.repo_owner || !body.repo_name || hasInstallation === !!token) {
        return c.json(
          {
            error: {
              code: 'invalid_request',
              message: 'repo_owner, repo_name, and exactly one of installation_id or token are required',
            },
          },
          400
        );
      }

      const { connection, repo, workspace } = await githubService.connectRepository({
        projectId,
        workspace: workspaceFor(projectId),
        ...(token ? { token } : { installationId: body.installation_id }),
        repoOwner: body.repo_owner,
        repoName: body.repo_name,
        ...(typeof body.branch === 'string' && body.branch.trim() ? { branch: body.branch.trim() } : {}),
      });

      return c.json({
        ok: true,
        connection: {
          id: connection.id,
          repoOwner: connection.repoOwner,
          repoName: connection.repoName,
          repoFullName: connection.repoFullName,
          defaultBranch: connection.defaultBranch,
          branch: connection.branch ?? connection.defaultBranch,
          authType: connection.authType,
          tokenLogin: connection.tokenLogin,
          isPrivate: connection.isPrivate,
        },
        repository: {
          id: repo.id,
          name: repo.name,
          full_name: repo.full_name,
          html_url: repo.html_url,
          private: repo.private,
        },
        workspace,
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
   * POST /projects/:projectId/github/authorize - Link to authorize the Shogo
   * GitHub App for a repository (the alternative to sharing a token).
   *
   * Body: `repo_owner`, `repo_name`. Returns `{ url }`; open it in a browser.
   * GitHub returns to `GET /github/callback`, which saves the connection.
   */
  router.post('/projects/:projectId/github/authorize', async (c) => {
    const projectId = c.req.param('projectId');
    try {
      const project = await validateProject(projectId);
      if (!project) {
        return c.json({ error: { code: 'project_not_found', message: 'Project not found' } }, 404);
      }
      const body = await c.req.json<{ repo_owner?: string; repo_name?: string }>().catch(() => ({} as any));
      const repoOwner = typeof body.repo_owner === 'string' ? body.repo_owner.trim() : '';
      const repoName = typeof body.repo_name === 'string' ? body.repo_name.trim() : '';
      if (!repoOwner || !repoName) {
        return c.json({ error: { code: 'invalid_request', message: 'repo_owner and repo_name are required' } }, 400);
      }
      if (!githubService.isOAuthConfigured()) {
        return c.json(
          {
            error: {
              code: 'not_configured',
              message: 'Authorizing the Shogo GitHub App is not configured on this server; share an access token instead.',
            },
          },
          400
        );
      }
      const userId = (c.get('auth') as { userId?: string } | undefined)?.userId;
      const url = createAuthorizeUrl({ projectId, repoOwner, repoName, userId });
      return c.json({ ok: true, url });
    } catch (error: any) {
      console.error('[GitHub] Authorize URL error:', error);
      return c.json({ error: { code: 'authorize_error', message: error.message } }, 500);
    }
  });

  /**
   * GET /projects/:projectId/github/authorize?repo=owner/name - The short link
   * agents hand out. Opened in a signed-in browser, it redirects to GitHub
   * with a freshly signed state.
   */
  router.get('/projects/:projectId/github/authorize', async (c) => {
    const projectId = c.req.param('projectId');
    const page = (title: string, message: string, status: 400 | 404 | 500) =>
      c.html(
        `<!doctype html><html><head><title>${escapeHtml(title)}</title></head><body>` +
          `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`,
        status
      );
    try {
      const project = await validateProject(projectId);
      if (!project) return page('Project not found', 'This project does not exist or you cannot access it.', 404);
      const [repoOwner, repoName, ...rest] = (c.req.query('repo') ?? '').trim().split('/');
      if (!repoOwner || !repoName || rest.length) {
        return page('GitHub authorization', 'The link is missing the repository (expected ?repo=owner/name).', 400);
      }
      if (!githubService.isOAuthConfigured()) {
        return page(
          'GitHub authorization',
          'Authorizing the Shogo GitHub App is not configured on this server; share an access token instead.',
          400
        );
      }
      const userId = (c.get('auth') as { userId?: string } | undefined)?.userId;
      return c.redirect(createAuthorizeUrl({ projectId, repoOwner, repoName, userId }));
    } catch (error: any) {
      console.error('[GitHub] Authorize link error:', error);
      return page('GitHub authorization failed', error.message, 500);
    }
  });

  /**
   * GET /github/callback - GitHub App Setup URL and OAuth callback for the
   * authorize flow. Public: the browser carries no Shogo session here; the
   * signed `state` names the project and the OAuth code proves the GitHub user.
   */
  router.get('/github/callback', async (c) => {
    const state = c.req.query('state');
    if (isPersonalConnectState(state)) {
      const personal = verifyPersonalConnectState(state);
      const code = c.req.query('code');
      if (!personal || !code) {
        const reason = c.req.query('error_description') || 'This GitHub link is invalid or has expired. Ask for a new one.';
        return c.html(connectFailedPage(reason), 400);
      }
      try {
        ensureDefaultCredentialProviders({ loadGitHub: async () => githubService });
        const adapter = githubAdapter();
        if (!adapter) throw new Error('GitHub is not available on this server');
        const { login } = await adapter.completeConnect({ userId: personal.userId, code });
        if (personal.projectId) await grantAccess(personal.userId, personal.projectId, 'github');
        return c.html(connectedPage('GitHub', login));
      } catch (err: any) {
        console.error('[GitHub] Personal connect failed:', err?.message ?? err);
        return c.html(connectFailedPage(err?.message ?? 'Could not connect GitHub'), 400);
      }
    }
    const result = await handleAuthorizeCallback(
      {
        state: c.req.query('state'),
        code: c.req.query('code'),
        installationId: c.req.query('installation_id'),
        error: c.req.query('error'),
        errorDescription: c.req.query('error_description'),
      },
      { workspaceFor }
    );
    if (result.kind === 'redirect') return c.redirect(result.url);
    if (result.projectId) {
      const target = new URL(`${getFrontendUrl().replace(/\/+$/, '')}/projects/${encodeURIComponent(result.projectId)}`);
      target.searchParams.set('github', result.ok ? 'connected' : 'error');
      target.searchParams.set('github_message', result.message);
      return c.redirect(target.toString());
    }
    return c.html(
      `<!doctype html><html><head><title>GitHub authorization</title></head><body>` +
        `<h1>GitHub authorization failed</h1><p>${escapeHtml(result.message)}</p></body></html>`,
      400
    );
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
   * GET /projects/:projectId/github/branches - Branches of the connected repository
   */
  router.get('/projects/:projectId/github/branches', async (c) => {
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
      const branches = await githubService.listBranches(projectId);
      return c.json({
        ok: true,
        branches,
        current: connection?.branch ?? connection?.defaultBranch,
        defaultBranch: connection?.defaultBranch,
      });
    } catch (error: any) {
      if (error instanceof githubService.GitHubNotConnectedError) {
        return c.json({ error: { code: 'not_connected', message: error.message } }, 409);
      }
      console.error('[GitHub] List branches error:', error);
      return c.json(
        { error: { code: 'branches_error', message: error.message } },
        500
      );
    }
  });

  /**
   * POST /projects/:projectId/github/branch - Switch the workspace to another branch
   *
   * Body: `branch`, an existing branch of the connected repository.
   */
  router.post('/projects/:projectId/github/branch', async (c) => {
    const projectId = c.req.param('projectId');

    try {
      const project = await validateProject(projectId);
      if (!project) {
        return c.json(
          { error: { code: 'project_not_found', message: 'Project not found' } },
          404
        );
      }

      const body = await c.req.json<{ branch?: string }>().catch(() => ({} as { branch?: string }));
      const branch = typeof body.branch === 'string' ? body.branch.trim() : '';
      if (!branch || !githubService.isValidBranchName(branch)) {
        return c.json({ error: { code: 'invalid_request', message: 'A valid branch is required' } }, 400);
      }

      const result = await githubService.switchBranch(projectId, branch, workspaceFor(projectId));
      return c.json({ ok: true, ...result });
    } catch (error: any) {
      if (error instanceof githubService.GitHubNotConnectedError) {
        return c.json({ error: { code: 'not_connected', message: error.message } }, 409);
      }
      console.error('[GitHub] Switch branch error:', error);
      return c.json(
        { error: { code: 'branch_error', message: error.message } },
        400
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
        workspaceFor(projectId)
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
        workspaceFor(projectId)
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
        workspaceFor(projectId)
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
      if (!signature || !githubService.verifyWebhookSignature(payload, signature)) {
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

        // Task-source events (issue pipeline, docs/issue-pipeline/PLAN.md
        // Phase 2): wake the connected project's agent. Each handler
        // no-ops when there's no connected project or the event doesn't
        // pass its own action/bot filter.
        case 'issues':
          await githubService.handleIssueWebhook(c, data);
          break;

        case 'issue_comment':
          await githubService.handleIssueCommentWebhook(c, data);
          break;

        case 'pull_request_review':
          await githubService.handlePullRequestReviewWebhook(c, data);
          break;

        case 'pull_request_review_comment':
          await githubService.handlePullRequestReviewCommentWebhook(c, data);
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
