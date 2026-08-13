// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * scripts/signoz-apply-alerts.ts
 *
 * Sync the alert definitions in `terraform/modules/signoz/alerts/*.yaml` into
 * SigNoz. Terraform deploys the k8s-infra collector but does not manage alert
 * content, so before this script those files were only documentation: none of
 * them existed in SigNoz, and the README's `POST /api/v1/rules` instruction is
 * rejected by current SigNoz (v0.133+ needs the v2 endpoint and the v2alpha1
 * body). Applying by hand is how they silently drifted to never-applied.
 *
 * Matching is by alert name, so re-running updates in place instead of piling up
 * duplicates. Alerts SigNoz has that this directory doesn't are left alone and
 * only reported — deleting them is out of scope for a sync run.
 *
 *   bun run scripts/signoz-apply-alerts.ts                      # dry-run diff
 *   bun run scripts/signoz-apply-alerts.ts --validate           # server-check schemas
 *   bun run scripts/signoz-apply-alerts.ts --apply
 *   bun run scripts/signoz-apply-alerts.ts --apply --only metal-tap-leak
 *   bun run scripts/signoz-apply-alerts.ts --apply --channel platform-oncall
 *
 * Env: SIGNOZ_URL (e.g. https://moving-aardvark.us.signoz.cloud)
 *      SIGNOZ_API_KEY (an API key, not the ingestion key — different secret)
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"

const ALERT_DIR = join(import.meta.dir, "..", "terraform", "modules", "signoz", "alerts")

const args = process.argv.slice(2)
const apply = args.includes("--apply")
const validate = args.includes("--validate")
const only = args.find((a, i) => args[i - 1] === "--only")
const channelOverride = args.find((a, i) => args[i - 1] === "--channel")

const baseUrl = (process.env.SIGNOZ_URL || "").replace(/\/$/, "")
const apiKey = process.env.SIGNOZ_API_KEY || ""

if (!baseUrl || !apiKey) {
  console.error("SIGNOZ_URL and SIGNOZ_API_KEY must be set.")
  process.exit(1)
}

type Rule = Record<string, unknown> & { alert?: string; id?: string }

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(baseUrl + path, {
    ...init,
    headers: {
      "SIGNOZ-API-KEY": apiKey,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  })
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  if (!res.ok) {
    throw new Error(`${init?.method || "GET"} ${path} -> ${res.status} ${JSON.stringify(body)}`)
  }
  return body
}

/**
 * Every threshold must name a channel that exists in SigNoz; the API rejects an
 * empty list outright. Checking up front turns the whole run into one clear
 * message instead of an identical failure per file.
 */
async function assertChannelsExist(names: Set<string>): Promise<void> {
  const listed = (await api("/api/v1/channels")) as { data?: { name?: string }[] }
  const have = new Set((listed.data || []).map((c) => c.name).filter(Boolean) as string[])
  const missing = [...names].filter((n) => !have.has(n))
  if (missing.length === 0) return

  const known = have.size > 0 ? [...have].join(", ") : "(none configured)"
  throw new Error(
    `Notification channel(s) not in SigNoz: ${missing.join(", ")}. Existing: ${known}. ` +
      `Create one under Settings -> Alert Channels (or pass --channel <existing>). ` +
      `Alerts cannot be created without one.`
  )
}

function loadFiles(): { file: string; rule: Rule }[] {
  return readdirSync(ALERT_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .filter((f) => !only || f.includes(only))
    .sort()
    .map((file) => {
      const rule = parseYaml(readFileSync(join(ALERT_DIR, file), "utf8")) as Rule
      if (channelOverride) {
        for (const t of (rule.condition as any)?.thresholds?.spec || []) {
          t.channels = [channelOverride]
        }
      }
      return { file, rule }
    })
}

function channelsOf(rule: Rule): string[] {
  return ((rule.condition as any)?.thresholds?.spec || []).flatMap(
    (t: { channels?: string[] }) => t.channels || []
  )
}

const NO_CHANNEL_ERROR = "at least one channel is required"

/**
 * Ask SigNoz to validate a rule body without creating anything.
 *
 * There is no validate-only endpoint, so this POSTs the rule with its channels
 * stripped. SigNoz validates the entire body first and only then rejects the
 * empty channel list, so that specific error means "everything else is
 * accepted" — and because a channel-less rule can never be created, the call
 * cannot have a side effect. Worth having: the twelve definitions in this
 * directory silently rotted into an unacceptable schema precisely because
 * nothing ever checked them against a server.
 */
async function validateRule(rule: Rule): Promise<string | null> {
  const probe = JSON.parse(JSON.stringify(rule)) as Rule
  for (const t of (probe.condition as any)?.thresholds?.spec || []) {
    t.channels = []
  }
  try {
    await api("/api/v2/rules", { method: "POST", body: JSON.stringify(probe) })
    // Unreachable in practice; if SigNoz ever accepts an empty channel list this
    // probe would create a rule, so surface it loudly rather than pretend.
    return "SigNoz accepted a rule with no channels — this probe may have created it; check Alert Rules"
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return msg.includes(NO_CHANNEL_ERROR) ? null : msg
  }
}

async function main(): Promise<void> {
  const files = loadFiles()
  if (files.length === 0) {
    console.log(`No alert files matched${only ? ` --only ${only}` : ""}.`)
    return
  }

  if (validate) {
    let bad = 0
    for (const { file, rule } of files) {
      const problem = await validateRule(rule)
      if (problem) {
        bad++
        console.error(`  INVALID ${file}\n          ${problem}`)
      } else {
        console.log(`  ok      ${file}`)
      }
    }
    console.log(`\n${files.length - bad}/${files.length} valid.`)
    if (bad > 0) process.exit(1)
    return
  }

  const existing = (await api("/api/v2/rules")) as { data?: { rules?: Rule[] } | Rule[] }
  const rules = Array.isArray(existing.data) ? existing.data : existing.data?.rules || []
  const byName = new Map<string, Rule>()
  for (const r of rules) {
    const name = (r.alert || (r as any).state?.alert) as string | undefined
    if (name) byName.set(name, r)
  }

  // A dry run should still surface a missing channel — that is the most likely
  // reason an --apply would fail — but as a warning, so the plan still prints.
  try {
    await assertChannelsExist(new Set(files.flatMap(({ rule }) => channelsOf(rule))))
  } catch (err) {
    if (apply) throw err
    console.log(`WARNING: ${err instanceof Error ? err.message : err}\n`)
  }

  let created = 0
  let updated = 0
  for (const { file, rule } of files) {
    const name = rule.alert
    if (!name) {
      console.error(`  ${file}: no 'alert' name, skipped`)
      continue
    }
    const found = byName.get(name)
    const verb = found ? "update" : "create"
    if (!apply) {
      console.log(`  ${verb.padEnd(6)} ${name}  (${file})`)
      continue
    }
    if (found?.id) {
      await api(`/api/v2/rules/${found.id}`, { method: "PUT", body: JSON.stringify(rule) })
      updated++
    } else {
      await api("/api/v2/rules", { method: "POST", body: JSON.stringify(rule) })
      created++
    }
    console.log(`  ${verb}d ${name}`)
  }

  const orphans = [...byName.keys()].filter((n) => !files.some(({ rule }) => rule.alert === n))
  if (orphans.length > 0) {
    console.log(`\nIn SigNoz but not in this directory (left untouched): ${orphans.join(", ")}`)
  }
  if (!apply) {
    console.log("\nDry run. Re-run with --apply.")
  } else {
    console.log(`\nDone: ${created} created, ${updated} updated.`)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
