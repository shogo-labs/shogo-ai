// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Aggregate barrel. Most consumers should import from individual
// subpaths (e.g. `@shogo-ai/agent/agent-loop`) for tighter
// tree-shaking; this exists for the rare case a consumer wants the
// agent surface in one import.
//
// Only modules whose runtime import graph is satisfied by a plain
// `npm install @shogo-ai/agent` belong here. `agent-loop`,
// `pi-adapter` and `vision-fallback` value-import the optional
// `@mariozechner/pi-agent-core` / `@mariozechner/pi-ai` peers at module
// scope, so re-exporting them here made the root throw MODULE_NOT_FOUND
// for anyone who installed the package without pi (SHO-519). They are
// subpath-only, the same way `@shogo-ai/sdk` publishes them.
// `src/__tests__/root-barrel-peers.test.ts` fails if a new `export *`
// puts an optional peer back into this entry.
export * from './model-catalog'
export * from './model-router'
export * from './tool-orchestration'
export * from './loop-detector'
export * from './microcompact'
export * from './prefix-fingerprint'
export * from './hooks'
export * from './ai-client'
export * from './ai-proxy'
