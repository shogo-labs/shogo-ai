// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * validate-custom-domains.ts
 *
 * Control-plane smoke test for the custom-domains feature against a REAL
 * Cloudflare zone — exercises the exact helper code path the API uses
 * (apps/api/src/lib/cloudflare-custom-hostnames.ts) end to end, without
 * needing a published app, real DNS, or any staging infra.
 *
 * Why this works without DNS: Cloudflare for SaaS lets you register a
 * `custom_hostname` for an ARBITRARY hostname. Creation returns `pending`
 * status + the validation records the customer would add; the cert never
 * actually issues (no DNS), but create / get / find-by-name / delete and the
 * KV `hostname -> subdomain` map all run for real. That's the whole control
 * plane.
 *
 * Lifecycle run (idempotent + self-cleaning):
 *   1. resolveConfig          — assert the feature reports "enabled"
 *   2. createCustomHostname   — POST a throwaway hostname, print instructions
 *   3. getCustomHostname      — read it back by id
 *   4. findCustomHostnameByName — reconciliation lookup by hostname
 *   5. putHostnameMapping     — KV write (if KV env present) + read-back verify
 *   6. deleteHostnameMapping  — KV cleanup
 *   7. deleteCustomHostname   — CF cleanup (always attempted in `finally`)
 *
 * Required env (same vars the api ksvc reads):
 *   CF_API_TOKEN (or CF_CUSTOM_HOSTNAMES_TOKEN)
 *       — token scoped `SSL and Certificates:Edit` on the TEST zone
 *         (+ `Workers KV Storage:Edit` on the account to also test KV).
 *   CF_CUSTOM_DOMAIN_ZONE_ID
 *       — id of the test zone. USE A NON-PRODUCTION ZONE.
 *
 * Optional env:
 *   CF_ACCOUNT_ID + CF_CUSTOM_DOMAIN_KV_NAMESPACE_ID
 *       — enable the KV map steps (skipped with a notice if absent).
 *   VALIDATE_HOSTNAME_SUFFIX  — base for the throwaway hostname.
 *                               Default `cp-validate.example.com`. The script
 *                               prepends a unique label, e.g.
 *                               `t-1717-abc.cp-validate.example.com`.
 *   VALIDATE_KEEP=1           — skip cleanup so you can inspect the records
 *                               in the Cloudflare dashboard.
 *
 * Usage:
 *   CF_CUSTOM_HOSTNAMES_TOKEN=... CF_CUSTOM_DOMAIN_ZONE_ID=... \
 *     bun apps/api/scripts/validate-custom-domains.ts
 *
 * Exit code 0 on PASS, 1 on any failure.
 */

import {
  getCustomHostnamesConfig,
  createCustomHostname,
  getCustomHostname,
  findCustomHostnameByName,
  deleteCustomHostname,
  putHostnameMapping,
  deleteHostnameMapping,
  type CustomHostnameState,
} from '../src/lib/cloudflare-custom-hostnames'

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'

let failures = 0
function ok(label: string, detail?: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
}
function bad(label: string, detail?: string) {
  failures++
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
}
function info(msg: string) {
  console.log(`  \x1b[2m·\x1b[0m ${msg}`)
}

function printInstructions(state: CustomHostnameState) {
  for (const rec of state.instructions) {
    info(`${rec.purpose}: ${rec.type} ${rec.name} -> ${rec.value}`)
  }
}

