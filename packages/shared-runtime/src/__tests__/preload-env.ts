// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Test preload — neutralises pod/staging environment that leaks into the test
 * process when `bun test` runs inside a Shogo runtime pod. server-framework's
 * configureAIProxy() emits a FATAL and aborts the whole run when AI_PROXY_URL
 * is set with no AI_PROXY_TOKEN (the pod injects the former, not the latter).
 * Clearing these BEFORE any test file is imported — and thus before suites
 * capture `const originalEnv = { ...process.env }` — makes the suite
 * deterministic on CI, dev machines, and inside pods alike.
 */
delete process.env.AI_PROXY_URL
delete process.env.AI_PROXY_TOKEN
delete process.env.API_URL
delete process.env.SHOGO_API_URL
delete process.env.SHOGO_PUBLIC_API_URL
delete process.env.KUBERNETES_SERVICE_HOST
delete process.env.KUBERNETES_SERVICE_PORT
delete process.env.KNATIVE_SERVICE_NAME
delete process.env.SYSTEM_NAMESPACE
for (const k of Object.keys(process.env)) {
  if (k.startsWith('S3_') || k.startsWith('AWS_')) delete process.env[k]
}
