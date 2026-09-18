// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GitHub App Service - GitHub App authentication and repository operations
 *
 * Handles GitHub App installation authentication, repository management,
 * and sync operations between Shogo projects and GitHub repositories.
 *
 * GitHub App Flow:
 * 1. User installs Shogo GitHub App on their account/org
 * 2. App receives webhook with installation_id
 * 3. App generates installation access token for API calls
 * 4. User connects a project to a repo (existing or new)
 * 5. Checkpoints are synced to GitHub as commits
 *
 * Environment Variables:
 * - GH_APP_ID: GitHub App ID
 * - GH_APP_PRIVATE_KEY: GitHub App private key (PEM format)
 * - GH_APP_CLIENT_ID: GitHub App OAuth client ID
 * - GH_APP_CLIENT_SECRET: GitHub App OAuth client secret
 * - GH_APP_WEBHOOK_SECRET: Webhook secret for verification
 */

import { execSync } from 'child_process';
import { sign } from 'jsonwebtoken';
import type { Context } from 'hono';
import { prisma } from '../lib/prisma';
import * as gitService from './git.service';

// =============================================================================
// Types
// =============================================================================

export interface GitHubInstallation {
  id: number;
  account: {
    login: string;
    type: 'User' | 'Organization';
    avatar_url: string;
  };
  repository_selection: 'all' | 'selected';
  permissions: Record<string, string>;
}

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
  owner: {
    login: string;
    avatar_url: string;
  };
}

export interface CreateRepoOptions {
  name: string;
  description?: string;
  private?: boolean;
  auto_init?: boolean;
}

export interface ConnectRepoOptions {
  projectId: string;
  workspacePath: string;
  installationId: number;
  repoOwner: string;
  repoName: string;
}

export interface SyncResult {
  success: boolean;
  pushed: boolean;
  pulled: boolean;
  commits: number;
  error?: string;
}

// =============================================================================
// Configuration
// =============================================================================

const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_APP_ID = process.env.GH_APP_ID;
const GITHUB_APP_PRIVATE_KEY = process.env.GH_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');

// =============================================================================
// JWT & Token Generation
// =============================================================================

/**
 * Generate a JWT for GitHub App authentication.
 * This JWT is used to get installation access tokens.
 */
export function generateAppJWT(): string {
  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    throw new Error('GitHub App credentials not configured');
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60, // Issued 60 seconds ago to allow for clock drift
    exp: now + 600, // Expires in 10 minutes
    iss: GITHUB_APP_ID,
  };

  return sign(payload, GITHUB_APP_PRIVATE_KEY, { algorithm: 'RS256' });
}

/**
 * Get an installation access token for making API calls.
 * Tokens are valid for 1 hour.
 */
export async function getInstallationToken(installationId: number): Promise<string> {
  const jwt = generateAppJWT();

  const response = await fetch(
    `${GITHUB_API_URL}/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get installation token: ${error}`);
  }

  const data = await response.json();
  return data.token;
}

// =============================================================================
// Installation Management
// =============================================================================

/**
 * Get all installations for the GitHub App.
 */
export async function listInstallations(): Promise<GitHubInstallation[]> {
  const jwt = generateAppJWT();

  const response = await fetch(`${GITHUB_API_URL}/app/installations`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to list installations: ${error}`);
  }

  return response.json();
}

/**
 * Get installation details by ID.
 */
export async function getInstallation(installationId: number): Promise<GitHubInstallation> {
  const jwt = generateAppJWT();

  const response = await fetch(`${GITHUB_API_URL}/app/installations/${installationId}`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get installation: ${error}`);
  }

  return response.json();
}

// =============================================================================
// Repository Operations
// =============================================================================

/**
 * List repositories accessible to an installation.
 */
export async function listRepositories(installationId: number): Promise<GitHubRepository[]> {
  const token = await getInstallationToken(installationId);

  const response = await fetch(`${GITHUB_API_URL}/installation/repositories`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to list repositories: ${error}`);
  }

  const data = await response.json();
  return data.repositories;
}

/**
 * Get repository details.
 */
export async function getRepository(
  installationId: number,
  owner: string,
  repo: string
): Promise<GitHubRepository> {
  const token = await getInstallationToken(installationId);

  const response = await fetch(`${GITHUB_API_URL}/repos/${owner}/${repo}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get repository: ${error}`);
  }

  return response.json();
}

/**
 * Create a new repository in user's account or organization.
 */
export async function createRepository(
  installationId: number,
  options: CreateRepoOptions & { org?: string }
): Promise<GitHubRepository> {
  const token = await getInstallationToken(installationId);
  const { org, ...repoOptions } = options;

  const url = org
    ? `${GITHUB_API_URL}/orgs/${org}/repos`
    : `${GITHUB_API_URL}/user/repos`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: repoOptions.name,
      description: repoOptions.description || '',
      private: repoOptions.private ?? true,
      auto_init: repoOptions.auto_init ?? false,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to create repository: ${error.message || JSON.stringify(error)}`);
  }

  return response.json();
}

