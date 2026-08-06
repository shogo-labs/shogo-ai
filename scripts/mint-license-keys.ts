// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One-off CLI for minting a batch of `LicenseKey` codes without going
 * through the admin UI. Thin wrapper around `mintLicenseKeys()` — see
 * `apps/api/src/services/license-key.service.ts` for the storage /
 * single-use semantics.
 *
 * Plaintext codes are only ever available at mint time, so this script
 * prints them to stdout AND writes a CSV (unless --no-csv is passed).
 * Treat the CSV as sensitive: it's the only record of the plaintext
 * codes and should be deleted/handed off (e.g. to marketing) rather
 * than committed or left lying around.
 *
 * Usage:
 *   DATABASE_URL=postgres://... bun scripts/mint-license-keys.ts \
 *     --count 200 \
 *     --plan pro \
 *     --duration-days 30 \
 *     --batch-id shogo-pro-1mo-2026-07 \
 *     [--prefix SHGO-PRO] \
 *     [--note "some note"] \
 *     [--out codes.csv] \
 *     [--no-csv]
 */

import { writeFileSync } from 'node:fs'
import { prisma } from '../apps/api/src/lib/prisma'
import { mintCode, hashCode } from '../apps/api/src/services/license-key.service'
import { normalizePlanId, PLAN_RANK } from '../apps/api/src/config/usage-plans'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

const COUNT = Number(arg('count') ?? '200')
const PLAN_ID = arg('plan') ?? arg('plan-id') ?? 'pro'
const DURATION_DAYS_RAW = arg('duration-days')
const DURATION_DAYS = DURATION_DAYS_RAW === undefined ? 30 : Number(DURATION_DAYS_RAW)
const BATCH_ID = arg('batch-id') ?? arg('batch') ?? null
const CODE_PREFIX = arg('prefix')
const NOTE = arg('note') ?? null
const OUT_PATH = arg('out') ?? `license-keys-${PLAN_ID}-${Date.now()}.csv`
const WRITE_CSV = !flag('no-csv')
// Matches buildRedeemLink() in apps/mobile/app/(admin)/license-keys/mint.tsx —
// lands the recipient on the billing screen with the code prefilled.
const WEB_BASE_URL = arg('web-base-url') ?? 'https://studio.shogo.ai'

function buildRedeemLink(code: string): string {
  return `${WEB_BASE_URL}/billing?redeem=${encodeURIComponent(code)}`
}

async function main() {
  if (!Number.isFinite(COUNT) || COUNT < 1) {
    console.error(`Invalid --count: ${arg('count')}`)
    process.exit(1)
  }
  if (!Number.isFinite(DURATION_DAYS) || DURATION_DAYS < 1) {
    console.error(`Invalid --duration-days: ${DURATION_DAYS_RAW}`)
    process.exit(1)
  }

  const normalized = normalizePlanId(PLAN_ID)
  if (!normalized || PLAN_RANK[normalized] < PLAN_RANK.basic) {
    console.error(`Invalid --plan (must confer a paid tier): ${PLAN_ID}`)
    process.exit(1)
  }

  console.log(
    `Minting ${COUNT} "${normalized}" license key(s), ${DURATION_DAYS}-day grant each` +
      (BATCH_ID ? `, batch="${BATCH_ID}"` : ''),
  )

  // Generate plaintext codes locally (same RNG/format as mintLicenseKeys)
  // and insert via a single `createMany` round trip rather than
  // `mintLicenseKeys`'s per-row `$transaction`, which times out when the
  // DB is reached over a latency-heavy tunnel (e.g. kubectl port-forward)
  // for a few hundred sequential round trips.
  const rows: Array<{ plaintext: string; codeHash: string; codePrefix: string }> = []
  const seenHashes = new Set<string>()
  while (rows.length < COUNT) {
    const { plaintext } = mintCode(CODE_PREFIX)
    const codeHash = hashCode(plaintext)
    if (seenHashes.has(codeHash)) continue
    seenHashes.add(codeHash)
    rows.push({ plaintext, codeHash, codePrefix: plaintext.slice(0, 12) })
  }

  await prisma.licenseKey.createMany({
    data: rows.map((r) => ({
      codeHash: r.codeHash,
      codePrefix: r.codePrefix,
      batchId: BATCH_ID,
      planId: normalized,
      durationDays: DURATION_DAYS,
      note: NOTE,
    })),
  })

  const keys = rows.map((r) => ({ plaintext: r.plaintext, planId: normalized }))
  console.log(`\nMinted ${keys.length} key(s):\n`)
  for (const k of keys) console.log(k.plaintext)

  if (WRITE_CSV) {
    const header = 'code,planId,durationDays,batchId,redeemLink\n'
    const csvRows = keys
      .map(
        (k) =>
          `${k.plaintext},${k.planId},${DURATION_DAYS},${BATCH_ID ?? ''},${buildRedeemLink(k.plaintext)}`,
      )
      .join('\n')
    writeFileSync(OUT_PATH, header + csvRows + '\n')
    console.log(`\nWrote plaintext codes to ${OUT_PATH} (this is the only copy — keep it safe).`)
  }
}

main()
  .catch((err) => {
    console.error('[mint-license-keys] failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
