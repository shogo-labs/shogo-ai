// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Unit test for the prisma-mock-exports helper itself.
// The helper is imported by ~30 test files but its own functions
// (raw/sql lambdas, PrismaClientKnownRequestError constructor,
// PrismaClientValidationError/InitializationError bodies, withPrismaExports)
// were never directly exercised — hence the 40% funcPct gap.

import { describe, expect, test } from 'bun:test'
import {
  BILLING_INTERVAL,
  INSTANCE_KIND,
  INSTANCE_SIZE,
  INSTANCE_STATUS,
  PRICING_MODEL,
  PRISMA_NAMESPACE,
  SUBSCRIPTION_STATUS,
  withPrismaExports,
} from './prisma-mock-exports'

describe('PRISMA_NAMESPACE', () => {
  test('raw() returns its input unchanged', () => {
    expect(PRISMA_NAMESPACE.raw('SELECT 1')).toBe('SELECT 1')
    expect(PRISMA_NAMESPACE.raw('')).toBe('')
  })

  test('sql() returns its input unchanged', () => {
    expect(PRISMA_NAMESPACE.sql('SELECT 2')).toBe('SELECT 2')
  })

  test('empty is an empty string', () => {
    expect(PRISMA_NAMESPACE.empty).toBe('')
  })

  test('TransactionIsolationLevel has all standard values', () => {
    expect(PRISMA_NAMESPACE.TransactionIsolationLevel.Serializable).toBe('Serializable')
    expect(PRISMA_NAMESPACE.TransactionIsolationLevel.ReadCommitted).toBe('ReadCommitted')
  })

  test('PrismaClientKnownRequestError sets code, meta, and clientVersion', () => {
    const err = new PRISMA_NAMESPACE.PrismaClientKnownRequestError('record not found', {
      code: 'P2025',
      meta: { target: 'User' },
      clientVersion: '5.0.0',
    })
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('P2025')
    expect(err.meta).toEqual({ target: 'User' })
    expect(err.clientVersion).toBe('5.0.0')
    expect(err.message).toBe('record not found')
  })

  test('PrismaClientKnownRequestError defaults clientVersion to "mock"', () => {
    const err = new PRISMA_NAMESPACE.PrismaClientKnownRequestError('oops', { code: 'P2002' })
    expect(err.clientVersion).toBe('mock')
    expect(err.meta).toBeUndefined()
  })

  test('PrismaClientValidationError is an Error subclass', () => {
    const err = new PRISMA_NAMESPACE.PrismaClientValidationError('bad input')
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('bad input')
  })

  test('PrismaClientInitializationError is an Error subclass', () => {
    const err = new PRISMA_NAMESPACE.PrismaClientInitializationError('init failed')
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('init failed')
  })
})

describe('enum constants', () => {
  test('SUBSCRIPTION_STATUS has expected keys', () => {
    expect(SUBSCRIPTION_STATUS.active).toBe('active')
    expect(SUBSCRIPTION_STATUS.canceled).toBe('canceled')
    expect(SUBSCRIPTION_STATUS.trialing).toBe('trialing')
  })

  test('BILLING_INTERVAL', () => {
    expect(BILLING_INTERVAL.monthly).toBe('monthly')
    expect(BILLING_INTERVAL.annual).toBe('annual')
  })

  test('INSTANCE_SIZE', () => {
    expect(INSTANCE_SIZE.micro).toBe('micro')
    expect(INSTANCE_SIZE.xlarge).toBe('xlarge')
  })

  test('PRICING_MODEL', () => {
    expect(PRICING_MODEL.free).toBe('free')
    expect(PRICING_MODEL.subscription).toBe('subscription')
  })

  test('INSTANCE_STATUS', () => {
    expect(INSTANCE_STATUS.online).toBe('online')
    expect(INSTANCE_STATUS.offline).toBe('offline')
  })

  test('INSTANCE_KIND', () => {
    expect(INSTANCE_KIND.desktop).toBe('desktop')
    expect(INSTANCE_KIND.cli_worker).toBe('cli_worker')
  })
})

describe('withPrismaExports', () => {
  const stubPrisma = { fake: true }

  test('returns prisma and all defaults when no overrides given', () => {
    const result = withPrismaExports({ prisma: stubPrisma })
    expect(result.prisma).toBe(stubPrisma)
    expect(result.Prisma).toBe(PRISMA_NAMESPACE)
    expect(result.SubscriptionStatus).toBe(SUBSCRIPTION_STATUS)
    expect(result.BillingInterval).toBe(BILLING_INTERVAL)
    expect(result.InstanceSize).toBe(INSTANCE_SIZE)
    expect(result.PricingModel).toBe(PRICING_MODEL)
    expect(result.InstanceStatus).toBe(INSTANCE_STATUS)
    expect(result.InstanceKind).toBe(INSTANCE_KIND)
  })

  test('honours per-field overrides', () => {
    const customPrisma = { Prisma: { raw: () => 'x' } }
    const customStatus = { active: 'ACTIVE' }
    const result = withPrismaExports({
      prisma: stubPrisma,
      Prisma: customPrisma,
      SubscriptionStatus: customStatus,
    })
    expect(result.Prisma).toBe(customPrisma)
    expect(result.SubscriptionStatus).toBe(customStatus)
    // Non-overridden fields stay default.
    expect(result.BillingInterval).toBe(BILLING_INTERVAL)
  })
})