// =============================================================================
// Project Connection
// =============================================================================

/**
 * Connect a project to a GitHub repository.
 * Sets up the remote and creates the GitHubConnection record.
 */
export async function connectRepository(options: ConnectRepoOptions): Promise<{
  connection: any;
  repo: GitHubRepository;
}> {
  const { projectId, workspacePath, installationId, repoOwner, repoName } = options;

  // Get repository details
  const repo = await getRepository(installationId, repoOwner, repoName);

  // Initialize git if needed
  await gitService.initRepo(workspacePath);

  // Get installation token for authenticated remote URL
  const token = await getInstallationToken(installationId);
  const remoteUrl = `https://x-access-token:${token}@github.com/${repoOwner}/${repoName}.git`;

  // Add remote
  await gitService.addRemote(workspacePath, 'origin', remoteUrl);

  // Create or update GitHubConnection record
  const connection = await prisma.gitHubConnection.upsert({
    where: { projectId },
    create: {
      projectId,
      repoOwner,
      repoName,
      repoFullName: repo.full_name,
      defaultBranch: repo.default_branch,
      installationId,
      repoId: repo.id,
      isPrivate: repo.private,
      syncEnabled: true,
    },
    update: {
      repoOwner,
      repoName,
      repoFullName: repo.full_name,
      defaultBranch: repo.default_branch,
      installationId,
      repoId: repo.id,
      isPrivate: repo.private,
      syncEnabled: true,
      lastSyncError: null,
    },
  });

  return { connection, repo };
}

/**
 * Disconnect a project from GitHub.
 */
export async function disconnectRepository(projectId: string): Promise<void> {
  await prisma.gitHubConnection.delete({
    where: { projectId },
  });
}

/**
 * Get GitHub connection for a project.
 */
export async function getConnection(projectId: string) {
  return prisma.gitHubConnection.findUnique({
    where: { projectId },
  });
}

// =============================================================================
// Sync Operations
// =============================================================================

/**
 * Refresh the remote URL with a new access token.
 * Installation tokens expire after 1 hour.
 */
async function refreshRemoteToken(
  workspacePath: string,
  installationId: number,
  repoOwner: string,
  repoName: string
): Promise<void> {
  const token = await getInstallationToken(installationId);
  const remoteUrl = `https://x-access-token:${token}@github.com/${repoOwner}/${repoName}.git`;
  await gitService.addRemote(workspacePath, 'origin', remoteUrl);
}

/**
 * Push local commits to GitHub.
 */
export async function pushToGitHub(
  projectId: string,
  workspacePath: string
): Promise<SyncResult> {
  const connection = await getConnection(projectId);
  if (!connection) {
    return { success: false, pushed: false, pulled: false, commits: 0, error: 'No GitHub connection' };
  }

  if (!connection.syncEnabled) {
    return { success: false, pushed: false, pulled: false, commits: 0, error: 'Sync is disabled' };
  }

  try {
    // Refresh token before push
    await refreshRemoteToken(
      workspacePath,
      connection.installationId!,
      connection.repoOwner,
      connection.repoName
    );

    // Get current branch
    const branch = await gitService.getCurrentBranch(workspacePath);

    // Push with upstream tracking
    const result = await gitService.push(workspacePath, {
      remote: 'origin',
      branch,
      setUpstream: true,
    });

    if (!result.success) {
      await prisma.gitHubConnection.update({
        where: { projectId },
        data: { lastSyncError: result.error },
      });
      return { success: false, pushed: false, pulled: false, commits: 0, error: result.error };
    }

    // Update last push time
    await prisma.gitHubConnection.update({
      where: { projectId },
      data: { lastPushAt: new Date(), lastSyncError: null },
    });

    return { success: true, pushed: true, pulled: false, commits: 1 };
  } catch (err: any) {
    const errorMsg = err.message || 'Push failed';
    await prisma.gitHubConnection.update({
      where: { projectId },
      data: { lastSyncError: errorMsg },
    });
    return { success: false, pushed: false, pulled: false, commits: 0, error: errorMsg };
  }
}

/**
 * Pull changes from GitHub.
 */
