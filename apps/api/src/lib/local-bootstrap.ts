// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import crypto from 'node:crypto'
import { auth } from '../auth'
import { prisma } from './prisma'

/** Restore persisted provider settings and seed the single local user. */
export async function bootstrapLocalDatabase(): Promise<void> {
  const localDb = prisma as any
  try {
    const savedConfig = await localDb.localConfig.findMany({})
    for (const row of savedConfig) {
      if (row.key === 'SHOGO_CLOUD_URL') {
        await localDb.localConfig.deleteMany({ where: { key: row.key } }).catch(() => {})
        continue
      }
      if (!process.env[row.key]) process.env[row.key] = row.value
    }
  } catch (err: any) {
    console.warn('[LocalMode] Could not restore local config:', err?.message ?? err)
  }

  try {
    if (await prisma.user.count() > 0) return
    const password = crypto.randomBytes(24).toString('base64')
    const response = await auth.api.signUpEmail({
      body: {
        name: process.env.SHOGO_LOCAL_USER_NAME || 'Local User',
        email: process.env.SHOGO_LOCAL_USER_EMAIL || 'local@shogo.local',
        password,
      },
    })
    if (response?.user) {
      await localDb.localConfig.upsert({
        where: { key: 'local_user_password' },
        update: { value: password },
        create: { key: 'local_user_password', value: password },
      })
    }
  } catch (err: any) {
    console.error('[LocalMode] Failed to auto-seed user:', err?.message ?? err)
  }
}
