// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { hasAdminPortalAccess } from "../admin-portal-access"

describe("hasAdminPortalAccess", () => {
  test("is true for super admins and scoped admins", () => {
    expect(hasAdminPortalAccess({ ok: true, data: { role: "super_admin" } })).toBe(true)
    expect(
      hasAdminPortalAccess({ ok: true, data: { role: "user", adminScopes: ["users:read"] } }),
    ).toBe(true)
  })

  test("is false for failed or ordinary sessions", () => {
    expect(hasAdminPortalAccess(null)).toBe(false)
    expect(hasAdminPortalAccess({ ok: false, data: { role: "super_admin" } })).toBe(false)
    expect(hasAdminPortalAccess({ ok: true, data: { role: "user", adminScopes: [] } })).toBe(false)
  })
})
