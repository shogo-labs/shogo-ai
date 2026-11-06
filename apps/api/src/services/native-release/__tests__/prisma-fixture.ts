// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The single `../lib/prisma` mock for the native-release tests.
 *
 * `mock.module` is process-wide, so two test files each registering their own
 * factory meant whichever registered last served *both* files — the webhook test
 * silently ran against the meter test's empty tables and failed only when the
 * directory was run as a whole. One factory plus a holder each file points at
 * removes the ordering: every file installs the same mock and selects its own
 * fake before its cases run.
 */

/** The fake the current test file wants `prisma` to be. */
export const fakePrismaHolder: { current: Record<string, any> | null } = { current: null }

export function useFakePrisma(fake: Record<string, any>): void {
  fakePrismaHolder.current = fake
}

export const prismaProxy = new Proxy(
  {},
  {
    get(_target, prop) {
      const fake = fakePrismaHolder.current
      if (!fake) {
        throw new Error(
          `no fake prisma registered for "${String(prop)}" — call useFakePrisma() at the top of the test file`,
        )
      }
      return fake[prop as string]
    },
  },
)
