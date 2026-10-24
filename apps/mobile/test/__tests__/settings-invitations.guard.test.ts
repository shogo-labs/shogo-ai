// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Source guard for Settings → People → Invitations.
 *
 * An invitation you *received* is for a workspace you have not joined, so it
 * cannot be answered inside the settings of the workspace you are already in.
 * It now lives in the workspace switcher (phone sheet and wide sidebar) —
 * see `WorkspaceMenuSection.invitations.rtl.test.tsx`. Settings keeps only the
 * inviter-facing Sent table; this guard fails if a "Received" block (or the
 * state and fetch that fed it) comes back.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = readFileSync(resolve(import.meta.dir, "../../app/(app)/settings.tsx"), "utf8")

describe("Settings → People → Invitations", () => {
  test("keeps the Sent invitations table", () => {
    expect(source).toContain("Sent")
  })

  test("has no Received invitations block", () => {
    expect(source).not.toContain("Received")
    expect(source).not.toContain("receivedInvites")
  })

  test("no longer fetches or answers received invitations", () => {
    expect(source).not.toContain("getReceivedInvitations")
    expect(source).not.toContain("acceptInvitation")
    expect(source).not.toContain("declineInvitation")
    expect(source).not.toContain("processingInvite")
  })
})
