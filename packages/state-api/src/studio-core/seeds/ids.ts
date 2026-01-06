/**
 * Deterministic Seed IDs for studio-core bootstrap
 *
 * These UUIDs are committed to code for idempotent bootstrap operations.
 * Using deterministic IDs allows check-before-create patterns without
 * generating new IDs on each run.
 *
 * Format: UUIDv4-like with variant bits set correctly
 * - Version 4 (random): xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 * - y = 8, 9, a, or b (variant bits)
 */

/** Shogo organization - internal platform org */
export const SHOGO_ORG_ID = "00000000-0000-4000-8000-000000000001"

/** Platform project - shogo-platform development project */
export const PLATFORM_PROJECT_ID = "00000000-0000-4000-8000-000000000002"

/** Default team for Shogo org (created during bootstrap) */
export const SHOGO_DEFAULT_TEAM_ID = "00000000-0000-4000-8000-000000000003"
