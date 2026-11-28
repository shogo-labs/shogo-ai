// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression coverage for the rule listing in `scripts/signoz-apply-alerts.ts`
 * (WO-6b, 2026-11-28).
 *
 * The failure this locks down: the listing came from `/api/v2/rules`, which the
 * shared SigNoz answers with the SPA's `index.html` at HTTP 200. The lenient
 * parse turned that into `[]`, so `existing` was always empty and a dry run
 * announced `create` for all fourteen local files — a full `--apply` would have
 * POSTed thirteen duplicates into production alerting. Two independent things
 * have to hold:
 *
 *   1. the list call goes to `/api/v3/rules` (the endpoint that answers JSON),
 *      and rules are matched by their `alert` name;
 *   2. every way of getting a bogus listing — a non-JSON body, no `data.rules`,
 *      or zero rules against a non-empty directory — aborts the run instead of
 *      planning creates.
 *
 *   bun test scripts/__tests__/signoz-apply-alerts.test.ts
 */
import { describe, expect, test } from "bun:test"
import {
  RULE_LIST_PATH,
  assertListingConsistent,
  extractRules,
  indexByName,
  listAllRules,
  planRules,
  type Rule,
} from "../signoz-apply-alerts"

/** An api client that records every path it is asked for. */
function fakeClient(bodies: unknown[]): { calls: string[]; client: (p: string) => Promise<unknown> } {
  const calls: string[] = []
  const client = async (path: string): Promise<unknown> => {
    calls.push(path)
    return bodies[Math.min(calls.length - 1, bodies.length - 1)]
  }
  return { calls, client }
}

const page = (rules: Rule[], total = rules.length) => ({
  status: "success",
  data: { rules, total, limit: 100, offset: 0 },
})

describe("signoz-apply-alerts listing", () => {
  test("lists from /api/v3/rules and indexes rules by alert name", async () => {
    const { calls, client } = fakeClient([
      page([
        { alert: "ChannelsIndexerStalled", id: "rule-1" },
        { alert: "MetalTapLeak", id: "rule-2" },
      ]),
    ])

    const rules = await listAllRules(client)
    const byName = indexByName(rules)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toStartWith(`${RULE_LIST_PATH}?`)
    expect(RULE_LIST_PATH).toBe("/api/v3/rules")
    expect([...byName.keys()].sort()).toEqual(["ChannelsIndexerStalled", "MetalTapLeak"])
    expect(byName.get("MetalTapLeak")?.id).toBe("rule-2")
  })

  test("an HTML 200 body aborts instead of reading as zero rules", async () => {
    const html = "<!doctype html><html><head><title>SigNoz</title></head><body><div id=root></div></body></html>"
    const { client } = fakeClient([html])

    await expect(listAllRules(client)).rejects.toThrow(/non-JSON body/)
    // The message has to say what to do, not just that parsing failed.
    await expect(listAllRules(client)).rejects.toThrow(/duplicate every rule/)
    expect(() => extractRules(html)).toThrow(/v3/)
  })

  test("a listing without data.rules aborts", () => {
    expect(() => extractRules({ status: "success", data: {} })).toThrow(/no data.rules array/)
    expect(() => extractRules({ status: "success" })).toThrow(/no data.rules array/)
    expect(() => extractRules(null)).toThrow(/unexpected body/)
  })

  test("zero rules against a non-empty alert directory aborts the run", () => {
    expect(() => assertListingConsistent(0, 28)).toThrow(/must never mean "create everything"/)
    // ...but an empty directory (nothing to sync) is not an error.
    expect(() => assertListingConsistent(0, 0)).not.toThrow()
    expect(() => assertListingConsistent(14, 28)).not.toThrow()
  })

  test("an existing rule plans update; a new one plans create; no name skips", () => {
    const byName = indexByName([{ alert: "Existing", id: "rule-existing" }])
    const entries = planRules(
      [
        { file: "existing.yaml", rule: { alert: "Existing" } },
        { file: "new.yaml", rule: { alert: "New" } },
        { file: "nameless.yaml", rule: {} },
      ],
      byName
    )

    expect(entries.map((e) => [e.file, e.verb])).toEqual([
      ["existing.yaml", "update"],
      ["new.yaml", "create"],
      ["nameless.yaml", "skip"],
    ])
    expect(entries[0].id).toBe("rule-existing")
  })

  test("pages on total, and stops when the instance ignores limit/offset", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ alert: `R${i}`, id: `id-${i}` }))

    // Two real pages: a full one, then a short one.
    const paged = fakeClient([page(fullPage, 101), page([{ alert: "R100", id: "id-100" }], 101)])
    expect((await listAllRules(paged.client)).length).toBe(101)
    expect(paged.calls.length).toBe(2)

    // The instance ignores the query string and keeps returning the same 100.
    const stubborn = fakeClient([page(fullPage, 100)])
    expect((await listAllRules(stubborn.client)).length).toBe(100)
    expect(stubborn.calls.length).toBe(1)
  })
})