/** Raw KV read-back (the helper has no getter — the Worker is the reader). */
async function kvGet(
  accountId: string,
  namespaceId: string,
  token: string,
  key: string,
): Promise<string | null> {
  const res = await fetch(
    `${CF_API_BASE}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`KV get ${res.status}`)
  return await res.text()
}

async function main() {
  console.log('\n=== custom-domains control-plane validation ===\n')

  // 1. Config gate -----------------------------------------------------------
  const cfg = getCustomHostnamesConfig()
  if (!cfg) {
    bad(
      'feature is DISABLED',
      'set CF_API_TOKEN (or CF_CUSTOM_HOSTNAMES_TOKEN) + CF_CUSTOM_DOMAIN_ZONE_ID',
    )
    return
  }
  ok('feature enabled (config resolved)')
  info(`zone id:        ${cfg.zoneId}`)
  info(`fallback origin: ${cfg.fallbackOrigin}`)
  info(`ssl method:     ${cfg.sslMethod}`)
  const kvReady = Boolean(cfg.accountId && cfg.kvNamespaceId)
  info(
    kvReady
      ? `KV map:         account ${cfg.accountId}, ns ${cfg.kvNamespaceId}`
      : 'KV map:         not configured (KV steps will be skipped)',
  )

  const suffix = process.env.VALIDATE_HOSTNAME_SUFFIX || 'cp-validate.example.com'
  const label = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const hostname = `${label}.${suffix}`
  const keep = process.env.VALIDATE_KEEP === '1'
  console.log(`\nTest hostname: ${hostname}\n`)

  let createdId: string | null = null

  try {
    // 2. create --------------------------------------------------------------
    console.log('create custom hostname')
    const created = await createCustomHostname(hostname)
    createdId = created.id
    if (created.id && created.hostname === hostname) {
      ok('created', `id=${created.id} status=${created.status} ssl=${created.sslStatus ?? 'n/a'}`)
    } else {
      bad('create returned unexpected shape', JSON.stringify(created))
    }
    if (created.instructions.length > 0) {
      ok(`returned ${created.instructions.length} DNS instruction(s)`)
      printInstructions(created)
    } else {
      bad('no DNS instructions returned (UI would have nothing to show)')
    }

    // 3. get by id -----------------------------------------------------------
    console.log('\nget by id')
    const fetched = createdId ? await getCustomHostname(createdId) : null
    if (fetched && fetched.id === createdId) {
      ok('round-tripped by id', `status=${fetched.status}`)
    } else {
      bad('get by id did not return the record')
    }

    // 4. find by name --------------------------------------------------------
    console.log('\nfind by name (reconciliation path)')
    const found = await findCustomHostnameByName(hostname)
    if (found && found.id === createdId) {
      ok('found by hostname', `id=${found.id}`)
    } else {
      bad('find-by-name did not match the created id', found ? `got ${found.id}` : 'null')
    }

    // 5 + 6. KV map ----------------------------------------------------------
    if (kvReady) {
      console.log('\nKV hostname -> subdomain map')
      const testSubdomain = `cp-validate-${label}`
      const put = await putHostnameMapping(hostname, testSubdomain)
      if (put) ok('KV put returned true')
      else bad('KV put returned false')

      try {
        const readBack = await kvGet(
          cfg.accountId!,
          cfg.kvNamespaceId!,
          cfg.apiToken,
          hostname,
        )
        if (readBack === testSubdomain) ok('KV read-back matches', readBack)
        else bad('KV read-back mismatch', `got ${JSON.stringify(readBack)}`)
      } catch (err: any) {
        bad('KV read-back errored', err?.message ?? String(err))
      }

      const del = await deleteHostnameMapping(hostname)
      if (del) ok('KV delete returned true')
      else bad('KV delete returned false')
    } else {
      console.log('\nKV hostname -> subdomain map')
      info('skipped (CF_ACCOUNT_ID + CF_CUSTOM_DOMAIN_KV_NAMESPACE_ID not set)')
    }
  } catch (err: any) {
    bad('unexpected error during lifecycle', err?.message ?? String(err))
  } finally {
    // 7. cleanup -------------------------------------------------------------
    if (createdId && !keep) {
      console.log('\ncleanup')
      const deleted = await deleteCustomHostname(createdId)
      if (deleted) ok('deleted custom hostname', createdId)
      else bad('failed to delete custom hostname (manual cleanup needed)', createdId)
    } else if (keep) {
      console.log('\ncleanup')
      info(`VALIDATE_KEEP=1 — left ${hostname} (${createdId}) in place`)
    }
  }
}

main()
  .then(() => {
    console.log(
      failures === 0
        ? '\n\x1b[32mPASS\x1b[0m — control plane is healthy against this zone.\n'
        : `\n\x1b[31mFAIL\x1b[0m — ${failures} check(s) failed.\n`,
    )
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error('\n\x1b[31mFATAL\x1b[0m', err)
    process.exit(1)
  })
