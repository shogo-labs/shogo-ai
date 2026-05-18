// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Declaration merging so jest-dom matchers (`toBeInTheDocument`,
 * `toHaveAccessibleName`, `toBeVisible`, …) type-check inside `bun:test`
 * `expect(...)` calls.
 */
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers'

declare module 'bun:test' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Matchers<T = unknown> extends TestingLibraryMatchers<typeof expect.stringContaining, T> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchers extends TestingLibraryMatchers<typeof expect.stringContaining, unknown> {}
}
