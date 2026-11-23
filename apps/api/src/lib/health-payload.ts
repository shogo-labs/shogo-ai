// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The `/api/health` body (SHO-514).
 *
 * Split out of the route so the one rule that matters is testable: `ok` — and
 * therefore the HTTP status — is about THIS POD's liveness (Redis reachable, the
 * tunnel publisher not degraded) and nothing else. `storage` rides along as an
 * assertion for the deploy gate, and a missing bucket must never take every API
 * pod out of the load balancer: a short OCI blip would then become a full
 * outage, and the deploy gate would have nothing left to read.
 */

export interface HealthRedis {
  healthy: boolean
  latencyMs: number | null
}

export interface HealthStorage {
  ok: boolean
  /** ENV VAR NAMES of the configured buckets that do not exist. */
  missing: string[]
}

export interface HealthPayloadInput {
  version: string
  redis: HealthRedis
  /** `isTunnelRedisDegraded()`: init finished but the publisher is null. */
  degraded: boolean
  storage: HealthStorage
}

export interface HealthPayload {
  ok: boolean
  version: string
  redis: HealthRedis & { degraded: boolean }
  storage: HealthStorage
}

export function buildHealthPayload(input: HealthPayloadInput): HealthPayload {
  const ok = !input.degraded && input.redis.healthy
  return {
    ok,
    version: input.version,
    redis: { ...input.redis, degraded: input.degraded },
    storage: input.storage,
  }
}