export async function pullFromGitHub(
  projectId: string,
  workspacePath: string
): Promise<SyncResult> {
  const connection = await getConnection(projectId);
  if (!connection) {
    return { success: false, pushed: false, pulled: false, commits: 0, error: 'No GitHub connection' };
  }

  try {
    // Refresh token before pull
    await refreshRemoteToken(
      workspacePath,
      connection.installationId!,
      connection.repoOwner,
      connection.repoName
    );

    // Fetch first
    await gitService.fetch(workspacePath);

    // Pull with rebase
    const result = await gitService.pull(workspacePath, {
      remote: 'origin',
      rebase: true,
    });

    if (!result.success) {
      await prisma.gitHubConnection.update({
        where: { projectId },
        data: { lastSyncError: result.error },
      });
      return { success: false, pushed: false, pulled: false, commits: 0, error: result.error };
    }

    // Update last pull time
    await prisma.gitHubConnection.update({
      where: { projectId },
      data: { lastPullAt: new Date(), lastSyncError: null },
    });

    return { success: true, pushed: false, pulled: true, commits: 0 };
  } catch (err: any) {
    const errorMsg = err.message || 'Pull failed';
    await prisma.gitHubConnection.update({
      where: { projectId },
      data: { lastSyncError: errorMsg },
    });
    return { success: false, pushed: false, pulled: false, commits: 0, error: errorMsg };
  }
}

/**
 * Full sync: pull then push.
 */
export async function syncWithGitHub(
  projectId: string,
  workspacePath: string
): Promise<SyncResult> {
  // Pull first
  const pullResult = await pullFromGitHub(projectId, workspacePath);
  if (!pullResult.success && pullResult.error !== 'No upstream branch') {
    return pullResult;
  }

  // Then push
  const pushResult = await pushToGitHub(projectId, workspacePath);
  
  return {
    success: pushResult.success,
    pushed: pushResult.pushed,
    pulled: pullResult.pulled,
    commits: pushResult.commits,
    error: pushResult.error,
  };
}

// =============================================================================
// Webhook Handling
// =============================================================================

/**
 * Verify GitHub webhook signature.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string
): boolean {
  const secret = process.env.GH_APP_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[GitHub] Webhook secret not configured');
    return false;
  }

  const crypto = require('crypto');
  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

/**
 * Handle installation created/deleted webhooks.
 */
export async function handleInstallationWebhook(
  action: 'created' | 'deleted' | 'suspend' | 'unsuspend',
  installation: GitHubInstallation
): Promise<void> {
  console.log(`[GitHub] Installation ${action}: ${installation.id} (${installation.account.login})`);

  if (action === 'deleted' || action === 'suspend') {
    // Disable sync for all projects using this installation
    await prisma.gitHubConnection.updateMany({
      where: { installationId: installation.id },
      data: {
        syncEnabled: false,
        lastSyncError: `GitHub App ${action === 'deleted' ? 'uninstalled' : 'suspended'}`,
      },
    });
  } else if (action === 'unsuspend') {
    // Re-enable sync
    await prisma.gitHubConnection.updateMany({
      where: { installationId: installation.id },
      data: {
        syncEnabled: true,
        lastSyncError: null,
      },
    });
  }
}

/**
 * Handle push webhooks to detect external changes.
 */
export async function handlePushWebhook(
  installationId: number,
  repoFullName: string,
  commits: any[]
): Promise<void> {
  console.log(`[GitHub] Push to ${repoFullName}: ${commits.length} commits`);

  // Find the project connected to this repo
  const connection = await prisma.gitHubConnection.findFirst({
    where: {
      installationId,
      repoFullName,
    },
  });

  if (!connection) {
    console.log(`[GitHub] No project connected to ${repoFullName}`);
    return;
  }

  // Mark that there are remote changes to pull
  // The frontend can poll for this and show a "sync needed" indicator
  await prisma.gitHubConnection.update({
    where: { id: connection.id },
    data: {
      updatedAt: new Date(),
    },
  });
}

// =============================================================================
// Task-source webhooks (issue pipeline): issue/comment/review -> agent
//
// A connected repo doubles as a task source (see docs/issue-pipeline/PLAN.md
// Phase 2). These events wake the connected project's agent the same way a
// sibling project would via `project_call` — through `agent-call.service.ts`,
// which resolves the project's runtime pod and posts to its
// `/agent/pipeline/call`. `wait: false` so the webhook ack to GitHub is fast;
// the agent turn runs in the runtime's background.
// =============================================================================

