// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Adds a second person to the local stack's team workspace, for specs that
 * need two people (huddles). Local mode refuses a second sign-up, so this
 * writes the user and an email/password credential straight to the database;
 * signing in then goes through Better Auth as usual.
 *
 *   DATABASE_URL=file:… bun --no-env-file e2e/local/huddle-seed-user.ts <email> <password> <name>
 *
 * Prints `{ userId, workspaceId }`.
 */
import { resolve } from "path"
import { prisma } from "../../apps/api/src/lib/prisma"

// better-auth is the API's dependency, not the e2e package's.
const { hashPassword } = await import(Bun.resolveSync("better-auth/crypto", resolve(import.meta.dir, "../../apps/api")))

const [email, password, name] = process.argv.slice(2)
if (!email || !password || !name) throw new Error("usage: huddle-seed-user.ts <email> <password> <name>")

const db = prisma as any
const owner = await db.member.findFirst({ where: { role: "owner", workspace: { kind: { not: "personal" } } }, orderBy: { createdAt: "asc" } })
if (!owner) throw new Error("local stack has no team workspace")

let user = await db.user.findFirst({ where: { email } })
if (!user) user = await db.user.create({ data: { email, name, emailVerified: true } })
if (!(await db.account.findFirst({ where: { userId: user.id, providerId: "credential" } }))) {
  await db.account.create({ data: { userId: user.id, accountId: user.id, providerId: "credential", password: await hashPassword(password) } })
}
if (!(await db.member.findFirst({ where: { userId: user.id, workspaceId: owner.workspaceId } }))) {
  await db.member.create({ data: { userId: user.id, workspaceId: owner.workspaceId, role: "member" } })
}
console.log(JSON.stringify({ userId: user.id, workspaceId: owner.workspaceId }))
await db.$disconnect?.()
