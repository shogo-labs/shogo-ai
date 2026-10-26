// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Delete the throwaway accounts a worker signed up once it finishes.
 *
 * `makeTestUser` records every email it hands out in this worker. The worker
 * fixture in `fixtures.ts` passes them to `/api/internal/e2e/delete-test-user`
 * at teardown, which removes the user, its e2e-only workspaces and their
 * projects' runtimes. Emails that never signed up are a no-op on the API.
 *
 * Needs `SHOGO_E2E_BOOTSTRAP_SECRET`; without it nothing is deleted.
 * `E2E_KEEP_TEST_USERS=1` keeps the accounts for debugging a run.
 */

const created = new Set<string>()

export function recordTestUser(email: string): void {
  created.add(email)
}

function apiBase(): string {
  return (
    process.env.E2E_API_URL ||
    process.env.STAGING_API_URL ||
    process.env.E2E_TARGET_URL ||
    process.env.STAGING_URL ||
    "http://localhost:8081"
  )
}

export async function deleteRecordedTestUsers(): Promise<void> {
  const secret = process.env.SHOGO_E2E_BOOTSTRAP_SECRET
  if (!secret || process.env.E2E_KEEP_TEST_USERS === "1" || created.size === 0) return
  const emails = [...created]
  created.clear()
  for (const email of emails) {
    try {
      const res = await fetch(`${apiBase()}/api/internal/e2e/delete-test-user`, {
        method: "POST",
        headers: { "x-e2e-bootstrap-secret": secret, "content-type": "application/json" },
        body: JSON.stringify({ userEmail: email }),
        signal: AbortSignal.timeout(120_000),
      })
      if (!res.ok && res.status !== 503) {
        console.warn(`[e2e] could not delete test user ${email} (HTTP ${res.status}): ${await res.text().catch(() => "")}`)
      }
    } catch (err: any) {
      console.warn(`[e2e] could not delete test user ${email}: ${err?.message ?? err}`)
    }
  }
}