/**
 * Marker embedded in a PR body so later webhook events on that PR (reviews,
 * review comments, issue comments) can recover the pipeline `runId` that
 * opened it. Whichever agent opens the PR should append
 * `runIdMarker(runId)` to the body (e.g. via `gh pr create --body`).
 */
const RUN_ID_MARKER_RE = /<!--\s*shogo:runId=([a-zA-Z0-9_-]+)\s*-->/;

export function extractRunId(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  return RUN_ID_MARKER_RE.exec(text)?.[1] ?? undefined;
}

export function runIdMarker(runId: string): string {
  return `<!-- shogo:runId=${runId} -->`;
}

/** The GitHub App's own bot identity, e.g. `shogo-ai[bot]`. */
function botLogin(): string {
  return `${process.env.GH_APP_SLUG || 'shogo-ai'}[bot]`;
}

/** True when `login` is the GitHub App's own bot user (never react to our own comments). */
export function isBotLogin(login: string | null | undefined): boolean {
  return !!login && login.toLowerCase() === botLogin().toLowerCase();
}

/** True when `text` @-mentions the bot, e.g. "@shogo-ai please retry this". */
export function mentionsBot(text: string | null | undefined): boolean {
  if (!text) return false;
  const slug = (process.env.GH_APP_SLUG || 'shogo-ai').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Negative lookahead instead of `\b`: `\b` sits at the `-` in "shogo-ai",
  // so "@shogo-ai-impersonator" would otherwise still match "@shogo-ai".
  return new RegExp(`@${slug}(\\[bot\\])?(?![\\w-])`, 'i').test(text);
}

/**
 * Resolve the Shogo project connected to a repo. `installationId` narrows
 * the match when provided but isn't required — `repoFullName` is unique in
 * practice for a single GitHub App.
 */
async function findConnectionByRepo(repoFullName: string, installationId?: number) {
  return prisma.gitHubConnection.findFirst({
    where: { repoFullName, ...(installationId ? { installationId } : {}) },
    include: { project: { select: { id: true, workspaceId: true } } },
  });
}

/**
 * Look up the connected project and, if found, fire a fire-and-forget
 * `project_call`-style wake. Never throws — a failure to reach the runtime
 * must not fail the webhook ack to GitHub.
 */
async function wakeConnectedProjectAgent(
  c: Context,
  repoFullName: string,
  installationId: number | undefined,
  opts: { message: string; runId?: string },
): Promise<void> {
  try {
    const connection = await findConnectionByRepo(repoFullName, installationId);
    if (!connection) {
      console.log(`[GitHub] No project connected to ${repoFullName}; ignoring task-source webhook event`);
      return;
    }
    const { callProjectAgent } = await import('./agent-call.service');
    const outcome = await callProjectAgent(c, connection.project.id, connection.project.workspaceId, {
      message: opts.message,
      runId: opts.runId,
      wait: false,
    });
    if (outcome.status >= 400) {
      console.warn(
        `[GitHub] Failed to wake agent for ${repoFullName} (project ${connection.project.id}): ` +
          `${outcome.status} ${JSON.stringify(outcome.body)}`,
      );
    }
  } catch (err: any) {
    console.error(`[GitHub] wakeConnectedProjectAgent failed for ${repoFullName}:`, err?.message ?? err);
  }
}

/**
 * `issues` webhook — a new item entering the pipeline. Only `opened` wakes
 * the agent; labels/assignment/etc. are noise for intake.
 */
export async function handleIssueWebhook(c: Context, payload: any): Promise<void> {
  if (payload?.action !== 'opened') return;
  const repoFullName = payload.repository?.full_name;
  const issue = payload.issue;
  if (!repoFullName || !issue) return;
  const message = [
    `[GitHub] New issue #${issue.number} opened in ${repoFullName}: "${issue.title}"`,
    '',
    issue.body || '(no description)',
    '',
    `URL: ${issue.html_url}`,
  ].join('\n');
  await wakeConnectedProjectAgent(c, repoFullName, payload.installation?.id, { message });
}

/**
 * `issue_comment` webhook — fires for comments on both issues and PRs
 * (GitHub represents a PR as an `issue` with a `pull_request` stub). Wakes
 * the agent only when the comment mentions the bot or the thread is
 * bot-authored (the human-in-the-loop reply to the pipeline's own comment).
 */
