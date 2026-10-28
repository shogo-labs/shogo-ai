// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Secret detection and redaction shared by the project bundle and the
 * workspace archive. Both write "a downloadable file that must not carry
 * credentials", so they must agree on what a credential looks like — one list,
 * one implementation.
 */

import { parseEnvFile } from './bundle-crypto'

/**
 * Any object key matching this pattern is treated as a secret:
 *   - explicit secret words: token / secret / apikey / api_key / password / passwd
 *   - personal access tokens: PAT, GITHUB_PAT, ACCOUNT_PAT (word boundary)
 *   - OAuth flow values: bearer / client_secret / refresh_token / access_token
 *   - connection strings that embed credentials: DATABASE_URL, REDIS_URL, *_CONNECTION_STRING
 *   - private keys and SSH: private_key / ssh_key / *.pem
 *   - signing / encryption: signing_secret / encryption_key
 *   - webhook URLs (Slack, Discord and Teams put the secret in the URL)
 */
export const SECRET_KEY_PATTERN =
  /token|secret|apikey|api_key|password|passwd|(^|_)pat$|webhook.*url|bearer|client[_-]?secret|refresh[_-]?token|access[_-]?token|database[_-]?url|redis[_-]?url|mongo[_-]?url|connection[_-]?string|private[_-]?key|ssh[_-]?key|signing[_-]?secret|encryption[_-]?key|\.pem$/i

export const isSecretKey = (key: string): boolean => SECRET_KEY_PATTERN.test(key)

export interface RequiredCredential {
  /** Where the value is used: a project id, a channel type, or a file path. */
  channel: string
  field: string
  label: string
}

/**
 * Returns a copy of `rawChannels` with every secret-looking string replaced by
 * `null`, plus the list of credentials the importer must supply afterwards.
 * Accepts the channels JSON as an array or as a string (SQLite returns `Json`
 * columns as strings).
 */
export function sanitizeChannelsForExport(rawChannels: unknown): {
  sanitized: any[]
  required: RequiredCredential[]
} {
  let parsed: any = rawChannels
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      parsed = []
    }
  }
  if (!Array.isArray(parsed)) return { sanitized: [], required: [] }

  const required: RequiredCredential[] = []
  const sanitized = parsed.map((entry, idx) => {
    if (!entry || typeof entry !== 'object') return entry
    const channelType = entry.type || entry.channel || `channel-${idx}`
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(entry)) {
      if (typeof v === 'string' && v.length > 0 && isSecretKey(k)) {
        out[k] = null
        required.push({ channel: String(channelType), field: k, label: `${channelType}.${k}` })
      } else {
        out[k] = v
      }
    }
    return out
  })
  return { sanitized, required }
}

/**
 * Blank every secret-looking value in a `.env`-style file. Returns the
 * redacted text plus the keys that were blanked, so the caller can list them
 * in `credentials-required.json` and ship a `.env.example` alongside.
 */
export function redactEnvText(text: string): { text: string; redacted: string[] } {
  const lines = parseEnvFile(text)
  const redacted: string[] = []
  const out: string[] = []
  for (const line of lines) {
    if (line.isComment || !line.key) {
      out.push(line.raw)
      continue
    }
    if (isSecretKey(line.key) && line.value.length > 0) {
      redacted.push(line.key)
      out.push(`${line.key}=`)
    } else {
      out.push(line.raw)
    }
  }
  return { text: out.join('\n'), redacted }
}

/** True for a path whose basename is `.env` or `.env.<something>`. */
export function isEnvFile(relPath: string): boolean {
  const base = relPath.split('/').pop() || ''
  return base === '.env' || base.startsWith('.env.')
}
