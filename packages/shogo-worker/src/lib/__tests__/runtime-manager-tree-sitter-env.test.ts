// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the belt-and-suspenders `TREE_SITTER_WASM_DIR` injection
 * added to `WorkerRuntimeManager.buildEnv` in PR #2 ("Bundle tree-
 * sitter WASMs alongside compiled agent-runtime binary").
 *
 * The contract we verify:
 *
 *   1. When the worker spawns an `agent-runtime` binary at
 *      `/path/to/shogo-agent-runtime`, the spawn env contains
 *      `TREE_SITTER_WASM_DIR=/path/to/tree-sitter-wasm`. Operators
 *      who run `env | grep TREE_SITTER` on a debugging session see
 *      exactly where the runtime is configured to look.
 *
 *   2. An operator-provided override on the worker host
 *      (`process.env.TREE_SITTER_WASM_DIR=/custom/path`) flows
 *      through to the spawned runtime — `buildEnv` does NOT clobber
 *      a pre-existing env value. The runtime's resolver also reads
 *      the env first, so the override stack-traces correctly.
 *
 *   3. When a per-project `extraEnv` block sets the same variable,
 *      the per-project value wins over both the inherited env and
 *      the binary-adjacent default. (extraEnv is documented as the
 *      last-merged layer; we keep that invariant.)
 *
 * `buildEnv` is a private method. We invoke it via a typed cast —
 * the same pattern other tests in this directory use for accessing
 * private internals (`runtime-manager-describe-rejection.test.ts`).
 * The signature of `buildEnv(slot, runtimeBinPath)` is exercised
 * directly with a synthesized `slot` rather than going through the
 * full spawn pipeline, because the spawn pipeline requires a real
 * binary on disk. The test surface is the env-shape contract, not
 * the spawn-orchestration logic (which is covered elsewhere).
 */

import { describe, expect, it } from 'bun:test';
import { dirname, join } from 'node:path';
import { WorkerRuntimeManager } from '../runtime-manager';

/**
 * Construct a fake `InternalRuntime` slot just rich enough for
 * `buildEnv` to read every field it touches. Mirrors the shape of
 * `InternalRuntime` in runtime-manager.ts; if that shape grows new
 * fields used by buildEnv, this fixture must follow.
 */
function fakeSlot(overrides: Record<string, unknown> = {}): unknown {
  return {
    projectId: 'proj-tree-sitter-env-test',
    agentPort: 41000,
    apiServerPort: 41100,
    spawnConfig: {
      cloudUrl: 'https://cloud.test',
      apiKey: 'api-key',
      ...((overrides.spawnConfig as Record<string, unknown>) ?? {}),
    },
    ...overrides,
  };
}

describe('WorkerRuntimeManager.buildEnv — TREE_SITTER_WASM_DIR injection', () => {
  it('exports TREE_SITTER_WASM_DIR=dirname(runtimeBinPath)/tree-sitter-wasm by default', () => {
    const mgr = new WorkerRuntimeManager({
      env: {} as NodeJS.ProcessEnv, // start from a clean env so we can isolate the injection
    }) as unknown as { buildEnv(slot: unknown, runtimeBinPath: string): NodeJS.ProcessEnv };

    const runtimeBinPath = '/opt/shogo/runtime/shogo-agent-runtime-linux-x64';
    const env = mgr.buildEnv(fakeSlot(), runtimeBinPath);

    expect(env.TREE_SITTER_WASM_DIR).toBe(join(dirname(runtimeBinPath), 'tree-sitter-wasm'));
    expect(env.TREE_SITTER_WASM_DIR).toBe('/opt/shogo/runtime/tree-sitter-wasm');
  });

  it('honors a worker-host override when process.env already sets TREE_SITTER_WASM_DIR', () => {
    const mgr = new WorkerRuntimeManager({
      env: {
        TREE_SITTER_WASM_DIR: '/operator/override/path',
      } as NodeJS.ProcessEnv,
    }) as unknown as { buildEnv(slot: unknown, runtimeBinPath: string): NodeJS.ProcessEnv };

    const env = mgr.buildEnv(fakeSlot(), '/opt/shogo/runtime/shogo-agent-runtime-linux-x64');
    expect(env.TREE_SITTER_WASM_DIR).toBe('/operator/override/path');
  });

  it('per-project extraEnv override beats both worker-host env and binary-adjacent default', () => {
    const mgr = new WorkerRuntimeManager({
      env: {
        TREE_SITTER_WASM_DIR: '/worker/host/path',
      } as NodeJS.ProcessEnv,
    }) as unknown as { buildEnv(slot: unknown, runtimeBinPath: string): NodeJS.ProcessEnv };

    const env = mgr.buildEnv(
      fakeSlot({
        spawnConfig: {
          cloudUrl: 'https://cloud.test',
          apiKey: 'api-key',
          extraEnv: { TREE_SITTER_WASM_DIR: '/per/project/override' },
        },
      }),
      '/opt/shogo/runtime/shogo-agent-runtime-linux-x64',
    );
    expect(env.TREE_SITTER_WASM_DIR).toBe('/per/project/override');
  });

  it('preserves the cli-worker contract: PROJECT_ID, PORT, SHOGO_API_KEY co-exist with TREE_SITTER_WASM_DIR', () => {
    // Drive-by: assert injecting the new variable doesn't clobber the
    // existing env keys. Reduces blast radius if a future refactor of
    // buildEnv reorders the assignments.
    const mgr = new WorkerRuntimeManager({
      env: {} as NodeJS.ProcessEnv,
    }) as unknown as { buildEnv(slot: unknown, runtimeBinPath: string): NodeJS.ProcessEnv };

    const env = mgr.buildEnv(
      fakeSlot({ projectId: 'co-exist-check', agentPort: 42424, apiServerPort: 42525 }),
      '/runtime/shogo-agent-runtime',
    );

    expect(env.PROJECT_ID).toBe('co-exist-check');
    expect(env.PORT).toBe('42424');
    expect(env.API_SERVER_PORT).toBe('42525');
    expect(env.SHOGO_API_KEY).toBe('api-key');
    expect(env.TREE_SITTER_WASM_DIR).toBe('/runtime/tree-sitter-wasm');
  });
});
