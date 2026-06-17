// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Tests for the static-vs-server-backed publish heuristic. This decides
// whether a published app gets a running server.tsx pod (so /api/* works) or
// ships as a static export — the wrong call either strands a data-driven app
// (the original "Could not find [name]" bug) or wastes a pod on a static site.

import { describe, expect, test } from 'bun:test'
import {
  evaluateServerBacked,
  schemaHasModels,
  hasRegisteredRoutes,
} from '../published-detect'

const SCHEMA_WITH_MODEL = `
generator client {
  provider = "prisma-client"
}

datasource db {
  provider = "sqlite"
}

model Guest {
  id   String @id @default(cuid())
  name String
}
`

const SCHEMA_NO_MODEL = `
generator client {
  provider = "prisma-client"
}

datasource db {
  provider = "sqlite"
}
`

const ROUTES_WITH_HANDLER = `
import { app } from './server'
app.get('/api/collab/by-name/:name', async (c) => c.json({ ok: true }))
`

const ROUTES_EMPTY = `
// no routes registered yet
export {}
`

describe('schemaHasModels', () => {
  test('true when a model is declared', () => {
    expect(schemaHasModels(SCHEMA_WITH_MODEL)).toBe(true)
  })
  test('false for a schema with only generator/datasource', () => {
    expect(schemaHasModels(SCHEMA_NO_MODEL)).toBe(false)
  })
  test('false for null / missing schema', () => {
    expect(schemaHasModels(null)).toBe(false)
  })
  test('does not match the word "model" in a comment', () => {
    expect(schemaHasModels('// our data model lives elsewhere\n')).toBe(false)
  })
})

describe('hasRegisteredRoutes', () => {
  test('true when a route handler is registered', () => {
    expect(hasRegisteredRoutes(ROUTES_WITH_HANDLER)).toBe(true)
  })
  test('matches app.post / app.use too', () => {
    expect(hasRegisteredRoutes(`app.post('/x', h)`)).toBe(true)
    expect(hasRegisteredRoutes(`app.use('*', mw)`)).toBe(true)
  })
  test('false for an empty custom-routes file', () => {
    expect(hasRegisteredRoutes(ROUTES_EMPTY)).toBe(false)
  })
  test('false for null', () => {
    expect(hasRegisteredRoutes(null)).toBe(false)
  })
})

describe('evaluateServerBacked', () => {
  test('a data-driven app (has models) is server-backed', () => {
    const r = evaluateServerBacked({
      schemaSource: SCHEMA_WITH_MODEL,
      customRoutesSource: null,
      hasServerFile: true,
    })
    expect(r.serverBacked).toBe(true)
    expect(r.hasModels).toBe(true)
  })

  test('an app with custom routes (no models) is server-backed', () => {
    const r = evaluateServerBacked({
      schemaSource: SCHEMA_NO_MODEL,
      customRoutesSource: ROUTES_WITH_HANDLER,
      hasServerFile: true,
    })
    expect(r.serverBacked).toBe(true)
    expect(r.hasCustomRoutes).toBe(true)
  })

  test('a purely static app (server.tsx present but no models/routes) is NOT server-backed', () => {
    const r = evaluateServerBacked({
      schemaSource: SCHEMA_NO_MODEL,
      customRoutesSource: ROUTES_EMPTY,
      hasServerFile: true, // template always ships server.tsx — not a signal
    })
    expect(r.serverBacked).toBe(false)
    expect(r.hasServerFile).toBe(true)
  })

  test('an app with no schema and no routes is NOT server-backed', () => {
    const r = evaluateServerBacked({
      schemaSource: null,
      customRoutesSource: null,
      hasServerFile: false,
    })
    expect(r.serverBacked).toBe(false)
  })
})
