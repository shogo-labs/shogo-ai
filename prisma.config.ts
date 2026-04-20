// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { defineConfig } from 'prisma/config'

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'

// NOTE: we use `process.env.DATABASE_URL ?? fallback` rather than Prisma's
// `env(name)` helper because the v7 helper throws PrismaConfigEnvError at
// config-load time when the var is unset. That breaks every static command
// (`prisma validate`, `prisma format`, and our pre-commit
// `prisma migrate diff --from-migrations --to-schema-datamodel` drift check),
// none of which actually open a DB connection. Commands that *do* connect
// will fail fast against this fallback with a clearer error site than a
// cryptic config-loader crash.
const DATABASE_URL_FALLBACK = 'postgres://unused:unused@localhost:5432/unused'

export default defineConfig({
  schema: isLocalMode ? 'prisma/schema.local.prisma' : 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL ?? DATABASE_URL_FALLBACK,
  },
})
