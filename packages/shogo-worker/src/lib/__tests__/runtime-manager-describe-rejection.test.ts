// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Coverage for `WorkerRuntimeManager.describeRejection` — the
 * structured-rejection hook that the {@link WorkerTunnel} reads when
 * `resolveLocalUrl` returns null.
 *
 * The tunnel echoes the returned `code` + `message` (plus the original
 * path) into the 502 body so a Studio client reading the response can
 * tell exactly what the worker refused to do. This file pins the wire
 * shape so a future refactor doesn't silently change the body Studio
 * relies on.
 */
import { describe, expect, it } from 'bun:test';
import { WorkerRuntimeManager } from '../runtime-manager.ts';

describe('WorkerRuntimeManager.describeRejection', () => {
  it('flags non-/agent paths with CLI_WORKER_HAS_NO_DATA_API and the original path', () => {
    const mgr = new WorkerRuntimeManager({});
    const r = mgr.describeRejection('/api/projects?workspaceId=abc', 'p-1');
    expect(r.code).toBe('CLI_WORKER_HAS_NO_DATA_API');
    // Path in the message must be the pathname only — `?workspaceId=abc`
    // is verbose and the tunnel echoes the full path separately.
    expect(r.message).toContain('/api/projects');
    expect(r.message).toContain('cli-worker only serves /agent/* paths');
  });

  it('flags /agent paths missing a project context with CLI_WORKER_NO_PROJECT_FOR_PATH', () => {
    const mgr = new WorkerRuntimeManager({});
    const r = mgr.describeRejection('/agent/chat', undefined);
    expect(r.code).toBe('CLI_WORKER_NO_PROJECT_FOR_PATH');
    expect(r.message).toContain('/agent/chat');
    expect(r.message).toContain('projectId=none');
  });

  it('preserves the projectId when one is provided but no runtime exists', () => {
    const mgr = new WorkerRuntimeManager({});
    const r = mgr.describeRejection('/agent/chat', 'proj-42');
    expect(r.code).toBe('CLI_WORKER_NO_PROJECT_FOR_PATH');
    expect(r.message).toContain('projectId=proj-42');
  });
});
