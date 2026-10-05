// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GitHub Service - GitHub authentication and repository operations
 *
 * Handles GitHub authentication, repository management, and sync operations
 * between Shogo projects and GitHub repositories.
 *
 * A project connection authenticates one of two ways (see github-auth.ts):
 *  - GitHub App: user installs the Shogo GitHub App, the API mints
 *    short-lived installation tokens, PRs/comments are the App bot.
 *  - Access token: user supplies a personal access token (or OAuth token),
 *    stored encrypted; everything acts as that GitHub user. Needs no App,
 *    but App-only features (installation webhooks, bot attribution) are off.
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
import { encryptSecret } from '../lib/secret-crypto';
import { encodeProjectSettingsForWrite, parseProjectSettings } from '../lib/project-settings';
import { resolveConnectionAuth, type GitHubConnectionAuthFields } from './github-auth';
import {
  localGitHubWorkspace,
  type GitHubWorkspace,
  type GitHubWorkspaceOpResult,
} from './github-workspace';

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

/** Credentials for one GitHub API call: an App installation or a user token. */
export type GitHubAuth = { installationId: number } | { token: string };

export interface CreatePullRequestOptions {
  installationId?: number;
  /** User access token; used instead of `installationId` for token connections. */
  token?: string;
  repoOwner: string;
  repoName: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}

export interface CreatedPullRequest {
  number: number;
  url: string;
  html_url: string;
  node_id?: string;
}

export interface ConnectRepoOptions {
  projectId: string;
  /** The project's files: its runtime, or a directory on this machine. */
  workspace: GitHubWorkspace | string;
  /** Exactly one of `installationId` (GitHub App) or `token` (user access token). */
  installationId?: number;
  token?: string;
  repoOwner: string;
  repoName: string;
  /** Existing branch to check out instead of the repository's default branch. */
  branch?: string;
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
  return (await mintInstallationAccessToken(installationId)).token;
}

function toAuth(auth: number | GitHubAuth): GitHubAuth {
  return typeof auth === 'number' ? { installationId: auth } : auth;
}

function authFromOptions(options: { installationId?: number; token?: string }): GitHubAuth {
  if (options.token) return { token: options.token };
  if (typeof options.installationId === 'number') return { installationId: options.installationId };
  throw new Error('A GitHub App installationId or an access token is required');
}

async function accessTokenFor(auth: number | GitHubAuth): Promise<string> {
  const resolved = toAuth(auth);
  return 'token' in resolved ? resolved.token : getInstallationToken(resolved.installationId);
}

/** Credentials for a stored connection row, or null when it has none. */
export function connectionAuth(connection: GitHubConnectionAuthFields | null | undefined): GitHubAuth | null {
  const resolved = resolveConnectionAuth(connection);
  if (!resolved) return null;
  return resolved.kind === 'token' ? { token: resolved.token } : { installationId: resolved.installationId };
}

export interface GitHubTokenUser {
  id: number;
  login: string;
  name: string | null;
}

