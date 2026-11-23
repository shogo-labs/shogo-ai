// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Aggregate entry point. Most consumers should import from the
// individual subpaths (e.g. `@shogo-ai/core/logger`) for tighter
// tree-shaking; this barrel exists for the rare case a consumer wants
// the whole surface in one import.
//
// Only modules with no optional peers belong here (SHO-518).
// `./instrumentation` is deliberately absent: it imports OpenTelemetry
// statically while the manifest marks all of it optional, so re-exporting it
// would make `require('@shogo-ai/core')` throw MODULE_NOT_FOUND for a consumer
// who installed exactly what the manifest asked for. Import it from
// `@shogo-ai/core/instrumentation`. `src/__tests__/root-barrel.test.ts` keeps
// this true.
export * from './logger'
export * from './stream-buffer'
export * from './chat-message'
export * from './macos-junk'
export * from './tech-stack-registry'
export * from './file-types'
