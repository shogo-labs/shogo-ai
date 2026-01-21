/**
 * SqlQueryExecutor Subquery Integration Tests
 *
 * Tests for end-to-end subquery execution with actual SQLite database.
 *
 * @module query/executors/__tests__/sql-subquery.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { SqlBackend } from '../../backends/sql'
import { SqlQueryExecutor } from '../sql'
import { BunSqlExecutor } from '../../execution/bun-sql'
import { parseQuery } from '../../ast/parser'
import type { SchemaModelMetadata } from '../sql'

// ============================================================================
// Test Types
// ============================================================================

interface User {
  id: string
  name: string
  role: string
  organizationId?: string
}

interface Organization {
  id: string
  name: string
  tier: string
}

interface Post {
  id: string
  title: string
  authorId: string
  status: string
}

// ============================================================================
// Test Setup
// ============================================================================

describe('sql-subquery.test.ts - SqlQueryExecutor Subquery Integration', () => {
  let db: Database
  let bunExecutor: BunSqlExecutor
  let postExecutor: SqlQueryExecutor<Post>

  // Schema model metadata for cross-model resolution
  const schemaModels = new Map<string, SchemaModelMetadata>([
    ['User', {
      tableName: 'users',
      columnPropertyMap: { id: 'id', name: 'name', role: 'role', organization_id: 'organizationId' } as Record<string, string>,
      identifierField: 'id'
    }],
    ['Organization', {
      tableName: 'organizations',
      columnPropertyMap: { id: 'id', name: 'name', tier: 'tier' } as Record<string, string>,
      identifierField: 'id'
    }],
    ['Post', {
      tableName: 'posts',
      columnPropertyMap: { id: 'id', title: 'title', author_id: 'authorId', status: 'status' } as Record<string, string>,
      identifierField: 'id'
    }]
  ])

  beforeEach(() => {
    // Create in-memory SQLite database
    db = new Database(':memory:')

    // Create tables
    db.run(`CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT,
      tier TEXT
    )`)

    db.run(`CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT,
      role TEXT,
      organization_id TEXT
    )`)

    db.run(`CREATE TABLE posts (
      id TEXT PRIMARY KEY,
      title TEXT,
      author_id TEXT,
      status TEXT
    )`)

    // Seed test data
    // Organizations
    db.run(`INSERT INTO organizations VALUES ('o1', 'Acme Corp', 'premium')`)
    db.run(`INSERT INTO organizations VALUES ('o2', 'Basic Inc', 'free')`)

    // Users
    db.run(`INSERT INTO users VALUES ('u1', 'Alice', 'admin', 'o1')`)
    db.run(`INSERT INTO users VALUES ('u2', 'Bob', 'viewer', 'o1')`)
    db.run(`INSERT INTO users VALUES ('u3', 'Charlie', 'admin', 'o2')`)
    db.run(`INSERT INTO users VALUES ('u4', 'Diana', 'viewer', 'o2')`)

    // Posts
    db.run(`INSERT INTO posts VALUES ('p1', 'Admin Post 1', 'u1', 'published')`)
    db.run(`INSERT INTO posts VALUES ('p2', 'Viewer Post 1', 'u2', 'published')`)
    db.run(`INSERT INTO posts VALUES ('p3', 'Admin Post 2', 'u3', 'draft')`)
    db.run(`INSERT INTO posts VALUES ('p4', 'Viewer Post 2', 'u4', 'published')`)

    // Create executor
    bunExecutor = new BunSqlExecutor(db)
    const backend = new SqlBackend('sqlite')

    postExecutor = new SqlQueryExecutor<Post>(
      'posts',
      backend,
      bunExecutor,
      { id: 'id', title: 'title', author_id: 'authorId', status: 'status' },
      'sqlite',
      { id: 'string', title: 'string', authorId: 'string', status: 'string' },
      undefined,  // arrayReferences
      schemaModels  // NEW: schema models for subquery resolution
    )
  })

  afterEach(() => {
    db.close()
  })

  // ============================================================================
  // EXECSUB-01: Basic Subquery Select
  // ============================================================================

  describe('EXECSUB-01: Basic subquery select', () => {
    test('Given: subquery filter for admin posts | When: select | Then: returns only admin posts', async () => {
      const ast = parseQuery({
        authorId: {
          $in: {
            $query: {
              model: 'User',
              filter: { role: 'admin' }
            }
          }
        }
      })

      const results = await postExecutor.select(ast as any)

      expect(results).toHaveLength(2)
      expect(results.map(p => p.title).sort()).toEqual(['Admin Post 1', 'Admin Post 2'])
    })

    test('Given: subquery with no matches | When: select | Then: returns empty array', async () => {
      const ast = parseQuery({
        authorId: {
          $in: {
            $query: {
              model: 'User',
              filter: { role: 'superadmin' }  // No superadmins
            }
          }
        }
      })

      const results = await postExecutor.select(ast as any)

      expect(results).toHaveLength(0)
    })
  })

  // ============================================================================
  // EXECSUB-02: Nested Subqueries
  // ============================================================================

  describe('EXECSUB-02: Nested subqueries', () => {
    test('Given: nested subquery (posts by users in premium orgs) | When: select | Then: correct filtering', async () => {
      // Posts by users in premium organizations
      const ast = parseQuery({
        authorId: {
          $in: {
            $query: {
              model: 'User',
              filter: {
                organizationId: {
                  $in: {
                    $query: {
                      model: 'Organization',
                      filter: { tier: 'premium' }
                    }
                  }
                }
              }
            }
          }
        }
      })

      const results = await postExecutor.select(ast as any)

      // Only users u1 and u2 are in premium org o1
      // Their posts are p1 and p2
      expect(results).toHaveLength(2)
      expect(results.map(p => p.title).sort()).toEqual(['Admin Post 1', 'Viewer Post 1'])
    })
  })

  // ============================================================================
  // EXECSUB-03: Combined Conditions
  // ============================================================================

  describe('EXECSUB-03: Combined conditions', () => {
    test('Given: subquery AND regular condition | When: select | Then: both applied', async () => {
      const ast = parseQuery({
        $and: [
          { status: 'published' },
          {
            authorId: {
              $in: {
                $query: {
                  model: 'User',
                  filter: { role: 'admin' }
                }
              }
            }
          }
        ]
      })

      const results = await postExecutor.select(ast as any)

      // Admin posts that are published: only p1 (p3 is draft)
      expect(results).toHaveLength(1)
      expect(results[0].title).toBe('Admin Post 1')
    })
  })

  // ============================================================================
  // EXECSUB-04: Count with Subquery
  // ============================================================================

  describe('EXECSUB-04: Count with subquery', () => {
    test('Given: subquery filter | When: count | Then: returns correct count', async () => {
      const ast = parseQuery({
        authorId: {
          $in: {
            $query: {
              model: 'User',
              filter: { role: 'admin' }
            }
          }
        }
      })

      const count = await postExecutor.count(ast as any)

      expect(count).toBe(2)  // p1 and p3
    })
  })

  // ============================================================================
  // EXECSUB-05: Exists with Subquery
  // ============================================================================

  describe('EXECSUB-05: Exists with subquery', () => {
    test('Given: subquery filter with matches | When: exists | Then: returns true', async () => {
      const ast = parseQuery({
        authorId: {
          $in: {
            $query: {
              model: 'User',
              filter: { role: 'admin' }
            }
          }
        }
      })

      const result = await postExecutor.exists(ast as any)

      expect(result).toBe(true)
    })

    test('Given: subquery filter with no matches | When: exists | Then: returns false', async () => {
      const ast = parseQuery({
        authorId: {
          $in: {
            $query: {
              model: 'User',
              filter: { role: 'superadmin' }
            }
          }
        }
      })

      const result = await postExecutor.exists(ast as any)

      expect(result).toBe(false)
    })
  })

  // ============================================================================
  // EXECSUB-06: $nin Subquery
  // ============================================================================

  describe('EXECSUB-06: $nin subquery', () => {
    test('Given: $nin subquery | When: select | Then: excludes matching posts', async () => {
      // Posts NOT by admins
      const ast = parseQuery({
        authorId: {
          $nin: {
            $query: {
              model: 'User',
              filter: { role: 'admin' }
            }
          }
        }
      })

      const results = await postExecutor.select(ast as any)

      // Non-admin posts: p2 (u2) and p4 (u4)
      expect(results).toHaveLength(2)
      expect(results.map(p => p.title).sort()).toEqual(['Viewer Post 1', 'Viewer Post 2'])
    })
  })
})
