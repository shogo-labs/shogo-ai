// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Protected `prisma.config.ts`.
 *
 * Prisma 7 moved the connection URL out of `schema.prisma` and into
 * `prisma.config.ts` (`datasource: { url }`). `prisma db push` HARD-ERRORS
 * ("The datasource.url property is required in your Prisma config file when
 * using prisma db push.") when that property is absent — so the database is
 * never created and the app fails at runtime.
 *
 * The failure mode this guards against is the agent scaffolding/​rewriting
 * `prisma.config.ts` from a stale or hallucinated mental model. Observed in the
 * wild (mimo): writing the URL under a `migrate: { async url() { … } }` block,
 * or an `async url()` resolver, instead of the required `datasource: { url }`.
 * `db push` then can't find a datasource URL no matter how `DATABASE_URL` is
 * set, and the agent thrashes trying to repair its own config.
 *
 * Sibling of `prisma-schema-guard.ts`: same class of bug (a stray write
 * downgrades a managed file), same remedy (the runtime re-enforces a correct,
 * Prisma-7 config before any Prisma CLI reads it). Because `prisma.config.ts`
 * is a small, fully-managed infra file (not business logic), the heal restores
 * the canonical form rather than attempting a surgical TS rewrite.
 */

/** Managed-file deterrent carried at the top of the canonical config. */
export const PRISMA_CONFIG_MANAGED_COMMENT =
  '// Managed by Shogo. `prisma db push` (Prisma 7) requires `datasource.url`; ' +
  'do not move the URL under `migrate` or an `async url()` resolver.'

/**
 * Canonical Prisma-7 config for the runtime template (SQLite, env-driven URL
 * with a workspace-file fallback). Kept in sync with
 * `templates/runtime-template/prisma.config.ts` (modulo the managed comment).
 */
export const DEFAULT_PRISMA_CONFIG = [
  PRISMA_CONFIG_MANAGED_COMMENT,
  "import { defineConfig } from 'prisma/config'",
  '',
  'export default defineConfig({',
  "  schema: 'prisma/schema.prisma',",
  '  datasource: {',
  "    url: process.env.DATABASE_URL ?? 'file:./dev.db',",
  '  },',
  '})',
  '',
].join('\n')

/** Extract the inner body of the first top-level `datasource: { ... }` object. */
function datasourceBody(source: string): string | null {
  // The datasource object is flat (no nested braces), so a non-greedy match to
  // the first `}` is exact.
  const m = source.match(/\bdatasource\s*:\s*\{([^}]*)\}/s)
  return m ? m[1] : null
}

/**
 * True when `prisma.config.ts` lacks a usable `datasource.url` and would make
 * `prisma db push` fail:
 *   - the file is empty/missing, or
 *   - there is no `datasource: { … }` object, or
 *   - that object has no `url:` property (e.g. the URL was put under `migrate`
 *     or an `async url()` resolver).
 *
 * Any `url:` form (`process.env.X`, the Prisma `env()` helper, a literal) is
 * accepted — the only fatal state is the *absence* of `datasource.url`. This
 * keeps the check idempotent so re-enforcing a healthy config is a no-op.
 */
export function configIsDowngraded(source: string): boolean {
  if (!source || !source.trim()) return true
  const ds = datasourceBody(source)
  if (ds === null) return true
  return !/\burl\s*:/.test(ds)
}

/**
 * Return a Prisma-7-correct `prisma.config.ts`. When the input already declares
 * a `datasource.url` it is returned unchanged; otherwise the canonical config
 * (env-driven SQLite URL with a workspace-file fallback) is substituted.
 *
 * Idempotent: enforcing an already-correct config returns it unchanged.
 */
export function enforcePrismaConfig(source: string): string {
  return configIsDowngraded(source) ? DEFAULT_PRISMA_CONFIG : source
}
