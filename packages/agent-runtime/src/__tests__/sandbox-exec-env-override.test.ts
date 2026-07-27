// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Verifies the SANDBOX_EXEC_ENABLED / KUBERNETES_SERVICE_HOST precedence
 * rules in `isSandboxRequested()`. In particular: an explicit
 * SANDBOX_EXEC_ENABLED='false' must always win over KUBERNETES_SERVICE_HOST
 * presence — this is what lets the super-admin `runtime.sandbox_exec_enabled`
 * override (apps/api/src/lib/sandbox-exec-setting.ts) force native exec even
 * when the runtime happens to be running inside Kubernetes.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { isSandboxRequested } from '../sandbox-exec'

describe('isSandboxRequested', () => {
  const saved = {
    SANDBOX_EXEC_ENABLED: process.env.SANDBOX_EXEC_ENABLED,
    KUBERNETES_SERVICE_HOST: process.env.KUBERNETES_SERVICE_HOST,
  }

  beforeEach(() => {
    delete process.env.SANDBOX_EXEC_ENABLED
    delete process.env.KUBERNETES_SERVICE_HOST
  })

  afterEach(() => {
    if (saved.SANDBOX_EXEC_ENABLED === undefined) delete process.env.SANDBOX_EXEC_ENABLED
    else process.env.SANDBOX_EXEC_ENABLED = saved.SANDBOX_EXEC_ENABLED
    if (saved.KUBERNETES_SERVICE_HOST === undefined) delete process.env.KUBERNETES_SERVICE_HOST
    else process.env.KUBERNETES_SERVICE_HOST = saved.KUBERNETES_SERVICE_HOST
  })

  test('defaults to false when nothing is set', () => {
    expect(isSandboxRequested()).toBe(false)
  })

  test('KUBERNETES_SERVICE_HOST alone requests sandboxing (legacy heuristic)', () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    expect(isSandboxRequested()).toBe(true)
  })

  test('SANDBOX_EXEC_ENABLED=true requests sandboxing with no K8s', () => {
    process.env.SANDBOX_EXEC_ENABLED = 'true'
    expect(isSandboxRequested()).toBe(true)
  })

  test('explicit SANDBOX_EXEC_ENABLED=false always wins over KUBERNETES_SERVICE_HOST', () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    process.env.SANDBOX_EXEC_ENABLED = 'false'
    expect(isSandboxRequested()).toBe(false)
  })

  test('explicit SANDBOX_EXEC_ENABLED=true wins even without KUBERNETES_SERVICE_HOST', () => {
    delete process.env.KUBERNETES_SERVICE_HOST
    process.env.SANDBOX_EXEC_ENABLED = 'true'
    expect(isSandboxRequested()).toBe(true)
  })

  test('a non-boolean SANDBOX_EXEC_ENABLED value falls back to the K8s heuristic', () => {
    process.env.SANDBOX_EXEC_ENABLED = 'yes'
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    expect(isSandboxRequested()).toBe(true)

    delete process.env.KUBERNETES_SERVICE_HOST
    expect(isSandboxRequested()).toBe(false)
  })
})
