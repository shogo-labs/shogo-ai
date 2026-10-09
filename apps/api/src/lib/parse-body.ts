// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { Context } from 'hono'
import type { z } from 'zod'

export type ParsedBody<T> = { ok: true; data: T } | { ok: false; response: Response }

/**
 * Parses the JSON body with `schema`. Invalid JSON and schema failures become
 * a 400 `{ error: { code: 'bad_request', message } }` using the first issue.
 */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<ParsedBody<z.output<S>>> {
  const raw = await c.req.json().catch(() => undefined)
  const parsed = schema.safeParse(raw ?? {})
  if (parsed.success) return { ok: true, data: parsed.data }
  const message = parsed.error.issues[0]?.message ?? 'Invalid request body'
  return { ok: false, response: c.json({ error: { code: 'bad_request', message } }, 400) }
}