export async function handleIssueCommentWebhook(c: Context, payload: any): Promise<void> {
  if (payload?.action !== 'created') return;
  const repoFullName = payload.repository?.full_name;
  const comment = payload.comment;
  const issue = payload.issue;
  if (!repoFullName || !comment || !issue) return;
  if (isBotLogin(comment.user?.login)) return; // never react to our own comments
  const botAuthoredThread = isBotLogin(issue.user?.login);
  if (!mentionsBot(comment.body) && !botAuthoredThread) return;

  const isPR = !!issue.pull_request;
  const runId = extractRunId(issue.body) ?? extractRunId(comment.body);
  const message = [
    `[GitHub] New comment on ${isPR ? 'PR' : 'issue'} #${issue.number} (${repoFullName}) by @${comment.user?.login}:`,
    '',
    comment.body,
    '',
    `URL: ${comment.html_url}`,
  ].join('\n');
  await wakeConnectedProjectAgent(c, repoFullName, payload.installation?.id, { message, runId });
}

/**
 * `pull_request_review` webhook — a submitted review (approve / request
 * changes / comment). Wakes the agent only when the review body mentions
 * the bot or the PR is bot-authored (a reviewer reacting to the pipeline's
 * own PR — this is the "react to human comments" leg of the pipeline).
 */
export async function handlePullRequestReviewWebhook(c: Context, payload: any): Promise<void> {
  if (payload?.action !== 'submitted') return;
  const repoFullName = payload.repository?.full_name;
  const review = payload.review;
  const pr = payload.pull_request;
  if (!repoFullName || !review || !pr) return;
  if (isBotLogin(review.user?.login)) return;
  const botAuthored = isBotLogin(pr.user?.login);
  if (!mentionsBot(review.body) && !botAuthored) return;

  const runId = extractRunId(pr.body);
  const message = [
    `[GitHub] PR review "${review.state}" on #${pr.number} (${repoFullName}) by @${review.user?.login}:`,
    '',
    review.body || '(no comment)',
    '',
    `URL: ${review.html_url}`,
  ].join('\n');
  await wakeConnectedProjectAgent(c, repoFullName, payload.installation?.id, { message, runId });
}

/**
 * `pull_request_review_comment` webhook — an inline review comment on a
 * diff line. Same bot filter as `pull_request_review`.
 */
export async function handlePullRequestReviewCommentWebhook(c: Context, payload: any): Promise<void> {
  if (payload?.action !== 'created') return;
  const repoFullName = payload.repository?.full_name;
  const comment = payload.comment;
  const pr = payload.pull_request;
  if (!repoFullName || !comment || !pr) return;
  if (isBotLogin(comment.user?.login)) return;
  const botAuthored = isBotLogin(pr.user?.login);
  if (!mentionsBot(comment.body) && !botAuthored) return;

  const runId = extractRunId(pr.body);
  const location = comment.path ? `${comment.path}${comment.line ? ':' + comment.line : ''}` : '(unknown location)';
  const message = [
    `[GitHub] Review comment on #${pr.number} (${repoFullName}) by @${comment.user?.login} on ${location}:`,
    '',
    comment.body,
    '',
    `URL: ${comment.html_url}`,
  ].join('\n');
  await wakeConnectedProjectAgent(c, repoFullName, payload.installation?.id, { message, runId });
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if GitHub App is configured.
 */
export function isConfigured(): boolean {
  return !!(GITHUB_APP_ID && GITHUB_APP_PRIVATE_KEY);
}

/**
 * Get the GitHub App installation URL for a user to install the app.
 */
export function getInstallationUrl(): string {
  const appSlug = process.env.GH_APP_SLUG || 'shogo-ai';
  return `https://github.com/apps/${appSlug}/installations/new`;
}

/**
 * Get OAuth authorization URL for linking GitHub account.
 */
export function getOAuthUrl(state: string, redirectUri: string): string {
  const clientId = process.env.GH_APP_CLIENT_ID;
  if (!clientId) {
    throw new Error('GitHub App client ID not configured');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: 'user:email',
  });

  return `https://github.com/login/oauth/authorize?${params}`;
}

/**
 * Exchange OAuth code for access token.
 */
export async function exchangeOAuthCode(code: string): Promise<{
  access_token: string;
  token_type: string;
  scope: string;
}> {
  const clientId = process.env.GH_APP_CLIENT_ID;
  const clientSecret = process.env.GH_APP_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('GitHub App OAuth credentials not configured');
  }

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  if (!response.ok) {
    throw new Error('Failed to exchange OAuth code');
  }

  return response.json();
}

/**
 * Get GitHub user info from OAuth token.
 */
export async function getOAuthUser(accessToken: string): Promise<{
  id: number;
  login: string;
  name: string;
  email: string;
  avatar_url: string;
}> {
  const response = await fetch(`${GITHUB_API_URL}/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!response.ok) {
    throw new Error('Failed to get user info');
  }

  return response.json();
}
