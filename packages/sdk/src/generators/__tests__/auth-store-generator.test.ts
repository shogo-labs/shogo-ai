// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  generateAuthStore,
  getUserModel,
  hasUserModel,
  type AuthStoreGeneratorOptions,
} from '../auth-store-generator'
import type { PrismaField, PrismaModel } from '../prisma-generator'

function field(overrides: Partial<PrismaField> & Pick<PrismaField, 'name' | 'type'>): PrismaField {
  return {
    name: overrides.name,
    kind: overrides.kind ?? 'scalar',
    type: overrides.type,
    isRequired: overrides.isRequired ?? true,
    isList: overrides.isList ?? false,
    isId: overrides.isId ?? false,
    isUnique: overrides.isUnique ?? false,
    hasDefaultValue: overrides.hasDefaultValue ?? false,
    relationName: overrides.relationName,
    relationFromFields: overrides.relationFromFields,
  }
}

function model(name: string, fields: PrismaField[]): PrismaModel {
  return { name, fields }
}

const baseUser = model('User', [
  field({ name: 'id', type: 'String', isId: true }),
  field({ name: 'email', type: 'String', isUnique: true }),
  field({ name: 'name', type: 'String', isRequired: false }),
  field({ name: 'createdAt', type: 'DateTime' }),
  field({ name: 'updatedAt', type: 'DateTime' }),
])

describe('generateAuthStore', () => {
  test('generates a MobX auth store using default API base and storage key', () => {
    const code = generateAuthStore({ userModel: baseUser })

    expect(code).toContain("import { makeAutoObservable, runInAction } from 'mobx'")
    expect(code).toContain("const API_BASE = '/api'")
    expect(code).toContain("const STORAGE_KEY = 'shogo-auth-user'")
    expect(code).toContain('email: string')
    expect(code).toContain('name: string | null')
    expect(code).toContain('export class AuthStore')
    expect(code).toContain('export function getAuthStore(): AuthStore')
  })

  test('honors custom storage key and API base', () => {
    const options: AuthStoreGeneratorOptions = {
      userModel: baseUser,
      storageKey: 'custom-auth',
      apiBase: '/internal/api',
    }

    const code = generateAuthStore(options)

    expect(code).toContain("const API_BASE = '/internal/api'")
    expect(code).toContain("const STORAGE_KEY = 'custom-auth'")
    expect(code).toContain('fetch(`${API_BASE}/users?email=${encodeURIComponent(input.email)}`)')
  })

  test('supports alternate email and required display-name fields', () => {
    const account = model('Account', [
      field({ name: 'id', type: 'String', isId: true }),
      field({ name: 'emailAddress', type: 'String', isUnique: true }),
      field({ name: 'displayName', type: 'String', isRequired: true }),
      field({ name: 'createdAt', type: 'DateTime' }),
      field({ name: 'updatedAt', type: 'DateTime' }),
    ])

    const code = generateAuthStore({ userModel: account })

    expect(code).toContain('emailAddress: string')
    expect(code).toContain('displayName: string')
    expect(code).not.toContain('displayName: string | null')
    expect(code).toContain('/accounts?emailAddress=')
  })

  test('detects email fields by String field name containing email', () => {
    const user = model('User', [
      field({ name: 'id', type: 'String', isId: true }),
      field({ name: 'primaryEmail', type: 'String' }),
      field({ name: 'username', type: 'String', isRequired: true }),
    ])

    const code = generateAuthStore({ userModel: user })

    expect(code).toContain('primaryEmail: string')
    expect(code).toContain('username: string')
  })

  test('throws when the user model has no email-like field', () => {
    expect(() => generateAuthStore({
      userModel: model('User', [
        field({ name: 'id', type: 'String', isId: true }),
        field({ name: 'handle', type: 'String' }),
      ]),
    })).toThrow('must have an email field')
  })
})

describe('auth model detection', () => {
  test('hasUserModel returns false when no user/account model exists', () => {
    expect(hasUserModel([model('Post', [field({ name: 'title', type: 'String' })])])).toBe(false)
  })

  test('hasUserModel requires an email-like field', () => {
    expect(hasUserModel([model('User', [field({ name: 'name', type: 'String' })])])).toBe(false)
  })

  test('hasUserModel accepts User, Account, and lowercase user names', () => {
    expect(hasUserModel([baseUser])).toBe(true)
    expect(hasUserModel([model('Account', [field({ name: 'email', type: 'String' })])])).toBe(true)
    expect(hasUserModel([model('user', [field({ name: 'email', type: 'String' })])])).toBe(true)
  })

  test('getUserModel returns the first supported auth model', () => {
    const post = model('Post', [field({ name: 'title', type: 'String' })])
    expect(getUserModel([post, baseUser])).toBe(baseUser)
    expect(getUserModel([post])).toBeUndefined()
  })
})
