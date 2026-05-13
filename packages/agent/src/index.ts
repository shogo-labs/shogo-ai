// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Aggregate barrel. Most consumers should import from individual
// subpaths (e.g. `@shogo-ai/agent/agent-loop`) for tighter
// tree-shaking; this exists for the rare case a consumer wants the
// whole agent surface in one import.
export * from './agent-loop'
export * from './pi-adapter'
export * from './model-catalog'
export * from './model-router'
export * from './tool-orchestration'
export * from './loop-detector'
export * from './microcompact'
export * from './prefix-fingerprint'
export * from './hooks'
