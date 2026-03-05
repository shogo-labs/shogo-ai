import { defineConfig, env } from 'prisma/config'

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'

export default defineConfig({
  schema: isLocalMode ? 'prisma/schema.local.prisma' : 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
})
