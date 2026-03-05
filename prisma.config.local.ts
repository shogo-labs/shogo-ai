import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.local.prisma',
  datasource: {
    url: env('DATABASE_URL', 'file:./shogo.db'),
  },
})
