// Self-contained config — avoids require('prisma/config') which isn't
// resolvable inside the packaged Electron app's Resources directory.
module.exports = {
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
}
