// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regenerate `apps/api/src/config/disposable-domains.generated.ts` from the
 * community-maintained blocklist.
 *
 * Why a generated file and not a runtime dependency: signup is the hottest,
 * most abuse-sensitive path we have, and it must not depend on a network call
 * or a package resolution to decide whether to reject an address. Vendoring
 * keeps the decision synchronous, deterministic and offline.
 *
 * Usage
 * -----
 *   bun scripts/refresh-disposable-domains.ts            # fetch and write
 *   bun scripts/refresh-disposable-domains.ts --check    # exit 1 if stale
 *   bun scripts/refresh-disposable-domains.ts --from f.conf
 *
 * Run it on a schedule (or whenever the blocklist grows a farm we see in
 * production) and commit the regenerated file with the diff.
 */
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const BLOCKLIST_URL =
  'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf'
const OUT = resolve(import.meta.dir, '../apps/api/src/config/disposable-domains.generated.ts')

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const fromIdx = args.indexOf('--from')
const fromFile = fromIdx >= 0 ? args[fromIdx + 1] : null

async function loadConf(): Promise<string> {
  if (fromFile) return readFileSync(resolve(process.cwd(), fromFile), 'utf8')
  const res = await fetch(BLOCKLIST_URL, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`blocklist fetch failed: HTTP ${res.status}`)
  return res.text()
}

function parseConf(text: string): string[] {
  const domains = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim().toLowerCase()
    if (!line || line.startsWith('#')) continue
    domains.add(line)
  }
  return [...domains].sort()
}

function render(domains: string[]): string {
  const body = domains.map((d) => `  '${d}',`).join('\n')
  return `// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// GENERATED FILE — do not edit by hand.
// Source: https://github.com/disposable-email-domains/disposable-email-domains
// Regenerate: bun scripts/refresh-disposable-domains.ts
//
// ${domains.length} domains. Signup rejects an address whose domain, or any
// parent of it, appears here (see isBlockedEmailDomain in
// services/signup-risk-scoring.ts), so a subdomain of a blocked provider is
// blocked too.

export const GENERATED_DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
${body}
])
`
}

const domains = parseConf(await loadConf())
if (domains.length < 1000) {
  throw new Error(`refusing to write: only ${domains.length} domains parsed — likely a truncated download`)
}
const next = render(domains)

if (checkOnly) {
  const current = readFileSync(OUT, 'utf8')
  if (current !== next) {
    console.error('[disposable-domains] generated file is stale — run: bun scripts/refresh-disposable-domains.ts')
    process.exit(1)
  }
  console.log('[disposable-domains] up to date')
  process.exit(0)
}

writeFileSync(OUT, next)
console.log(`[disposable-domains] wrote ${domains.length} domains to ${OUT}`)
