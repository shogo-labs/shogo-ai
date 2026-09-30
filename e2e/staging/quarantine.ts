// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hosted e2e quarantine registry.
 *
 * The nightly suite was red for 10+ consecutive nights after 2.0 shipped, so a
 * real regression was indistinguishable from known noise. A spec that cannot
 * be fixed right away goes here instead of staying red — with an owner and an
 * expiry, so quarantine is a loan, not a graveyard.
 *
 * Quarantined specs are excluded via `grepInvert` in e2e/playwright.config.ts
 * (set E2E_INCLUDE_QUARANTINED=1 to run them anyway). `bun run
 * check:e2e-quarantine` (CI) fails once an entry expires, is missing an owner,
 * or no longer matches a test title in its file.
 */

export interface QuarantineEntry {
  /** Spec path relative to e2e/staging, e.g. "workspace-switch.test.ts". */
  file: string
  /** Exact test title as passed to `test(...)`. */
  title: string
  /** GitHub handle accountable for fixing or deleting the spec. */
  owner: string
  /** Why it is quarantined (the failure, not "flaky"). */
  reason: string
  /** ISO date (YYYY-MM-DD); the CI check fails on or after this day. */
  expires: string
  /** Tracking issue URL. */
  issue?: string
}

/** Longest a spec may stay quarantined before it must be fixed or deleted. */
export const MAX_QUARANTINE_DAYS = 14

const CLOUD_ATTACH_404 =
  "Product bug, not a flaky test: the cloud Folders panel calls /api/local/projects/:id(/attachments), " +
  "which is only mounted when SHOGO_LOCAL_MODE=true (apps/api/src/server.ts), so attach/detach 404s on " +
  "staging. Needs a workspace-authorized cloud attachments route; the local router only checks that a user " +
  "is signed in and must not be mounted in cloud as-is."

export const QUARANTINE: QuarantineEntry[] = [
  ...[
    "attach B to A via the Folders panel",
    "agent in A sees only the anchor-scoped merged root (A + B)",
    "cross-project READ: agent reads a file in B",
    "cross-project WRITE: agent edits a file in B (readwrite attach)",
    "readonly enforcement: attach C read-only, edits are refused",
    "detach B; after restart B is gone from the merged tree",
    "link a local folder via the stubbed picker",
  ].map((title) => ({
    file: "workspace-attachments.test.ts",
    title,
    owner: "@lacvapps",
    reason: CLOUD_ATTACH_404,
    expires: "2026-10-12",
  })),
  {
    file: "agent-publish.test.ts",
    title: "agent publishes to {subdomain}.shogo.one and returns a live URL",
    owner: "@lacvapps",
    reason:
      "Infra bug, not a flaky test: staging uploads to shogo-published-apps-staging " +
      "(k8s/overlays/staging PUBLISH_BUCKET) but mints {subdomain}.shogo.one URLs, and the " +
      "*.shogo.one Worker serves from shogo-published-apps-production, so every staging " +
      "publish 404s with ObjectNotFound. *.staging.shogo.one does not resolve yet.",
    expires: "2026-10-12",
  },
  {
    file: "agent-publish.test.ts",
    title: "publishing a subdomain already taken by another project fails",
    owner: "@lacvapps",
    reason:
      "Infra bug, not a flaky test: on staging the publish call times out while assigning the " +
      "subdomain (agent retried 3x, run 36605288919), so project A never reserves it and " +
      "project B has nothing to collide with. Needs staging API logs.",
    expires: "2026-10-12",
  },
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** `grepInvert` patterns for every quarantined title, or undefined when empty. */
export function quarantineGrepInvert(entries: QuarantineEntry[] = QUARANTINE): RegExp[] | undefined {
  if (entries.length === 0) return undefined
  return entries.map((e) => new RegExp(`${escapeRegExp(e.title)}$`))
}
