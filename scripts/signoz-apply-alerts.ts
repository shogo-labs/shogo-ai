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
 * LISTING IS v3 AND FAILS CLOSED (2026-11-28). The list used to come from
 * `/api/v2/rules`, which this instance answers with the SPA's `index.html` at
 * HTTP 200 — a plain text body, so `existing` parsed to `[]` and every dry run
 * announced `create` for all fourteen files, including rules that had existed
 * for weeks. A single `--apply` would have POSTed thirteen duplicates into
 * production alerting, each with a live on-call channel. `/api/v3/rules`
 * returns `{status, data:{rules, total}}`. On top of that, a listing that is
 * not JSON, has no `data.rules`, or reports zero rules while this directory
 * holds files now aborts the run: a silent empty list must never mean
 * "create everything". Single-rule fetch/update/delete stay on v2 — they work.
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

export type Rule = Record<string, unknown> & { alert?: string; id?: string }
type ApiFn = (path: string, init?: RequestInit) => Promise<unknown>

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
 * Rule listing. `/api/v2/rules` answers with the SPA's HTML at HTTP 200 on this
 * instance, which is how "no rules exist" became the permanent answer; v3 is the
 * endpoint that actually returns JSON. Kept as its own exported function so the
 * paging and the fail-closed checks can be tested with an injected client
 * instead of a live SigNoz (scripts/__tests__/signoz-apply-alerts.test.ts).
 */
export const RULE_LIST_PATH = "/api/v3/rules"

const LIST_PAGE_SIZE = 100
const LIST_MAX_PAGES = 100

function snippet(body: unknown): string {
  const text = typeof body === "string" ? body : JSON.stringify(body)
  const flat = (text || "").replace(/\s+/g, " ").trim()
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat || "(empty body)"
}

export function extractRules(body: unknown, path = RULE_LIST_PATH): Rule[] {
  if (typeof body === "string") {
    throw new Error(
      `${path} returned a non-JSON body (HTTP 200): "${snippet(body)}". ` +
        `Refusing to read that as "no rules exist" — the endpoint changed shape ` +
        `and planning creates from it would duplicate every rule in SigNoz.`
    )
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`${path} returned an unexpected body: ${snippet(body)}`)
  }
  const data = (body as { data?: unknown }).data
  if (!data || typeof data !== "object" || !Array.isArray((data as { rules?: unknown }).rules)) {
    throw new Error(`${path} returned no data.rules array: ${snippet(body)}`)
  }
  return (data as { rules: Rule[] }).rules
}

export function indexByName(rules: Rule[]): Map<string, Rule> {
  const byName = new Map<string, Rule>()
  for (const rule of rules) {
    const name = (rule.alert || (rule as { state?: { alert?: string } }).state?.alert) as
      | string
      | undefined
    if (name) byName.set(name, rule)
  }
  return byName
}

/**
 * Page through the rule listing. 14 rules today, so this is one request — but
 * the limit/offset support is not assumed: a page that returns fewer than the
 * page size, no new names, or the whole `total` ends the walk, so an instance
 * that ignores the query string still terminates after one call.
 */
export async function listAllRules(client: ApiFn): Promise<Rule[]> {
  const seen = new Map<string, Rule>()
  const unnamed: Rule[] = []
  let offset = 0
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const body = await client(`${RULE_LIST_PATH}?limit=${LIST_PAGE_SIZE}&offset=${offset}`)
    const rules = extractRules(body)
    const total = Number((body as { data?: { total?: unknown } }).data?.total)
    let added = 0
    for (const rule of rules) {
      const name = (rule.alert || (rule as { state?: { alert?: string } }).state?.alert) as
        | string
        | undefined
      if (!name) {
        unnamed.push(rule)
        continue
      }
      if (!seen.has(name)) {
        seen.set(name, rule)
        added++
      }
    }
    if (rules.length < LIST_PAGE_SIZE) break
    if (added === 0) break
    if (Number.isFinite(total) && seen.size + unnamed.length >= total) break
    offset += rules.length
  }
  return [...seen.values(), ...unnamed]
}

/**
 * A listing of zero rules is only believable when there is nothing to sync. With
 * files on disk it means the endpoint lied (an empty `data`, an unauthenticated
 * read, a renamed field) and every file would be planned as a `create`.
 */
export function assertListingConsistent(ruleCount: number, fileCount: number): void {
  if (fileCount > 0 && ruleCount === 0) {
    throw new Error(
      `Listed 0 alert rules from ${RULE_LIST_PATH} while ${fileCount} rule file(s) exist in ` +
        `terraform/modules/signoz/alerts/. A silent empty listing must never mean "create everything" — ` +
        `aborting. Check that /api/v3/rules returns JSON and that SIGNOZ_API_KEY can read rules.`
    )
  }
}

export type PlanEntry = {
  file: string
  rule: Rule
  name?: string
  verb: "create" | "update" | "skip"
  id?: string
}

export function planRules(
  files: { file: string; rule: Rule }[],
  byName: Map<string, Rule>
): PlanEntry[] {
  return files.map(({ file, rule }) => {
    const name = rule.alert
    if (!name) return { file, rule, verb: "skip" as const }
    const found = byName.get(name)
    return found
      ? { file, rule, name, verb: "update" as const, id: found.id }
      : { file, rule, name, verb: "create" as const }
  })
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
  if (!baseUrl || !apiKey) {
    console.error("SIGNOZ_URL and SIGNOZ_API_KEY must be set.")
    process.exit(1)
  }

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

  const rules = await listAllRules(api)
  assertListingConsistent(rules.length, files.length)
  const byName = indexByName(rules)

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
  for (const entry of planRules(files, byName)) {
    if (entry.verb === "skip") {
      console.error(`  ${entry.file}: no 'alert' name, skipped`)
      continue
    }
    if (!apply) {
      console.log(`  ${entry.verb.padEnd(6)} ${entry.name}  (${entry.file})`)
      continue
    }
    if (entry.verb === "update" && entry.id) {
      await api(`/api/v2/rules/${entry.id}`, { method: "PUT", body: JSON.stringify(entry.rule) })
      updated++
    } else {
      await api("/api/v2/rules", { method: "POST", body: JSON.stringify(entry.rule) })
      created++
    }
    console.log(`  ${entry.verb}d ${entry.name}`)
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

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
