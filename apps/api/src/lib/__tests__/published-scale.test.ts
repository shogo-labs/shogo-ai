// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import {
  PUBLISHED_TARGET_CONCURRENCY,
  baseSubdomainOf,
  buildPublishedScaleAnnotations,
  isReservedEnvironmentSubdomain,
  normalizePublishedSize,
  publishedContainerResources,
  publishedServiceName,
  publishedSubdomainForEnv,
  validatePublishedScale,
} from '../published-scale'

describe('published-scale', () => {
  describe('buildPublishedScaleAnnotations', () => {
    it('maps min/max replicas onto the Knative autoscaler annotations', () => {
      const a = buildPublishedScaleAnnotations({ minReplicas: 2, maxReplicas: 7, size: 'm' })
      expect(a['autoscaling.knative.dev/min-scale']).toBe('2')
      expect(a['autoscaling.knative.dev/max-scale']).toBe('7')
      expect(a['autoscaling.knative.dev/target']).toBe(String(PUBLISHED_TARGET_CONCURRENCY))
      expect(a['autoscaling.knative.dev/scale-down-delay']).toBe('5m')
      expect(a['autoscaling.knative.dev/scale-to-zero-pod-retention-period']).toBe('1800s')
    })

    it('never emits max-scale 1 for a scale-to-zero app', () => {
      // The old hard-coded "1" is exactly what this removes: a single-replica
      // ceiling. min 0 / max 3 must produce max 3.
      const a = buildPublishedScaleAnnotations({ minReplicas: 0, maxReplicas: 3, size: 's' })
      expect(a['autoscaling.knative.dev/min-scale']).toBe('0')
      expect(a['autoscaling.knative.dev/max-scale']).toBe('3')
    })

    it('clamps max up to min so the pair is always valid', () => {
      const a = buildPublishedScaleAnnotations({ minReplicas: 4, maxReplicas: 2, size: 'l' })
      expect(a['autoscaling.knative.dev/max-scale']).toBe('4')
    })
  })

  describe('publishedContainerResources', () => {
    it('maps each size tier to a pod resource request/limit', () => {
      expect(publishedContainerResources('s')).toEqual({
        requests: { cpu: '250m', memory: '512Mi' },
        limits: { cpu: '500m', memory: '1Gi' },
      })
      expect(publishedContainerResources('l').limits.cpu).toBe('2000m')
    })
  })

  describe('validatePublishedScale', () => {
    it('accepts a valid triple', () => {
      const res = validatePublishedScale({ minReplicas: 0, maxReplicas: 3, size: 'm' })
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.settings).toEqual({ minReplicas: 0, maxReplicas: 3, size: 'm' })
    })

    it('rejects min > max', () => {
      const res = validatePublishedScale({ minReplicas: 5, maxReplicas: 2, size: 's' })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe('invalid_scale')
    })

    it('rejects a max below 1', () => {
      expect(validatePublishedScale({ minReplicas: 0, maxReplicas: 0, size: 's' }).ok).toBe(false)
    })

    it('rejects a negative or fractional min', () => {
      expect(validatePublishedScale({ minReplicas: -1, maxReplicas: 2, size: 's' }).ok).toBe(false)
      expect(validatePublishedScale({ minReplicas: 1.5, maxReplicas: 2, size: 's' }).ok).toBe(false)
    })

    it('falls back to "s" for an unknown size', () => {
      const res = validatePublishedScale({ minReplicas: 0, maxReplicas: 1, size: 'xl' })
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.settings.size).toBe('s')
    })
  })

  describe('environment naming', () => {
    it('names production and staging ksvcs', () => {
      expect(publishedServiceName('p1', 'production')).toBe('published-p1')
      expect(publishedServiceName('p1', 'staging')).toBe('published-p1-staging')
    })

    it('derives the staging subdomain with one DNS label', () => {
      expect(publishedSubdomainForEnv('acme', 'production')).toBe('acme')
      expect(publishedSubdomainForEnv('acme', 'staging')).toBe('acme--staging')
      // One label extra, so the existing wildcard cert + Worker route cover it.
      expect(publishedSubdomainForEnv('acme', 'staging').split('.').length).toBe(1)
    })

    it('round-trips back to the base subdomain', () => {
      expect(baseSubdomainOf('acme--staging')).toBe('acme')
      expect(baseSubdomainOf('acme')).toBe('acme')
    })

    it('reserves -- so it cannot be registered as a name', () => {
      expect(isReservedEnvironmentSubdomain('foo--staging')).toBe(true)
      expect(isReservedEnvironmentSubdomain('foo-bar')).toBe(false)
    })
  })

  describe('normalizePublishedSize', () => {
    it('normalizes and defaults to s', () => {
      expect(normalizePublishedSize('M')).toBe('m')
      expect(normalizePublishedSize(undefined)).toBe('s')
      expect(normalizePublishedSize('huge')).toBe('s')
    })
  })
})
