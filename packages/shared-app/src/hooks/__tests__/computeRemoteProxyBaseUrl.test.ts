// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pin the decision matrix that gates Studio's stateful-data tunneling
 * on `instance.kind`.
 *
 * The bug `computeRemoteProxyBaseUrl` exists to prevent: passing a
 * cli-worker's `remoteAgentBaseUrl` into `SDKDomainProvider`'s
 * `remoteProxyBaseUrl` ships every `/api/projects` request through the
 * tunnel, where the worker's `WorkerRuntimeManager.resolveLocalUrl`
 * returns null for non-`/agent/*` paths and the tunnel replies 502
 * with `code: "CLI_WORKER_HAS_NO_DATA_API"`. Studio's sidebar then
 * blanks out and the user can't navigate.
 *
 * These tests guarantee the matrix in the doc-comment of
 * `computeRemoteProxyBaseUrl` matches actual behaviour, so any future
 * refactor that breaks the cli-worker path also breaks a test.
 */
import { describe, expect, it } from 'vitest'
import {
  computeRemoteProxyBaseUrl,
  type ActiveInstance,
} from '../useActiveInstance'

const baseUrl = 'https://studio.shogo.ai/api/instances/inst-1/p'

function inst(kind: ActiveInstance['kind']): ActiveInstance {
  return {
    instanceId: 'inst-1',
    name: 'My machine',
    hostname: 'my-machine',
    workspaceId: 'ws-1',
    kind,
  }
}

describe('computeRemoteProxyBaseUrl', () => {
  it('returns null when no instance is selected', () => {
    expect(computeRemoteProxyBaseUrl(null, baseUrl)).toBeNull()
    expect(computeRemoteProxyBaseUrl(undefined, baseUrl)).toBeNull()
  })

  it('returns null when remoteAgentBaseUrl is null even with a desktop instance', () => {
    expect(computeRemoteProxyBaseUrl(inst('desktop'), null)).toBeNull()
  })

  it('returns the remoteAgentBaseUrl when instance.kind === "desktop"', () => {
    expect(computeRemoteProxyBaseUrl(inst('desktop'), baseUrl)).toBe(baseUrl)
  })

  it('returns null when instance.kind === "cli-worker" (the patch C fix)', () => {
    // This is the regression we're guarding: routing /api/projects
    // through a cli-worker tunnel hits CLI_WORKER_HAS_NO_DATA_API.
    expect(computeRemoteProxyBaseUrl(inst('cli-worker'), baseUrl)).toBeNull()
  })

  it('returns null when instance.kind is undefined (older clients persisted without `kind`)', () => {
    // Safe-default: cloud is always a valid backend, the desktop
    // tunnel is the optimisation. Better to read fresh data from
    // cloud than to brick the sidebar with 502s while waiting for
    // the validation poll to hydrate `kind`.
    expect(computeRemoteProxyBaseUrl(inst(undefined), baseUrl)).toBeNull()
  })

  it('tunnels a machine workspace even though it is not a cloud workspace (SHO-54)', () => {
    // A "This Mac" row is one of the desktop's own workspaces. Its data is
    // the desktop's, so every stateful read has to go through the machine
    // relay — never to the cloud, which has never heard of that workspace.
    const machineBase = 'https://studio.shogo.ai/api/machines/inst-1/w/lw-1'
    const machine: ActiveInstance = {
      ...inst('desktop'),
      source: 'machine',
      localWorkspaceId: 'lw-1',
    }
    expect(computeRemoteProxyBaseUrl(machine, machineBase)).toBe(machineBase)
  })

  it('refuses a cli-worker even when it arrived as a machine (SHO-120)', () => {
    // The machine branch used to return before the cli-worker guard, so a
    // `shogo worker` VM offered as a machine shipped every stateful call to a
    // tunnel that can only answer 502 CLI_WORKER_HAS_NO_DATA_API.
    const machineBase = 'https://studio.shogo.ai/api/machines/inst-1/w/lw-1'
    const worker: ActiveInstance = {
      ...inst('cli-worker'),
      source: 'machine',
      localWorkspaceId: 'lw-1',
    }
    expect(computeRemoteProxyBaseUrl(worker, machineBase)).toBeNull()
    // Its agent turn keeps its own base (`/api/instances/:id/p`), untouched.
    expect(computeRemoteProxyBaseUrl(worker, baseUrl)).toBeNull()
  })
})
