// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo client generator — emits `src/lib/shogo.ts` (or equivalent)
 * for generated pod apps.
 *
 * The goal is zero config: the pod is started with
 * `PROJECT_ID` + `RUNTIME_AUTH_SECRET` in env, so the generated file
 * just reads those and constructs the SDK client. No API key minting,
 * no env-file fiddling.
 *
 * Developers can still override behavior by passing extra options to
 * `createClient()` in their own module (the SDK exposes `setShogoApiKey`,
 * etc.), but the default path is:
 *
 *   ```ts
 *   import { shogo, PROJECT_ID } from '@/lib/shogo'
 *   const call = await shogo.voice.telephony!.outboundCall({ to })
 *   ```
 */

import { GENERATED_FILE_LICENSE_HEADER } from './generated-file-license-header'

export interface ShogoClientGeneratorOptions {
  /**
   * Import path used to bring in `prisma` inside the generated file.
   * Default: `'./db'` (matches the co-generated `db.${ext}` module).
   */
  dbImportPath?: string
  /**
   * Fallback `apiUrl` used when `process.env.SHOGO_API_URL` is absent.
   * Typical local-dev default is `http://localhost:8002`.
   */
  defaultApiUrl?: string
  /** File extension for the generated file ('ts' or 'tsx'). Default 'ts'. */
  fileExtension?: 'ts' | 'tsx'
}

export interface GeneratedShogoClientFile {
  /** Relative filename (to be combined with `output.dir`). */
  fileName: string
  /** Full module source. */
  code: string
}

/**
 * Produce the `shogo.ts` source — reads `PROJECT_ID` and `SHOGO_API_URL`
 * from env, wires up the SDK client, and re-exports a singleton `shogo`.
 */
export function generateShogoClient(
  options: ShogoClientGeneratorOptions = {},
): GeneratedShogoClientFile {
  const {
    dbImportPath = './db',
    defaultApiUrl = 'http://localhost:8002',
    fileExtension = 'ts',
  } = options

  const code = `${GENERATED_FILE_LICENSE_HEADER}
/**
 * Zero-config Shogo SDK client for generated pod apps.
 *
 * This module is produced by \`shogo generate\` under the
 * \`shogo-client\` output kind. Do not edit by hand — your changes will
 * be overwritten on the next generate. To customise behavior, construct
 * your own client elsewhere in the app.
 *
 * The Shogo-managed pod runtime injects:
 *   - PROJECT_ID           → the project this pod serves
 *   - RUNTIME_AUTH_SECRET  → per-project HMAC capability (picked up by
 *                            the SDK automatically; never hard-code)
 *   - SHOGO_API_URL        → base URL of the Shogo API to call
 *                            (falls back to \`${defaultApiUrl}\`)
 *
 * Usage:
 *   \`\`\`ts
 *   import { shogo, PROJECT_ID } from '@/lib/shogo'
 *   const res = await shogo.voice.telephony!.outboundCall({ to })
 *   \`\`\`
 */

import { createClient } from '@shogo-ai/sdk'
import { prisma } from '${dbImportPath}'

/**
 * The project this pod is scoped to. Guaranteed to be set in production;
 * in local dev a missing value is a configuration bug worth failing loudly.
 */
export const PROJECT_ID = process.env.PROJECT_ID ?? ''
if (!PROJECT_ID && process.env.NODE_ENV === 'production') {
  throw new Error(
    '[shogo] PROJECT_ID is not set. Generated pods should have this injected by the runtime.',
  )
}

/**
 * Singleton Shogo client. Voice telephony auto-detects
 * \`RUNTIME_AUTH_SECRET\` in env and authenticates every outbound call
 * with \`x-runtime-token\`. No API key is required in pod mode.
 */
export const shogo = createClient({
  apiUrl: process.env.SHOGO_API_URL ?? '${defaultApiUrl}',
  db: prisma,
  projectId: PROJECT_ID,
})

export type ShogoClient = typeof shogo
`

  return {
    fileName: `shogo.${fileExtension}`,
    code,
  }
}
