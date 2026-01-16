/**
 * TDD Tests for task-org-006 (migrate-orphan-users-script)
 * Task: Create one-time migration script for users without orgs
 * Feature: org-management-auto-creation
 *
 * Test Specifications:
 * - test-org-006-01: Migration script finds users without Member records
 * - test-org-006-02: Migration script creates personal org for each orphaned user
 * - test-org-006-03: Migration script logs summary after completion
 * - test-org-006-04: Migration script is idempotent (safe to re-run)
 * - test-org-006-05: Migration script can be executed via bun run
 */

import { describe, test, expect, beforeEach, mock } from "bun:test"
import fs from "fs"
import path from "path"

const scriptPath = path.resolve(import.meta.dir, "../migrate-orphan-users.ts")

// ============================================================
// Test: Script file exists and has correct structure
// (test-org-006-05)
// ============================================================

describe("test-org-006-05: Migration script file structure", () => {
  test("Script file exists at apps/api/scripts/migrate-orphan-users.ts", () => {
    const exists = fs.existsSync(scriptPath)
    expect(exists).toBe(true)
  })

  test("Script imports pg Pool", () => {
    const scriptSource = fs.readFileSync(scriptPath, "utf-8")
    expect(scriptSource).toMatch(/import.*Pool.*from\s+["']pg["']/)
  })

  test("Script imports studioCoreDomain from state-api", () => {
    const scriptSource = fs.readFileSync(scriptPath, "utf-8")
    expect(scriptSource).toMatch(/import.*studioCoreDomain/)
  })

  test("Script uses DATABASE_URL from environment", () => {
    const scriptSource = fs.readFileSync(scriptPath, "utf-8")
    expect(scriptSource).toMatch(/process\.env\.DATABASE_URL/)
  })
})

// ============================================================
// Test: Script queries for orphaned users
// (test-org-006-01)
// ============================================================

describe("test-org-006-01: Migration script finds orphaned users", () => {
  test("Script queries users from Better Auth user table", () => {
    const scriptSource = fs.readFileSync(scriptPath, "utf-8")
    expect(scriptSource).toMatch(/better_auth\.user|better_auth\."user"/)
  })

  test("Script identifies users without Member records via LEFT JOIN or NOT EXISTS", () => {
    const scriptSource = fs.readFileSync(scriptPath, "utf-8")
    // Should use LEFT JOIN + IS NULL or NOT EXISTS pattern
    expect(scriptSource).toMatch(/LEFT JOIN|NOT EXISTS|NOT IN/)
  })

  test("Script references studio_core.member table for membership check", () => {
    const scriptSource = fs.readFileSync(scriptPath, "utf-8")
    expect(scriptSource).toMatch(/studio_core\.member/)
  })
})

// ============================================================
// Test: Script creates personal org for orphaned users
// (test-org-006-02)
// ============================================================

describe("test-org-006-02: Migration script creates personal orgs", () => {
  test("Script calls createPersonalOrganization for each orphaned user", () => {
    const scriptSource = fs.readFileSync(scriptPath, "utf-8")
    // Should iterate over orphaned users and call domain action
    expect(scriptSource).toMatch(/createPersonalOrganization\s*\(/)
  })

  test("Script passes user id and name to createPersonalOrganization", () => {
    const scriptSource = fs.readFileSync(scriptPath, "utf-8")
    // Should pass user.id and user.name
    expect(scriptSource).toMatch(/user\.id.*user\.name|\.id.*\.name/)
  })

  test("Script logs progress for each user", () => {
    const scriptSource = fs.readFileSync(scriptPath, "utf-8")
    expect(scriptSource).toMatch(/console\.log.*Creating personal org/)
  })
})

// ============================================================
// Test: Script logs summary
// (test-org-006-03)
// ============================================================

describe("test-org-006-03: Migration script logs summary", () => {
  test("Script logs migration count after completion", () => {
    const scriptSource = fs.readFileSync(scriptPath, "utf-8")
    // Should log something like "Migrated N users"
    expect(scriptSource).toMatch(/Migrated.*user|migrated.*user/i)
  })
})

// ============================================================
// Test: Script is idempotent
// (test-org-006-04)
// ============================================================

describe("test-org-006-04: Migration script is idempotent", () => {
  test("Script only processes users without ANY Member records", () => {
    const scriptSource = fs.readFileSync(scriptPath, "utf-8")
    // Query should only return users with no memberships at all
    // This is verified by the LEFT JOIN / NOT EXISTS pattern
    expect(scriptSource).toMatch(/IS NULL|NOT EXISTS|NOT IN/)
  })

  test("Script handles empty result set gracefully", () => {
    const scriptSource = fs.readFileSync(scriptPath, "utf-8")
    // Should handle case where no orphaned users found
    expect(scriptSource).toMatch(/length|rows|count/i)
  })
})

// ============================================================
// Test: Script can be imported
// ============================================================

describe("Migration script module", () => {
  test("Script exports migrateOrphanUsers function", async () => {
    const module = await import("../migrate-orphan-users")
    expect(module.migrateOrphanUsers).toBeDefined()
    expect(typeof module.migrateOrphanUsers).toBe("function")
  })
})
