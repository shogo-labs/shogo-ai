// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { defineConfig, env } from 'prisma/config'

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'

export default defineConfig({
  schema: isLocalMode ? 'prisma/schema.local.prisma' : 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
})
