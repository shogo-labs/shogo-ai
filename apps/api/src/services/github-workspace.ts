// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Where GitHub remote operations on a project's files run.
 *
 * The project's files live in its runtime (a metal VM, a pod, or the desktop
 * runtime process); the API has no authoritative copy, so connect/push/pull
 * are forwarded to the runtime's `POST /agent/github/git`.
 * `localGitHubWorkspace` operates on a directory on this machine and is kept
 * for callers that already hold one.
 */

import * as gitService from './git.service';
import { githubGitAuthEnv, githubRemoteUrl } from './github-auth';

export type GitHubWorkspaceOp = 'connect' | 'push' | 'pull';

export interface GitHubWorkspaceOpInput {
  op: GitHubWorkspaceOp;
  repoOwner: string;
  repoName: string;
  defaultBranch?: string;
  token: string;
}

export interface GitHubWorkspaceOpResult {
  ok: boolean;
  error?: string;
  branch?: string;
  sha?: string | null;
  connect?: 'adopted' | 'kept' | 'diverged';
  backupBranch?: string;
  commits?: number;
}

export interface GitHubWorkspace {
  run(input: GitHubWorkspaceOpInput): Promise<GitHubWorkspaceOpResult>;
}

const RUNTIME_GIT_TIMEOUT_MS = 6 * 60 * 1000;

/** Operate on a workspace directory on this machine. */
export function localGitHubWorkspace(workspacePath: string): GitHubWorkspace {
  return {
    async run(input) {
      try {
        const env = githubGitAuthEnv(input.token);
        await gitService.initRepo(workspacePath);
        await gitService.addRemote(workspacePath, 'origin', githubRemoteUrl(input.repoOwner, input.repoName));

        if (input.op === 'connect') {
          const branch = input.defaultBranch || 'main';
          const fetched = await gitService.fetch(workspacePath, { remote: 'origin', env });
          if (!fetched.success) return { ok: false, error: fetched.error };
          if (!gitService.remoteBranchExists(workspacePath, 'origin', branch)) {
            return { ok: true, connect: 'kept' };
          }
          const reset = await gitService.resetHardToRemote(workspacePath, 'origin', branch);
          if (!reset.success) return { ok: false, error: reset.error };
          return { ok: true, connect: 'adopted', branch };
        }

        if (input.op === 'push') {
          const branch = await gitService.getCurrentBranch(workspacePath);
          const pushed = await gitService.push(workspacePath, { remote: 'origin', branch, setUpstream: true, env });
          return pushed.success ? { ok: true, branch } : { ok: false, error: pushed.error };
        }

        await gitService.fetch(workspacePath, { env });
        const pulled = await gitService.pull(workspacePath, {
          remote: 'origin',
          branch: input.defaultBranch,
          rebase: true,
          env,
        });
        return pulled.success ? { ok: true, branch: input.defaultBranch } : { ok: false, error: pulled.error };
      } catch (err: any) {
        const label = { connect: 'Connect', push: 'Push', pull: 'Pull' }[input.op];
        return { ok: false, error: err?.message || `${label} failed` };
      }
    },
  };
}

/** Forward to the runtime that owns the project's files. */
export function runtimeGitHubWorkspace(projectId: string): GitHubWorkspace {
  return {
    async run(input) {
      try {
        const { resolveProjectPodUrl } = await import('../lib/resolve-pod-url');
        const { deriveProjectRuntimeToken } = await import('../lib/project-runtime-token');
        const podUrl = (await resolveProjectPodUrl(projectId, { logTag: 'GitHubWorkspace' })).url;
        const response = await fetch(`${podUrl}/agent/github/git`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-runtime-token': await deriveProjectRuntimeToken(projectId),
          },
          body: JSON.stringify({ projectId, ...input }),
          signal: AbortSignal.timeout(RUNTIME_GIT_TIMEOUT_MS),
        });
        const body = (await response.json().catch(() => null)) as GitHubWorkspaceOpResult | null;
        if (!body || typeof body.ok !== 'boolean') {
          return { ok: false, error: `Project runtime returned HTTP ${response.status}` };
        }
        return body;
      } catch (err: any) {
        return { ok: false, error: `Could not reach the project runtime: ${err?.message ?? err}` };
      }
    },
  };
}