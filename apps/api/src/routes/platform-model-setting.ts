// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin GET/PUT for a single-model PlatformSetting (title generation,
 * personal companion, summarizer). Each is one row holding a model id;
 * an empty value deletes the row so the feature's default applies.
 *
 * Mount under `/api/admin/settings/*`, which server.ts gates to super-admins.
 */
import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { resolvePublicModelSync } from '../services/public-models.service'
import { getMergedModelEntrySync } from '../services/model-registry.service'

export interface PlatformModelSetting {
  /** PlatformSetting row key. */
  settingKey: string
  /** Applies a saved value (null when reset) to this process's in-memory copy. */
  apply: (modelId: string | null) => void
}

/** True for a public alias or a model the registry can route. */
export function isKnownModelId(modelId: string): boolean {
  return Boolean(resolvePublicModelSync(modelId) || getMergedModelEntrySync(modelId))
}

export function platformModelSettingRoutes(setting: PlatformModelSetting): Hono {
  const router = new Hono()
  const { settingKey } = setting

  router.get('/', async (c) => {
    try {
      const row = await prisma.platformSetting.findUnique({ where: { key: settingKey } })
      return c.json({ model: row?.value ?? null })
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  router.put('/', async (c) => {
    try {
      const body = await c.req.json().catch(() => null)
      const auth = c.get('auth') as any
      const userId = auth?.user?.id || 'unknown'
      const value = typeof body?.model === 'string' ? body.model.trim() : ''

      if (value.length === 0) {
        await prisma.platformSetting.deleteMany({ where: { key: settingKey } })
        setting.apply(null)
        return c.json({ ok: true, model: null })
      }

      if (!isKnownModelId(value)) {
        return c.json({ error: `Unknown model '${value}'` }, 400)
      }

      await prisma.platformSetting.upsert({
        where: { key: settingKey },
        create: { key: settingKey, value, updatedBy: userId },
        update: { value, updatedBy: userId },
      })
      setting.apply(value)
      return c.json({ ok: true, model: value })
    } catch (err: any) {
      return c.json({ error: err.message }, 500)
    }
  })

  return router
}

/** Boot-time load of the stored value into memory. Failures are non-fatal. */
export async function loadPlatformModelSetting(setting: PlatformModelSetting, label: string): Promise<void> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: setting.settingKey } })
    if (row?.value) {
      setting.apply(row.value)
      console.log(`[${label}] Loaded admin override:`, row.value)
    }
  } catch (err: any) {
    console.log(`[${label}] No override loaded (non-fatal):`, err.message)
  }
}
