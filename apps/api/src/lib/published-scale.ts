// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pure scale/environment helpers for published apps (SHO-308).
 *
 * Published apps run on Knative, so scaling is Knative's autoscaler — not a
 * home-made one. This module owns the mapping from a `PublishedEnvironment`'s
 * settings (min/max replicas + size tier) to the ksvc template annotations and
 * container resources, plus the environment naming rules. Kept dependency-free
 * so the publish route, the ops service, the cutover script and unit tests can
 * all share one definition.
 */

export type PublishedEnvironmentName = 'production' | 'staging'

export const PUBLISHED_ENVIRONMENT_NAMES: PublishedEnvironmentName[] = ['production', 'staging']

export type PublishedSize = 's' | 'm' | 'l'

export const PUBLISHED_SIZE_ORDER: PublishedSize[] = ['s', 'm', 'l']

export interface PublishedSizeSpec {
  label: string
  /** Container limits. */
  cpu: string
  memory: string
  /** Container requests (scheduling guarantee). */
  requestCpu: string
  requestMemory: string
  /** The editing-runtime instance size this tier corresponds to. */
  instanceSize: 'small' | 'medium' | 'large'
}

/**
 * Size tiers are pod CPU/memory, not a separate machine. `s` is the default and
 * is what a free/basic plan gets; `m`/`l` are paid tiers (see usage-plans.ts).
 */
export const PUBLISHED_SIZE_SPECS: Record<PublishedSize, PublishedSizeSpec> = {
  s: {
    label: 'Small',
    cpu: '500m',
    memory: '1Gi',
    requestCpu: '250m',
    requestMemory: '512Mi',
    instanceSize: 'small',
  },
  m: {
    label: 'Medium',
    cpu: '1000m',
    memory: '2Gi',
    requestCpu: '500m',
    requestMemory: '1Gi',
    instanceSize: 'medium',
  },
  l: {
    label: 'Large',
    cpu: '2000m',
    memory: '4Gi',
    requestCpu: '1000m',
    requestMemory: '2Gi',
    instanceSize: 'large',
  },
}

/** Concurrent requests per replica before Knative adds another pod. */
export const PUBLISHED_TARGET_CONCURRENCY = 50
/** Keep a pod around for 5 minutes after the last request (avoids thrash). */
export const PUBLISHED_SCALE_DOWN_DELAY = '5m'
/** How long a scaled-to-zero pod is retained before it is reaped. */
export const PUBLISHED_SCALE_TO_ZERO_RETENTION = '1800s'

export interface PublishedScaleSettings {
  minReplicas: number
  maxReplicas: number
  size: PublishedSize
}

export const DEFAULT_PUBLISHED_SCALE: PublishedScaleSettings = {
  minReplicas: 0,
  maxReplicas: 1,
  size: 's',
}

export function normalizePublishedSize(value: unknown): PublishedSize {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (PUBLISHED_SIZE_ORDER as string[]).includes(v) ? (v as PublishedSize) : 's'
}

export function publishedSizeSpec(size: PublishedSize): PublishedSizeSpec {
  return PUBLISHED_SIZE_SPECS[normalizePublishedSize(size)]
}

/**
 * The ksvc template annotations that make Knative autoscale this environment.
 * `min-scale` is what "always-on" means now: min >= 1 keeps a warm replica.
 */
export function buildPublishedScaleAnnotations(settings: PublishedScaleSettings): Record<string, string> {
  const min = Math.max(0, Math.floor(settings.minReplicas))
  const max = Math.max(min, Math.floor(settings.maxReplicas))
  return {
    'autoscaling.knative.dev/min-scale': String(min),
    'autoscaling.knative.dev/max-scale': String(max),
    'autoscaling.knative.dev/target': String(PUBLISHED_TARGET_CONCURRENCY),
    'autoscaling.knative.dev/target-utilization-percentage': '70',
    'autoscaling.knative.dev/scale-down-delay': PUBLISHED_SCALE_DOWN_DELAY,
    'autoscaling.knative.dev/scale-to-zero-pod-retention-period': PUBLISHED_SCALE_TO_ZERO_RETENTION,
  }
}

export function publishedContainerResources(size: PublishedSize): {
  requests: { cpu: string; memory: string }
  limits: { cpu: string; memory: string }
} {
  const spec = publishedSizeSpec(size)
  return {
    requests: { cpu: spec.requestCpu, memory: spec.requestMemory },
    limits: { cpu: spec.cpu, memory: spec.memory },
  }
}

export type PublishedScaleValidation =
  | { ok: true; settings: PublishedScaleSettings }
  | { ok: false; code: 'invalid_scale'; message: string }

/**
 * Validate a requested scale. Plan caps are applied separately (they need the
 * workspace plan), so this only enforces the shape: integers, 0 <= min <= max,
 * max >= 1, and a known size.
 */
export function validatePublishedScale(input: {
  minReplicas?: unknown
  maxReplicas?: unknown
  size?: unknown
}): PublishedScaleValidation {
  const min = input.minReplicas === undefined ? 0 : Number(input.minReplicas)
  const max = input.maxReplicas === undefined ? 1 : Number(input.maxReplicas)
  if (!Number.isInteger(min) || min < 0) {
    return { ok: false, code: 'invalid_scale', message: 'minReplicas must be a non-negative integer' }
  }
  if (!Number.isInteger(max) || max < 1) {
    return { ok: false, code: 'invalid_scale', message: 'maxReplicas must be an integer >= 1' }
  }
  if (min > max) {
    return { ok: false, code: 'invalid_scale', message: 'minReplicas cannot exceed maxReplicas' }
  }
  return {
    ok: true,
    settings: { minReplicas: min, maxReplicas: max, size: normalizePublishedSize(input.size) },
  }
}

/** `published-{projectId}` for production, `published-{projectId}-staging` for staging. */
export function publishedServiceName(projectId: string, environment: PublishedEnvironmentName): string {
  return environment === 'staging' ? `published-${projectId}-staging` : `published-${projectId}`
}

/**
 * Staging lives at `{subdomain}--staging.{domain}` — one DNS label, so the
 * existing wildcard cert and edge Worker route already cover it. Production
 * keeps the bare `{subdomain}.{domain}`.
 */
export function publishedSubdomainForEnv(
  baseSubdomain: string,
  environment: PublishedEnvironmentName,
): string {
  return environment === 'staging' ? `${baseSubdomain}--staging` : baseSubdomain
}

/** The base subdomain a per-environment subdomain was derived from. */
export function baseSubdomainOf(subdomain: string): string {
  return subdomain.endsWith('--staging') ? subdomain.slice(0, -'--staging'.length) : subdomain
}

/** `--` is reserved for environment suffixes, so it can't be registered. */
export function isReservedEnvironmentSubdomain(subdomain: string): boolean {
  return subdomain.includes('--')
}