/** The GitHub user a personal access / OAuth token belongs to. */
export async function getTokenUser(token: string): Promise<GitHubTokenUser> {
  const response = await fetch(`${GITHUB_API_URL}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    const error = await response.text();
    let reason = error.trim();
    try {
      reason = JSON.parse(error)?.message || reason;
    } catch {}
    throw new Error(`GitHub rejected the access token: ${reason} (HTTP ${response.status})`);
  }
  const user = await response.json();
  if (typeof user?.id !== 'number' || typeof user?.login !== 'string') {
    throw new Error('GitHub user response did not contain an id and login');
  }
  return { id: user.id, login: user.login, name: typeof user.name === 'string' && user.name ? user.name : null };
}

/**
 * Installation tokens expire after one hour. Callers that cache the token
 * (the agent shell's `GH_TOKEN`) need `expiresAt` so they refresh before
 * GitHub rejects it.
 */
async function mintInstallationAccessToken(
  installationId: number,
): Promise<{ token: string; expiresAt: string }> {
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
  if (typeof data?.token !== 'string' || !data.token) {
    throw new Error('GitHub installation token response did not contain a token');
  }
  const expiresAt = typeof data.expires_at === 'string' && data.expires_at
    ? data.expires_at
    : new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return { token: data.token, expiresAt };
}

/**
 * GitHub links a commit to an App bot when the author email is
 * `{userId}+{login}@users.noreply.github.com` (the same form Actions uses
 * for `github-actions[bot]`).
 */
export function githubBotCommitEmail(userId: number, login: string): string {
  return `${userId}+${login}@users.noreply.github.com`;
}

const botIdentityCache = new Map<string, { email: string }>();

export function clearGitHubBotIdentityCache(): void {
  botIdentityCache.clear();
}

async function resolveBotIdentity(token: string): Promise<{ login: string; name: string; email: string }> {
  const login = botLogin();
  const cached = botIdentityCache.get(login);
  if (cached) return { login, name: login, email: cached.email };

  const response = await fetch(`${GITHUB_API_URL}/users/${encodeURIComponent(login)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to resolve GitHub App bot user: ${error}`);
  }
  const user = await response.json();
  if (typeof user?.id !== 'number') {
    throw new Error('GitHub App bot user response did not contain an id');
  }
  const email = githubBotCommitEmail(user.id, login);
  botIdentityCache.set(login, { email });
  return { login, name: login, email };
}

export interface GitHubCliCredentials {
  token: string;
  expiresAt: string;
  login: string;
  name: string;
  email: string;
}

/**
 * How long the runtime may cache a user access token before re-asking. The
 * token itself doesn't expire on this schedule; re-asking is how a rotated
 * token or a disconnect reaches a running shell.
 */
const USER_TOKEN_CACHE_MS = 50 * 60 * 1000;

/**
 * Credentials so the project runtime can run `gh` and `git commit`. With a
 * GitHub App connection they are a short-lived installation token acting as
 * the App bot (the same identity that opens pull requests); with a token
 * connection they are the user's token acting as that GitHub user.
 * Returns null when the project has no GitHub connection.
 */
export async function getProjectGitHubCliCredentials(
  projectId: string,
): Promise<GitHubCliCredentials | null> {
  const auth = resolveConnectionAuth(await getConnection(projectId));
  if (!auth) return null;
  if (auth.kind === 'token') {
    const user = await getTokenUser(auth.token);
    return {
      token: auth.token,
      expiresAt: new Date(Date.now() + USER_TOKEN_CACHE_MS).toISOString(),
      login: user.login,
      name: user.name ?? user.login,
      email: githubBotCommitEmail(user.id, user.login),
    };
  }
  const minted = await mintInstallationAccessToken(auth.installationId);
  const identity = await resolveBotIdentity(minted.token);
  return { token: minted.token, expiresAt: minted.expiresAt, ...identity };
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
  auth: number | GitHubAuth,
  owner: string,
  repo: string
): Promise<GitHubRepository> {
  const token = await accessTokenFor(auth);

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

/**
 * Create a pull request as the GitHub App installation, or as the user when
 * `options.token` is given.
 *
 * GitHub attributes resources created with an installation token to the
 * App's bot account (for example, `shogo-ai[bot]`), which is the same
 * attribution users see for Cursor cloud-agent PRs.
 */
export async function createPullRequest(
  options: CreatePullRequestOptions,
): Promise<CreatedPullRequest> {
  const token = await accessTokenFor(authFromOptions(options));
  const response = await fetch(
    `${GITHUB_API_URL}/repos/${encodeURIComponent(options.repoOwner)}/${encodeURIComponent(options.repoName)}/pulls`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: options.title,
        head: options.head,
        base: options.base,
        body: options.body,
        draft: options.draft ?? false,
      }),
    },
  );

  const body = await response.json().catch(() => null) as Partial<CreatedPullRequest> & { message?: string };
  if (!response.ok) {
    throw new Error(`Failed to create pull request: ${body?.message || JSON.stringify(body)}`);
  }
  if (
    typeof body.number !== 'number' ||
    typeof body.html_url !== 'string' ||
    typeof body.url !== 'string'
  ) {
    throw new Error('GitHub pull request response did not contain a number or URL');
  }
  return body as CreatedPullRequest;
}

export interface MergedPullRequest {
  merged: boolean;
  sha?: string;
  message?: string;
}

/** Merge a pull request with the GitHub App installation token, or the user's `token`. */
export async function mergePullRequest(options: {
  installationId?: number;
  token?: string;
  repoOwner: string;
  repoName: string;
  number: number;
  method?: 'merge' | 'squash' | 'rebase';
  commitTitle?: string;
}): Promise<MergedPullRequest> {
  const token = await accessTokenFor(authFromOptions(options));
  const response = await fetch(
    `${GITHUB_API_URL}/repos/${encodeURIComponent(options.repoOwner)}/${encodeURIComponent(options.repoName)}/pulls/${options.number}/merge`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        merge_method: options.method ?? 'squash',
        ...(options.commitTitle ? { commit_title: options.commitTitle } : {}),
      }),
    },
  );
  const body = await response.json().catch(() => null) as Partial<MergedPullRequest> | null;
  if (!response.ok || body?.merged === false) {
    throw new Error(`Failed to merge pull request: ${body?.message || `HTTP ${response.status}`}`);
  }
  return { merged: true, sha: body?.sha, message: body?.message };
}

// =============================================================================
// Project Connection
// =============================================================================

function toWorkspace(workspace: GitHubWorkspace | string): GitHubWorkspace {
  return typeof workspace === 'string' ? localGitHubWorkspace(workspace) : workspace;
}

/**
 * Connect a project to a GitHub repository: validate the credentials, save
 * the GitHubConnection, then point the project's workspace at the repo.
 *
 * The connection is saved before the workspace step because the runtime
 * reads its credentials from it. A workspace failure (runtime unreachable,
 * diverged history) does not undo the connection; it is returned as
 * `workspace` and recorded in `lastSyncError`, and the next push/pull or a
 * reconnect retries it.
 */
export async function connectRepository(options: ConnectRepoOptions): Promise<{
  connection: any;
  repo: GitHubRepository;
  workspace: GitHubWorkspaceOpResult;
}> {
  const { projectId, installationId, token: userToken, repoOwner, repoName } = options;
  if (!!userToken === (typeof installationId === 'number')) {
    throw new Error('Connect with exactly one of a GitHub App installation or an access token');
  }
  const branch = options.branch?.trim() || undefined;
  if (branch && !isValidBranchName(branch)) throw new Error(`Invalid branch name: ${branch}`);

  // Validate the token before storing it: it must belong to a user and see the repo.
  const tokenUser = userToken ? await getTokenUser(userToken) : null;
  const auth = authFromOptions({ installationId, token: userToken });
  const repo = await getRepository(auth, repoOwner, repoName);
  // Fails closed when SECRETS_ENCRYPTION_KEY is missing, before anything is written.
  const encryptedToken = userToken ? encryptSecret(userToken) : null;

  // Switching auth kinds clears the other kind's credentials.
  const authFields = userToken
    ? { authType: 'token' as const, installationId: null, encryptedToken, tokenLogin: tokenUser!.login }
    : { authType: 'app' as const, installationId: installationId!, encryptedToken: null, tokenLogin: null };

  // Create or update GitHubConnection record
  const connection = await prisma.gitHubConnection.upsert({
    where: { projectId },
    create: {
      projectId,
      repoOwner,
      repoName,
      repoFullName: repo.full_name,
      defaultBranch: repo.default_branch,
      ...authFields,
      repoId: repo.id,
      isPrivate: repo.private,
      syncEnabled: true,
    },
    update: {
      repoOwner,
      repoName,
      repoFullName: repo.full_name,
      defaultBranch: repo.default_branch,
      ...authFields,
      repoId: repo.id,
      isPrivate: repo.private,
      syncEnabled: true,
      lastSyncError: null,
    },
  });

  // When the repo already has content on its default branch it is
  // authoritative: the workspace switches onto it (a template scaffold with
  // unrelated history is kept on a backup branch). Otherwise every later
  // `git pull --rebase` fails with "refusing to merge unrelated histories".
  const workspace = await toWorkspace(options.workspace).run({
    op: 'connect',
    repoOwner,
    repoName,
    defaultBranch: repo.default_branch,
    ...(branch ? { branch } : {}),
    token: await accessTokenFor(auth),
  });
  const workspaceError = !workspace.ok ? workspace.error : workspace.connect === 'diverged' ? workspace.error : undefined;
  if (workspaceError) {
    console.warn(`[GitHub] Connected ${repo.full_name} but the workspace was not updated: ${workspaceError}`);
    await prisma.gitHubConnection.update({
      where: { projectId },
      data: { lastSyncError: workspaceError },
    });
  } else if (workspace.ok) {
    const workingBranch = workspace.branch && workspace.branch !== repo.default_branch ? workspace.branch : null;
    if (workingBranch !== (connection.branch ?? null)) {
      await prisma.gitHubConnection.update({ where: { projectId }, data: { branch: workingBranch } });
      connection.branch = workingBranch;
    }
    await saveDetectedTechStack(projectId, workspace.techStackId);
  }

  return { connection, repo, workspace };
}

const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]{1,200}$/;

export function isValidBranchName(branch: string): boolean {
  return BRANCH_NAME_RE.test(branch) && !branch.startsWith('-') && !branch.includes('..') && !branch.endsWith('/');
}

/** Keep the project's settings on the stack the runtime detected from its files. */
async function saveDetectedTechStack(projectId: string, techStackId: string | undefined): Promise<void> {
  if (!techStackId) return;
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { settings: true } });
  if (!project) return;
  const settings = parseProjectSettings(project.settings) ?? {};
  if (settings.techStackId === techStackId) return;
  const { dockerClassBlockedMessage } = await import('../lib/runtime-class-setting');
  const dockerBlocked = dockerClassBlockedMessage(techStackId);
  if (dockerBlocked) {
    console.warn(`[github] not switching project ${projectId} to ${techStackId}: ${dockerBlocked}`);
    return;
  }
  await prisma.project.update({
    where: { id: projectId },
    data: { settings: encodeProjectSettingsForWrite({ ...settings, techStackId }) as any },
  });
}

export class GitHubNotConnectedError extends Error {
  constructor(message = 'Project is not connected to GitHub') {
    super(message);
    this.name = 'GitHubNotConnectedError';
  }
}

/**
 * Switch a connected project's workspace to another existing branch of its
 * repository. Uncommitted work is committed on the current branch first.
 */
export async function switchBranch(
  projectId: string,
  branch: string,
  workspace: GitHubWorkspace | string,
): Promise<{ repoFullName: string; branch: string; techStackId?: string }> {
  const target = branch.trim();
  if (!isValidBranchName(target)) throw new Error(`Invalid branch name: ${branch}`);
  const connection = await getConnection(projectId);
  if (!connection) throw new GitHubNotConnectedError();

  const result = await toWorkspace(workspace).run({
    op: 'checkout',
    repoOwner: connection.repoOwner,
    repoName: connection.repoName,
    defaultBranch: connection.defaultBranch,
    branch: target,
    token: await operationToken(connection),
  });
  if (!result.ok) throw new Error(result.error || `Could not switch to ${target}`);

  const current = result.branch || target;
  await prisma.gitHubConnection.update({
    where: { projectId },
    data: { branch: current === connection.defaultBranch ? null : current, lastSyncError: null },
  });
  await saveDetectedTechStack(projectId, result.techStackId);
  return { repoFullName: connection.repoFullName, branch: current, techStackId: result.techStackId };
}

/** Branch names of a connected project's repository (first 1,000). */
export async function listBranches(projectId: string): Promise<string[]> {
  const connection = await getConnection(projectId);
  if (!connection) throw new GitHubNotConnectedError();
  const token = await operationToken(connection);
  const names: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const response = await fetch(
      `${GITHUB_API_URL}/repos/${encodeURIComponent(connection.repoOwner)}/${encodeURIComponent(connection.repoName)}/branches?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    if (!response.ok) throw new Error(`Failed to list branches: HTTP ${response.status}`);
    const batch = (await response.json()) as Array<{ name: string }>;
    names.push(...batch.map((b) => b.name));
    if (batch.length < 100) break;
  }
  return names;
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
 * A fresh credential for one workspace operation. Installation tokens expire
 * after an hour, so one is minted per operation.
 */
async function operationToken(connection: GitHubConnectionAuthFields): Promise<string> {
  const auth = connectionAuth(connection);
  if (!auth) throw new Error('GitHub connection has no usable credentials; reconnect the repository');
  return accessTokenFor(auth);
}

/** The workspace may have changed branch outside Shogo (e.g. `git checkout` in a shell). */
function workingBranchUpdate(
  connection: { defaultBranch: string },
  branch: string | undefined,
): { branch?: string | null } {
  if (!branch) return {};
  return { branch: branch === connection.defaultBranch ? null : branch };
}

/**
 * Push the workspace's current branch to GitHub.
 */
export async function pushToGitHub(
  projectId: string,
  workspace: GitHubWorkspace | string
): Promise<SyncResult> {
  const connection = await getConnection(projectId);
  if (!connection) {
    return { success: false, pushed: false, pulled: false, commits: 0, error: 'No GitHub connection' };
  }

  if (!connection.syncEnabled) {
    return { success: false, pushed: false, pulled: false, commits: 0, error: 'Sync is disabled' };
  }

  try {
    const result = await toWorkspace(workspace).run({
      op: 'push',
      repoOwner: connection.repoOwner,
      repoName: connection.repoName,
      token: await operationToken(connection),
    });

    if (!result.ok) {
      await prisma.gitHubConnection.update({
        where: { projectId },
        data: { lastSyncError: result.error },
      });
      return { success: false, pushed: false, pulled: false, commits: 0, error: result.error };
    }

    // Update last push time
    await prisma.gitHubConnection.update({
      where: { projectId },
      data: { lastPushAt: new Date(), lastSyncError: null, ...workingBranchUpdate(connection, result.branch) },
    });

    return { success: true, pushed: true, pulled: false, commits: result.commits ?? 0 };
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
  workspace: GitHubWorkspace | string
): Promise<SyncResult> {
  const connection = await getConnection(projectId);
  if (!connection) {
    return { success: false, pushed: false, pulled: false, commits: 0, error: 'No GitHub connection' };
  }

  try {
    const result = await toWorkspace(workspace).run({
      op: 'pull',
      repoOwner: connection.repoOwner,
      repoName: connection.repoName,
      defaultBranch: connection.defaultBranch,
      token: await operationToken(connection),
    });

    if (!result.ok) {
      await prisma.gitHubConnection.update({
        where: { projectId },
        data: { lastSyncError: result.error },
      });
      return { success: false, pushed: false, pulled: false, commits: 0, error: result.error };
    }

    // Update last pull time
    await prisma.gitHubConnection.update({
      where: { projectId },
      data: { lastPullAt: new Date(), lastSyncError: null, ...workingBranchUpdate(connection, result.branch) },
    });

    return { success: true, pushed: false, pulled: true, commits: result.commits ?? 0 };
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
  workspace: GitHubWorkspace | string
): Promise<SyncResult> {
  // Pull first
  const pullResult = await pullFromGitHub(projectId, workspace);
  if (!pullResult.success && pullResult.error !== 'No upstream branch') {
    return pullResult;
  }

  // Then push
  const pushResult = await pushToGitHub(projectId, workspace);
  
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
  const providedSignature = Buffer.from(signature);
  const expectedSignature = Buffer.from(digest);

  if (providedSignature.length !== expectedSignature.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedSignature, expectedSignature);
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
 * `runIdMarker(runId)` to the body (the agent's `github_create_pr` tool does
 * this automatically).
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
 * A requester ticket for the person who sent a webhook, when their GitHub
 * account is linked to exactly one member of the project's workspace. The
 * webhook is signed by GitHub, so `sender.id` is GitHub's word, not the
 * payload author's. Bots and unlinked senders get none, and the project's
 * credential chain falls through to its shared account.
 */
async function webhookSenderTicket(
  c: Context,
  project: { id: string; workspaceId: string },
  sender: { id?: number | string; type?: string } | null | undefined,
): Promise<string | undefined> {
  if (sender?.id === undefined || sender.id === null || sender.type === 'Bot') return undefined;
  try {
    const { resolveEventPerson, eventRequesterTicket } = await import('./event-identity');
    const person = await resolveEventPerson({
      workspaceId: project.workspaceId,
      actsAs: 'actor',
      actor: { source: 'github', externalId: String(sender.id), trust: 'platform' },
    });
    const deliveryId = c.req.header('x-github-delivery') || `github:${Date.now()}`;
    return eventRequesterTicket(project.id, person, { id: deliveryId, source: 'github' });
  } catch (err: any) {
    console.warn('[GitHub] Could not match the webhook sender:', err?.message ?? err);
    return undefined;
  }
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
  opts: { message: string; runId?: string; sender?: { id?: number | string; type?: string } | null },
): Promise<void> {
  try {
    const connection = await findConnectionByRepo(repoFullName, installationId);
    if (!connection) {
      console.log(`[GitHub] No project connected to ${repoFullName}; ignoring task-source webhook event`);
      return;
    }
    const requesterTicket = await webhookSenderTicket(c, connection.project, opts.sender);
    const { callProjectAgent } = await import('./agent-call.service');
    const outcome = await callProjectAgent(c, connection.project.id, connection.project.workspaceId, {
      message: opts.message,
      runId: opts.runId,
      wait: false,
      ...(requesterTicket ? { requesterTicket } : {}),
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
 *
 * Every "new issue opened" event is assigned a deterministic `runId`
 * (`run-issue-<number>`) up front, rather than leaving intake to mint one.
 * Without this, every new-issue event shares intake's single default
 * session (no `runId` means `callProjectAgent`'s default session key never
 * changes), so the full history of every prior issue — including intake's
 * own past tool calls that happened to embed a runId string for a *different*
 * issue — stays in context. On a test fixture that reopens byte-identical
 * bug reports (same title/body every time), the model reliably regurgitates
 * the previous issue's `runId` marker instead of minting a fresh one for the
 * current issue number (found live running the L1 multi-project eval — every
 * new issue after the first got the wrong, stale runId). Assigning the
 * runId here routes each issue to its own isolated `run:<runId>` session
 * (see `agent-call.service.ts`), so a new issue never sees another issue's
 * turn history.
 */
export async function handleIssueWebhook(c: Context, payload: any): Promise<void> {
  if (payload?.action !== 'opened') return;
  const repoFullName = payload.repository?.full_name;
  const issue = payload.issue;
  if (!repoFullName || !issue) return;
  const runId = `run-issue-${issue.number}`;
  const message = [
    `[GitHub] New issue #${issue.number} opened in ${repoFullName}: "${issue.title}"`,
    '',
    issue.body || '(no description)',
    '',
    `URL: ${issue.html_url}`,
    '',
    `(This is a brand-new item — its runId is "${runId}"; use exactly that string, do not reuse or invent a different one.)`,
  ].join('\n');
  await wakeConnectedProjectAgent(c, repoFullName, payload.installation?.id, { message, runId, sender: payload.sender });
}

/**
 * `issue_comment` webhook — fires for comments on both issues and PRs
 * (GitHub represents a PR as an `issue` with a `pull_request` stub). Wakes
 * the agent when the comment mentions the bot, the thread itself was
 * opened by the bot, or — the common human-in-the-loop case — this
 * issue/PR already carries a tracked `runId` (the pipeline embeds
 * `runIdMarker(runId)` in the body once it starts tracking a run; see
 * `extractRunId`/`task-source-github-issues/SKILL.md`). That last check is
 * the one that actually matters in practice: a human reporter, not the
 * bot, opens the issue, so `botAuthoredThread` alone almost never fires,
 * and a plain "Go with option 2." reply never @-mentions anyone — without
 * the runId check this handler silently drops every human pick/approval
 * reply, permanently stalling the run at `awaiting_pick` with no error
 * anywhere (found live running the L1 multi-project eval).
 */
export async function handleIssueCommentWebhook(c: Context, payload: any): Promise<void> {
  if (payload?.action !== 'created') return;
  const repoFullName = payload.repository?.full_name;
  const comment = payload.comment;
  const issue = payload.issue;
  if (!repoFullName || !comment || !issue) return;
  if (isBotLogin(comment.user?.login)) return; // never react to our own comments

  const isPR = !!issue.pull_request;
  const runId = extractRunId(issue.body) ?? extractRunId(comment.body);
  const botAuthoredThread = isBotLogin(issue.user?.login);
  if (!mentionsBot(comment.body) && !botAuthoredThread && !runId) return;

  const message = [
    `[GitHub] New comment on ${isPR ? 'PR' : 'issue'} #${issue.number} (${repoFullName}) by @${comment.user?.login}:`,
    '',
    comment.body,
    '',
    `URL: ${comment.html_url}`,
  ].join('\n');
  await wakeConnectedProjectAgent(c, repoFullName, payload.installation?.id, { message, runId, sender: payload.sender });
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

  // Same runId fallback as handleIssueCommentWebhook, for setups where the
  // PR-opening identity doesn't literally match `botLogin()` (e.g. `gh`
  // authenticated as a personal account rather than the GitHub App's own
  // installation token, as in local/eval runs) — `botAuthored` alone would
  // otherwise never fire and a plain "LGTM" review would be dropped.
  const runId = extractRunId(pr.body);
  const botAuthored = isBotLogin(pr.user?.login);
  if (!mentionsBot(review.body) && !botAuthored && !runId) return;

  const message = [
    `[GitHub] PR review "${review.state}" on #${pr.number} (${repoFullName}) by @${review.user?.login}:`,
    '',
    review.body || '(no comment)',
    '',
    `URL: ${review.html_url}`,
  ].join('\n');
  await wakeConnectedProjectAgent(c, repoFullName, payload.installation?.id, { message, runId, sender: payload.sender });
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

  const runId = extractRunId(pr.body);
  const botAuthored = isBotLogin(pr.user?.login);
  if (!mentionsBot(comment.body) && !botAuthored && !runId) return;
  const location = comment.path ? `${comment.path}${comment.line ? ':' + comment.line : ''}` : '(unknown location)';
  const message = [
    `[GitHub] Review comment on #${pr.number} (${repoFullName}) by @${comment.user?.login} on ${location}:`,
    '',
    comment.body,
    '',
    `URL: ${comment.html_url}`,
  ].join('\n');
  await wakeConnectedProjectAgent(c, repoFullName, payload.installation?.id, { message, runId, sender: payload.sender });
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
export function getInstallationUrl(state?: string): string {
  const appSlug = process.env.GH_APP_SLUG || 'shogo-ai';
  const base = `https://github.com/apps/${appSlug}/installations/new`;
  return state ? `${base}?${new URLSearchParams({ state })}` : base;
}

/** True when the App can run the user-authorization leg of the connect flow. */
export function isOAuthConfigured(): boolean {
  return isConfigured() && !!process.env.GH_APP_CLIENT_ID && !!process.env.GH_APP_CLIENT_SECRET;
}

/**
 * Where GitHub returns the user after installing/configuring the App and
 * after OAuth. Register it as both the App's Setup URL (with "Redirect on
 * update") and its Callback URL.
 */
function publicApiBaseUrl(): string {
  return (process.env.SHOGO_PUBLIC_API_URL || process.env.BETTER_AUTH_URL || 'http://localhost:8002').replace(/\/+$/, '');
}

export function getAuthorizeCallbackUrl(): string {
  return `${publicApiBaseUrl()}/api/github/callback`;
}

/**
 * Short Shogo link that starts the App authorization for a repo. Opening it
 * with a Shogo session mints the signed state and redirects to GitHub, so an
 * agent relaying the link never has to copy an opaque token.
 */
export function getAuthorizeLinkUrl(projectId: string, repoOwner: string, repoName: string): string {
  return `${publicApiBaseUrl()}/api/projects/${encodeURIComponent(projectId)}/github/authorize?repo=${encodeURIComponent(`${repoOwner}/${repoName}`)}`;
}

/** Installation ids the user behind a user-to-server OAuth token can access. */
export async function listUserInstallationIds(userToken: string): Promise<number[]> {
  const response = await fetch(`${GITHUB_API_URL}/user/installations?per_page=100`, {
    headers: {
      Authorization: `Bearer ${userToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to list GitHub App installations for the user: HTTP ${response.status}`);
  }
  const data = await response.json();
  return Array.isArray(data?.installations)
    ? data.installations.map((i: any) => i?.id).filter((id: unknown): id is number => typeof id === 'number')
    : [];
}

/**
 * The installation (among those the user can access) that can see
 * `owner/repo`, trying `preferredId` first. Null when none can.
 */
export async function findUserInstallationForRepo(
  userToken: string,
  repoOwner: string,
  repoName: string,
  preferredId?: number,
): Promise<number | null> {
  const ids = await listUserInstallationIds(userToken);
  const ordered = preferredId && ids.includes(preferredId) ? [preferredId, ...ids.filter((id) => id !== preferredId)] : ids;
  for (const installationId of ordered) {
    try {
      await getRepository(installationId, repoOwner, repoName);
      return installationId;
    } catch {
      // This installation can't see the repo; try the next.
    }
  }
  return null;
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
