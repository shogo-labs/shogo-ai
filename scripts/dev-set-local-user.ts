// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * dev-set-local-user — rewrite the local-mode user identity in-place.
 *
 * Reads from .env.local (loaded automatically by Bun via .env.local):
 *   SHOGO_LOCAL_USER_EMAIL     — required, the email to display as
 *   SHOGO_LOCAL_USER_NAME      — optional, defaults to existing
 *   SHOGO_LOCAL_USER_PASSWORD  — optional, only needed if you want to also
 *                                sign in MANUALLY via the /sign-in form
 *                                (auto-sign-in works without this either way)
 *
 * Operates on the single existing user row in shogo.db. Does NOT delete or
 * recreate, so all FK relations (workspaces, projects, chats, etc.) survive.
 *
 * Run AFTER `bun dev:all` has booted at least once (so the seed step has
 * created the initial user). Restart the dev server after running so the
 * in-memory Better Auth session cache picks up the new password.
 *
 *   bun scripts/dev-set-local-user.ts
 */

import { auth } from '../apps/api/src/auth'
import { prisma } from '../apps/api/src/lib/prisma'

const email = process.env.SHOGO_LOCAL_USER_EMAIL
const name = process.env.SHOGO_LOCAL_USER_NAME
const password = process.env.SHOGO_LOCAL_USER_PASSWORD

if (!email) {
  console.error('❌ SHOGO_LOCAL_USER_EMAIL is not set in .env.local')
  process.exit(1)
}
if (process.env.SHOGO_LOCAL_MODE !== 'true') {
  console.error('❌ SHOGO_LOCAL_MODE is not "true" — refusing to run against a non-local DB')
  process.exit(1)
}

const user = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } })
if (!user) {
  console.error('❌ No user row found in shogo.db. Run `bun dev:all` once to seed the initial local user, then re-run this script.')
  process.exit(1)
}

const oldEmail = user.email
console.log(`📍 Found existing user: ${oldEmail} (id=${user.id})`)

// ── Step 1: update user identity ───────────────────────────────────────────
await prisma.user.update({
  where: { id: user.id },
  data: {
    email,
    name: name ?? user.name,
    emailVerified: true,
  },
})
console.log(`✅ Updated user.email → ${email}${name ? ` / name → ${name}` : ''}`)

// ── Step 2: rotate password (optional) ─────────────────────────────────────
if (password) {
  const ctx = await (auth as any).$context
  if (!ctx?.password?.hash) {
    console.error("❌ Couldn't access Better Auth password hasher (auth.$context.password.hash). Aborting password update; email change above is preserved.")
    process.exit(1)
  }
  const hash = await ctx.password.hash(password)

  const cred = await prisma.account.findFirst({
    where: { userId: user.id, providerId: 'credential' },
  })
  if (cred) {
    await prisma.account.update({
      where: { id: cred.id },
      data: { password: hash, accountId: user.id, updatedAt: new Date() },
    })
    console.log('✅ Rotated credential password hash')
  } else {
    await prisma.account.create({
      data: {
        id: crypto.randomUUID(),
        userId: user.id,
        accountId: user.id,
        providerId: 'credential',
        password: hash,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })
    console.log('✅ Created credential account row with password hash')
  }

  // Keep auto-sign-in's stashed plaintext in sync so /api/local/auto-sign-in
  // (which calls signInEmail with this value) keeps working unattended.
  await (prisma as any).localConfig.upsert({
    where: { key: 'local_user_password' },
    update: { value: password },
    create: { key: 'local_user_password', value: password },
  })
  console.log('✅ Synced localConfig.local_user_password for auto-sign-in')
} else {
  console.log('⊘ SHOGO_LOCAL_USER_PASSWORD not set — leaving password untouched. Auto-sign-in still works using the existing stashed password.')
}

console.log('')
console.log('🎉 Done. Restart `bun dev:all` and reload localhost:5173 — auto-sign-in will log you in as ' + email)
process.exit(0)
