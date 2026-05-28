// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Routes Generator Tests
 *
 * Tests that the generated route code properly handles query parameters
 */

import { describe, it, expect } from 'bun:test'
import { generateModelRoutes, generateModelHooks, generateRoutes, generateRoutesIndex } from '../routes-generator'
import { generateAdminRoutes } from '../admin-routes-generator'
import type { PrismaModel } from '../prisma-generator'

// ============================================================================
// Test Fixtures
// ============================================================================

const mockProjectModel: PrismaModel = {
  name: 'Project',
  dbName: null,
  fields: [
    { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: true, hasDefaultValue: true },
    { name: 'name', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    { name: 'workspaceId', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    { name: 'status', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    { name: 'completed', kind: 'scalar', type: 'Boolean', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    { name: 'priority', kind: 'scalar', type: 'Int', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    { name: 'createdAt', kind: 'scalar', type: 'DateTime', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: true },
  ],
}

const mockWorkspaceModel: PrismaModel = {
  name: 'Workspace',
  dbName: null,
  fields: [
    { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: true, hasDefaultValue: true },
    { name: 'name', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
  ],
}

// ============================================================================
// Tests
// ============================================================================

describe('Routes Generator', () => {
  describe('generateModelRoutes', () => {
    it('should generate route file with correct structure', () => {
      const result = generateModelRoutes(mockProjectModel)

      expect(result).not.toBeNull()
      expect(result!.modelName).toBe('Project')
      expect(result!.fileName).toBe('project.routes.tsx')
      expect(result!.code).toContain('export function createProjectRoutes(): Hono')
    })

    it('should include SPDX license header', () => {
      const result = generateModelRoutes(mockProjectModel)

      expect(result!.code).toStartWith('// SPDX-License-Identifier: MIT\n// Copyright (C) 2026 Shogo Technologies, Inc.\n')
    })

    it('should import required dependencies', () => {
      const result = generateModelRoutes(mockProjectModel)

      expect(result!.code).toContain('import { Hono } from "hono"')
      expect(result!.code).toContain('import { PrismaClient } from "./prisma/client"')
      expect(result!.code).toContain('import type { ProjectHooks } from "./project.hooks"')
    })

    it('should generate setPrisma function', () => {
      const result = generateModelRoutes(mockProjectModel)

      expect(result!.code).toContain('export function setPrisma(client: PrismaClient)')
      expect(result!.code).toContain('prisma = client')
    })

    it('should generate hooks setter', () => {
      const result = generateModelRoutes(mockProjectModel)

      expect(result!.code).toContain('export function setProjectHooks(h: ProjectHooks)')
      expect(result!.code).toContain('hooks = h')
    })

    describe('LIST route', () => {
      it('should generate GET / route', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('// GET / - List all')
        expect(result!.code).toContain('router.get("/", async (c) => {')
      })

      it('should extract query parameters', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('const ctx = buildContext(c)')
        expect(result!.code).toContain('const query = ctx.query')
      })

      it('should define reserved parameters', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('const reservedParams = ["limit", "offset", "userId", "include", "orderBy"]')
      })

      it('should build where clause from query params', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('// Build initial where from query params')
        expect(result!.code).toContain('let where: any = {}')
        expect(result!.code).toContain('for (const [key, value] of Object.entries(query)) {')
        expect(result!.code).toContain('if (!reservedParams.includes(key) && value !== undefined && value !== null && value !== "") {')
      })

      it('should parse boolean values', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('if (value === "true") parsedValue = true')
        expect(result!.code).toContain('else if (value === "false") parsedValue = false')
      })

      it('should parse numeric values', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('else if (!isNaN(Number(value)) && value !== "") parsedValue = Number(value)')
      })

      it('should assign parsed value to where clause', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('where[key] = parsedValue')
      })

      it('should support beforeList hook', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('// Apply beforeList hook (can override where/include/orderBy)')
        expect(result!.code).toContain('if (hooks.beforeList) {')
        expect(result!.code).toContain('const result = await hooks.beforeList(ctx)')
        expect(result!.code).toContain('if (result && !result.ok) {')
        expect(result!.code).toContain('return sendJson(c, { error: result.error }, 400)')
      })

      it('should allow hook to override where clause', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('if (result?.data) {')
        expect(result!.code).toContain('where = result.data.where || where')
        expect(result!.code).toContain('include = result.data.include || include')
        expect(result!.code).toContain('orderBy = result.data.orderBy || orderBy')
      })

      it('should pass where to Prisma findMany', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('prisma.project.findMany({')
        expect(result!.code).toContain('where,')
        expect(result!.code).toContain('include,')
        expect(result!.code).toContain('orderBy,')
      })

      it('should support pagination', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('take: query.limit ? parseInt(query.limit) : undefined,')
        expect(result!.code).toContain('skip: query.offset ? parseInt(query.offset) : undefined,')
      })

      it('should return items and total in response', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('return sendJson(c, { ok: true, items, total })')
      })

      it('should include error handling', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('} catch (error: any) {')
        expect(result!.code).toContain('console.error("[Project] List error:", error)')
        expect(result!.code).toContain('return sendJson(c, { error: { code: "list_failed", message: error.message } }, 500)')
      })
    })

    describe('GET route', () => {
      it('should generate GET /:id route', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('// GET /:id - Get by ID')
        expect(result!.code).toContain('router.get("/:id", async (c) => {')
        expect(result!.code).toContain('const id = c.req.param("id")')
      })

      it('should support beforeGet hook', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('if (hooks.beforeGet) {')
        expect(result!.code).toContain('const result = await hooks.beforeGet(id, ctx)')
      })

      it('should handle not found', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('if (!item) {')
        expect(result!.code).toContain('return sendJson(c, { error: { code: "not_found", message: "Project not found" } }, 404)')
      })
    })

    describe('CREATE route', () => {
      it('should generate POST / route', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('// POST / - Create')
        expect(result!.code).toContain('router.post("/", async (c) => {')
      })

      it('should support beforeCreate hook', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('if (hooks.beforeCreate) {')
        expect(result!.code).toContain('const result = await hooks.beforeCreate(body, ctx)')
      })

      it('should support afterCreate hook', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('if (hooks.afterCreate) {')
        expect(result!.code).toContain('await hooks.afterCreate(item, ctx)')
      })

      it('should return 201 status', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('return sendJson(c, { ok: true, data: item }, 201)')
      })

      it('should pass picked.data to Prisma create (not raw body)', () => {
        // pickWritableFields(body) is the safety net that prevents
        // relation-as-scalar bugs and unknown-key passthrough — the create
        // route MUST pipe through it instead of forwarding `body` raw.
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('const picked = pickWritableFields(body)')
        expect(result!.code).toContain('if (!picked.ok) {')
        expect(result!.code).toContain('return sendJson(c, { error: picked.error }, 400)')
        expect(result!.code).toContain('prisma.project.create({')
        expect(result!.code).toContain('data: picked.data,')
        // Must NOT forward the raw body — that would re-introduce the bug.
        expect(result!.code).not.toContain('prisma.project.create({\n        data: body,')
      })
    })

    describe('UPDATE route', () => {
      it('should generate PATCH /:id route', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('// PATCH /:id - Update')
        expect(result!.code).toContain('router.patch("/:id", async (c) => {')
      })

      it('should support beforeUpdate hook', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('if (hooks.beforeUpdate) {')
        expect(result!.code).toContain('const result = await hooks.beforeUpdate(id, body, ctx)')
      })

      it('should support afterUpdate hook', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('if (hooks.afterUpdate) {')
        expect(result!.code).toContain('await hooks.afterUpdate(item, ctx)')
      })

      it('should pass picked.data to Prisma update (not raw body)', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('prisma.project.update({')
        // Both the where clause and the (filtered) data block:
        expect(result!.code).toMatch(/prisma\.project\.update\(\{[\s\S]*?where: \{ id \},[\s\S]*?data: picked\.data,/)
      })
    })

    describe('DELETE route', () => {
      it('should generate DELETE /:id route', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('// DELETE /:id - Delete')
        expect(result!.code).toContain('router.delete("/:id", async (c) => {')
      })

      it('should support beforeDelete hook', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('if (hooks.beforeDelete) {')
        expect(result!.code).toContain('const result = await hooks.beforeDelete(id, ctx)')
      })

      it('should support afterDelete hook', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('if (hooks.afterDelete) {')
        expect(result!.code).toContain('await hooks.afterDelete(id, ctx)')
      })
    })

    describe('buildContext helper', () => {
      it('should generate buildContext function', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('function buildContext(c: any, body?: any) {')
        expect(result!.code).toContain('const auth = c.get("auth")')
        expect(result!.code).toContain('return {')
        expect(result!.code).toContain('body: body || {},')
        expect(result!.code).toContain('params: c.req.param() || {},')
        expect(result!.code).toContain('query: Object.fromEntries(new URL(c.req.url).searchParams),')
        expect(result!.code).toContain('userId: auth?.userId,')
        expect(result!.code).toContain('tunnelAuthenticated: !!auth?.tunnelAuthenticated,')
        expect(result!.code).toContain('prisma: getPrisma(),')
      })
    })

    it('should return null for models without @id field', () => {
      const modelWithoutId: PrismaModel = {
        name: 'Invalid',
        dbName: null,
        fields: [
          { name: 'name', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
        ],
      }

      const result = generateModelRoutes(modelWithoutId)
      expect(result).toBeNull()
    })
  })

  describe('generateModelHooks', () => {
    it('should generate hooks file with correct structure', () => {
      const result = generateModelHooks(mockProjectModel)

      expect(result.modelName).toBe('Project')
      expect(result.fileName).toBe('project.hooks.tsx')
      expect(result.code).toContain('export interface ProjectHooks')
    })

    it('should include SPDX license header', () => {
      const result = generateModelHooks(mockProjectModel)

      expect(result.code).toStartWith('// SPDX-License-Identifier: MIT\n// Copyright (C) 2026 Shogo Technologies, Inc.\n')
    })

    it('should define HookResult interface', () => {
      const result = generateModelHooks(mockProjectModel)

      expect(result.code).toContain('export interface HookResult<T = any>')
      expect(result.code).toContain('ok: boolean')
      expect(result.code).toContain('error?: { code: string; message: string }')
      expect(result.code).toContain('data?: T')
    })

    it('should define HookContext interface', () => {
      const result = generateModelHooks(mockProjectModel)

      expect(result.code).toContain('export interface HookContext')
      expect(result.code).toContain('body: any')
      expect(result.code).toContain('params: Record<string, string>')
      expect(result.code).toContain('query: Record<string, string>')
      expect(result.code).toContain('userId?: string')
      expect(result.code).toContain('tunnelAuthenticated: boolean')
      expect(result.code).toContain('prisma: any')
    })

    it('should document beforeList hook with query param info', () => {
      const result = generateModelHooks(mockProjectModel)

      expect(result.code).toContain('/**')
      expect(result.code).toContain('* Called before listing records. Can modify where/include/orderBy.')
      expect(result.code).toContain('* Note: Query parameters (except limit, offset, userId, include, orderBy) are automatically')
      expect(result.code).toContain('* added to the where clause. This hook receives them and can override/extend them.')
      expect(result.code).toContain('*/')
      expect(result.code).toContain('beforeList?: (ctx: HookContext) => Promise<HookResult<{ where?: any; include?: any; orderBy?: any }> | void>')
    })

    it('should define all hook methods', () => {
      const result = generateModelHooks(mockProjectModel)

      expect(result.code).toContain('beforeList?:')
      expect(result.code).toContain('beforeGet?:')
      expect(result.code).toContain('beforeCreate?:')
      expect(result.code).toContain('afterCreate?:')
      expect(result.code).toContain('beforeUpdate?:')
      expect(result.code).toContain('afterUpdate?:')
      expect(result.code).toContain('beforeDelete?:')
      expect(result.code).toContain('afterDelete?:')
    })

    it('should export default hooks implementation', () => {
      const result = generateModelHooks(mockProjectModel)

      expect(result.code).toContain('export const projectHooks: ProjectHooks = {')
    })

    it('should include commented examples with query param usage', () => {
      const result = generateModelHooks(mockProjectModel)

      expect(result.code).toContain('// Query params are automatically added to where clause')
      expect(result.code).toContain('// Example: GET /api/projects?workspaceId=123 => where: { workspaceId: "123" }')
    })
  })

  describe('generateRoutes', () => {
    it('should generate routes for all models', () => {
      const result = generateRoutes([mockWorkspaceModel, mockProjectModel])

      expect(result.routes.length).toBe(2)
      expect(result.hooks.length).toBe(2)
      expect(result.routes[0].modelName).toBe('Workspace')
      expect(result.routes[1].modelName).toBe('Project')
    })

    it('should skip models without @id field', () => {
      const modelWithoutId: PrismaModel = {
        name: 'Invalid',
        dbName: null,
        fields: [
          { name: 'name', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
        ],
      }

      const result = generateRoutes([mockProjectModel, modelWithoutId])

      expect(result.routes.length).toBe(1)
      expect(result.hooks.length).toBe(1)
    })
  })

  describe('generateRoutesIndex', () => {
    it('should include SPDX license header', () => {
      const code = generateRoutesIndex([mockWorkspaceModel, mockProjectModel])

      expect(code).toStartWith('// SPDX-License-Identifier: MIT\n// Copyright (C) 2026 Shogo Technologies, Inc.\n')
    })

    it('should generate index file with imports', () => {
      const code = generateRoutesIndex([mockWorkspaceModel, mockProjectModel])

      expect(code).toContain('import { createWorkspaceRoutes, setPrisma as setPrismaWorkspace, setWorkspaceHooks } from "./workspace.routes"')
      expect(code).toContain('import { createProjectRoutes, setPrisma as setPrismaProject, setProjectHooks } from "./project.routes"')
      expect(code).toContain('import { workspaceHooks } from "./workspace.hooks"')
      expect(code).toContain('import { projectHooks } from "./project.hooks"')
    })

    it('should generate createAllRoutes function', () => {
      const code = generateRoutesIndex([mockWorkspaceModel, mockProjectModel])

      expect(code).toContain('export function createAllRoutes(prisma: PrismaClient): Hono')
      expect(code).toContain('const app = new Hono()')
      expect(code).toContain('setPrismaWorkspace(prisma)')
      expect(code).toContain('setPrismaProject(prisma)')
      expect(code).toContain('setWorkspaceHooks(workspaceHooks)')
      expect(code).toContain('setProjectHooks(projectHooks)')
    })

    it('should mount routes with correct paths', () => {
      const code = generateRoutesIndex([mockWorkspaceModel, mockProjectModel])

      expect(code).toContain('app.route("/workspaces", createWorkspaceRoutes())')
      expect(code).toContain('app.route("/projects", createProjectRoutes())')
    })

    it('should export route creators', () => {
      const code = generateRoutesIndex([mockWorkspaceModel])

      expect(code).toContain('export {')
      expect(code).toContain('createWorkspaceRoutes')
      expect(code).toContain('setPrismaWorkspace')
      expect(code).toContain('setWorkspaceHooks')
    })

    it('should export hooks', () => {
      const code = generateRoutesIndex([mockWorkspaceModel])

      expect(code).toContain('export {')
      expect(code).toContain('workspaceHooks')
    })

    it('should export hook types', () => {
      const code = generateRoutesIndex([mockWorkspaceModel])

      expect(code).toContain('export type { WorkspaceHooks } from "./workspace.hooks"')
    })

    describe('toRoutePath pluralization (-es suffix branch)', () => {
      // Covers the second pluralization arm in toRoutePath():
      //   names ending in s, x, ch, or sh get '+es' instead of '+s'.
      // All baseline mocks (Project, Workspace) hit the default '+s' arm, so
      // line 54 — the `return kebab + 'es'` — was the only residual gap.
      const idField = { name: 'id', kind: 'scalar' as const, type: 'String', isRequired: true, isList: false, isId: true, isUnique: true, hasDefaultValue: true }
      const mk = (name: string): PrismaModel => ({ name, dbName: null, fields: [idField] })

      it('appends "es" to a model name ending in "s"', () => {
        const code = generateRoutesIndex([mk('Class')])
        expect(code).toContain('app.route("/classes", createClassRoutes())')
      })

      it('appends "es" to a model name ending in "x"', () => {
        const code = generateRoutesIndex([mk('Box')])
        expect(code).toContain('app.route("/boxes", createBoxRoutes())')
      })

      it('appends "es" to a model name ending in "ch"', () => {
        const code = generateRoutesIndex([mk('Match')])
        expect(code).toContain('app.route("/matches", createMatchRoutes())')
      })

      it('appends "es" to a model name ending in "sh"', () => {
        const code = generateRoutesIndex([mk('Dish')])
        expect(code).toContain('app.route("/dishes", createDishRoutes())')
      })
    })
  })

  describe('generateAdminRoutes', () => {
    it('should include SPDX license header', () => {
      const result = generateAdminRoutes([mockProjectModel, mockWorkspaceModel])

      expect(result.code).toStartWith('// SPDX-License-Identifier: MIT\n// Copyright (C) 2026 Shogo Technologies, Inc.\n')
    })

    it('should generate admin-routes file', () => {
      const result = generateAdminRoutes([mockProjectModel, mockWorkspaceModel])

      expect(result.fileName).toBe('admin-routes.ts')
      expect(result.code).toContain('export function createAdminRoutes(config: AdminRoutesConfig): Hono')
    })

    it('should emit a POST create route per model', () => {
      const result = generateAdminRoutes([mockProjectModel, mockWorkspaceModel])

      expect(result.code).toContain('router.post("/projects"')
      expect(result.code).toContain('router.post("/workspaces"')
      expect(result.code).toContain('prisma.project.create({')
      expect(result.code).toContain('prisma.workspace.create({')
      expect(result.code).toContain('return sendJson(c, { ok: true, data: item }, 201)')
    })

    it('should emit a BigInt-safe sendJson helper', () => {
      const result = generateAdminRoutes([mockProjectModel, mockWorkspaceModel])

      // The helper coerces native BigInt values to strings so Hono\'s default
      // JSON.stringify path (which throws on bare BigInts) does not 500 on
      // responses that include columns like StorageUsage.totalBytes.
      expect(result.code).toContain('const bigIntReplacer = (_key: string, value: unknown) =>')
      expect(result.code).toContain('typeof value === "bigint" ? value.toString() : value')
      expect(result.code).toContain('function sendJson(c: any, body: unknown, status: number = 200) {')
      expect(result.code).toContain('c.body(JSON.stringify(body, bigIntReplacer), status,')
      // And no raw c.json call sites should leak through.
      expect(result.code).not.toContain('return c.json(')
    })
  })

  describe('generateAdminRoutes gap coverage', () => {
    const ClassModel: PrismaModel = {
      name: 'Class',
      dbName: null,
      fields: [
        { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: true, hasDefaultValue: true },
        { name: 'title', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
      ],
    }

    const BoxModel: PrismaModel = {
      name: 'Box',
      dbName: null,
      fields: [
        { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: true, hasDefaultValue: true },
      ],
    }

    const ParentModel: PrismaModel = {
      name: 'Parent',
      dbName: null,
      fields: [
        { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: true, hasDefaultValue: true },
        { name: 'name', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
        { name: 'owner', kind: 'object', type: 'User', isRequired: false, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
        { name: 'children', kind: 'object', type: 'Child', isRequired: false, isList: true, isId: false, isUnique: false, hasDefaultValue: false },
      ],
    }

    it('DA:47 — toRoutePath adds -es for model names ending in s/x/ch/sh', () => {
      const r = generateAdminRoutes([ClassModel, BoxModel])
      expect(r.code).toContain('router.post("/classes"')
      expect(r.code).toContain('router.post("/boxes"')
      expect(r.code).toContain('router.get("/classes"')
      expect(r.code).toContain('router.get("/boxes"')
    })

    it('DA:197 — emits empty where clause when model has no searchable string fields', () => {
      const r = generateAdminRoutes([BoxModel])
      expect(r.code).toContain('const where: any = {}')
    })

    it('DA:224-226 — emits _count include in LIST when model has list-type relations', () => {
      const r = generateAdminRoutes([ParentModel])
      expect(r.code).toContain('_count: { select: {')
      expect(r.code).toContain('children: true')
    })

    it('DA:269-279 — emits hasRelations include in GET when model has any relations', () => {
      const r = generateAdminRoutes([ParentModel])
      // single relation included as `true`
      expect(r.code).toContain('owner: true,')
      // list relation included with take limit
      expect(r.code).toContain('children: { take: 50 },')
      // findUnique with include block, not the no-relations branch
      expect(r.code).toMatch(/findUnique\({\s*[^}]*where:\s*\{ id \},\s*include:/)
    })
  })

  describe('generateModelRoutes BigInt safety', () => {
    it('should emit a BigInt-safe sendJson helper in per-model routes', () => {
      const result = generateModelRoutes(mockProjectModel)

      expect(result!.code).toContain('const bigIntReplacer = (_key: string, value: unknown) =>')
      expect(result!.code).toContain('function sendJson(c: any, body: unknown, status: number = 200) {')
      expect(result!.code).not.toContain('return c.json(')
    })
  })

  // ---------------------------------------------------------------------------
  // pickWritableFields: the runtime payload-safety helper embedded in every
  // generated route file. We assert both the code-gen shape (allowlist arrays
  // and helper definition) and the runtime semantics (by evaluating the helper
  // in isolation against representative bodies).
  // ---------------------------------------------------------------------------
  describe('pickWritableFields', () => {
    // A model with one of every relevant flavor: id-with-default,
    // required scalar, optional scalar, scalar with default, FK scalar
    // (relationFromFields), to-many relation, and to-one relation.
    const HireModel: PrismaModel = {
      name: 'Hire',
      dbName: null,
      fields: [
        { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: true, hasDefaultValue: true },
        { name: 'name', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
        { name: 'role', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
        { name: 'createdAt', kind: 'scalar', type: 'DateTime', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: true },
        { name: 'departmentId', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
        { name: 'department', kind: 'object', type: 'Department', isRequired: false, isList: false, isId: false, isUnique: false, hasDefaultValue: false, relationName: 'DepartmentToHire', relationFromFields: ['departmentId'] },
        { name: 'scorecards', kind: 'object', type: 'InterviewScorecard', isRequired: false, isList: true, isId: false, isUnique: false, hasDefaultValue: false, relationName: 'HireToInterviewScorecard' },
      ],
    }

    // A model whose id has no default — the client must provide it on create,
    // so the id field MUST be in the writable allowlist.
    const ManualIdModel: PrismaModel = {
      name: 'Country',
      dbName: null,
      fields: [
        { name: 'code', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: true, hasDefaultValue: false },
        { name: 'name', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
      ],
    }

    it('emits an allowlist of scalar/enum field names (id with default excluded)', () => {
      const result = generateModelRoutes(HireModel)
      // `id` has a default → should not appear in the writable scalar list.
      expect(result!.code).toContain('const WRITABLE_SCALAR_FIELDS = ["name", "role", "createdAt", "departmentId"] as const')
    })

    it('includes id in the writable list when it has no default', () => {
      const result = generateModelRoutes(ManualIdModel)
      expect(result!.code).toContain('const WRITABLE_SCALAR_FIELDS = ["code", "name"] as const')
    })

    it('emits an allowlist of relation field names (object kind only)', () => {
      const result = generateModelRoutes(HireModel)
      expect(result!.code).toContain('const RELATION_FIELDS = ["department", "scorecards"] as const')
    })

    it('emits empty allowlists as `[] as const` for models without relations', () => {
      // mockWorkspaceModel has only id + name, no relations.
      const result = generateModelRoutes(mockWorkspaceModel)
      expect(result!.code).toContain('const RELATION_FIELDS = [] as const')
    })

    // ---- Runtime semantics ---------------------------------------------------
    // Extract `pickWritableFields` from the generated source and evaluate it
    // in a sandbox so we can assert behavior against real bodies. The function
    // is dependency-free (only references its own constants) so this is safe.

    function extractPickWritableFields(source: string): (body: unknown) => any {
      const matchHelper = source.match(/function pickWritableFields\(body: any\): WriteBodyResult \{[\s\S]*?\n\}/)
      if (!matchHelper) throw new Error('pickWritableFields not found in generated source')
      const matchScalars = source.match(/const WRITABLE_SCALAR_FIELDS = (\[[^\]]*\] as const)/)
      const matchRelations = source.match(/const RELATION_FIELDS = (\[[^\]]*\] as const)/)
      if (!matchScalars || !matchRelations) throw new Error('field allowlists not found in generated source')

      // Strip the few TS annotations we know the helper uses so plain JS eval
      // works. Order matters: strip `: any` LAST so `: any[]` doesn't get
      // mangled (it isn't used today, but defensive).
      const helperJs = matchHelper[0]
        .replace(/: WriteBodyResult/g, '')
        .replace(/: Record<string, unknown>/g, '')
        .replace(/\(body: any\)/g, '(body)')
      const scalarsJs = matchScalars[1].replace(' as const', '')
      const relationsJs = matchRelations[1].replace(' as const', '')

      const factory = new Function(
        `const WRITABLE_SCALAR_FIELDS = ${scalarsJs};
         const RELATION_FIELDS = ${relationsJs};
         ${helperJs}
         return pickWritableFields;`,
      )
      return factory()
    }

    it('runtime: returns 400 on non-object bodies', () => {
      const pick = extractPickWritableFields(generateModelRoutes(HireModel)!.code)
      expect(pick(null)).toMatchObject({ ok: false, error: { code: 'invalid_body' } })
      expect(pick('hello')).toMatchObject({ ok: false, error: { code: 'invalid_body' } })
      expect(pick([1, 2, 3])).toMatchObject({ ok: false, error: { code: 'invalid_body' } })
    })

    it('runtime: passes scalar fields through unchanged', () => {
      const pick = extractPickWritableFields(generateModelRoutes(HireModel)!.code)
      const r = pick({ name: 'Alice', role: 'Eng', departmentId: 'dept-1' })
      expect(r).toEqual({ ok: true, data: { name: 'Alice', role: 'Eng', departmentId: 'dept-1' } })
    })

    it('runtime: drops id-with-default and unknown keys silently', () => {
      const pick = extractPickWritableFields(generateModelRoutes(HireModel)!.code)
      const r = pick({ id: 'forged', name: 'Alice', __injected: 'evil', extraField: 42 })
      expect(r).toEqual({ ok: true, data: { name: 'Alice' } })
    })

    it('runtime: rejects relation-as-scalar (the original MiMo bug)', () => {
      const pick = extractPickWritableFields(generateModelRoutes(HireModel)!.code)
      // `scorecards: 1` was the exact shape that crashed Prisma in the
      // MiMo eval run: "Argument scorecards: ... provided Int."
      const r = pick({ name: 'Alice', role: 'Eng', departmentId: 'd', scorecards: 1 })
      expect(r).toMatchObject({
        ok: false,
        error: {
          code: 'invalid_relation_shape',
        },
      })
      expect(r.error.message).toContain('"scorecards"')
      expect(r.error.message).toContain('connect')
    })

    it('runtime: rejects relation-as-array-of-scalars', () => {
      const pick = extractPickWritableFields(generateModelRoutes(HireModel)!.code)
      const r = pick({ name: 'Alice', role: 'Eng', departmentId: 'd', scorecards: [1, 2] })
      expect(r).toMatchObject({ ok: false, error: { code: 'invalid_relation_shape' } })
    })

    it('runtime: accepts relation-as-{connect}', () => {
      const pick = extractPickWritableFields(generateModelRoutes(HireModel)!.code)
      const r = pick({
        name: 'Alice',
        role: 'Eng',
        departmentId: 'd',
        scorecards: { connect: [{ id: 's1' }, { id: 's2' }] },
      })
      expect(r).toEqual({
        ok: true,
        data: {
          name: 'Alice',
          role: 'Eng',
          departmentId: 'd',
          scorecards: { connect: [{ id: 's1' }, { id: 's2' }] },
        },
      })
    })

    it('runtime: accepts relation-as-{create}', () => {
      const pick = extractPickWritableFields(generateModelRoutes(HireModel)!.code)
      const r = pick({
        name: 'Alice',
        role: 'Eng',
        departmentId: 'd',
        department: { create: { name: 'Engineering' } },
      })
      expect(r.ok).toBe(true)
      expect(r.data.department).toEqual({ create: { name: 'Engineering' } })
    })

    it('runtime: skips relation when value is undefined or null', () => {
      const pick = extractPickWritableFields(generateModelRoutes(HireModel)!.code)
      const r1 = pick({ name: 'Alice', role: 'Eng', departmentId: 'd', scorecards: undefined })
      expect(r1).toEqual({ ok: true, data: { name: 'Alice', role: 'Eng', departmentId: 'd' } })
      const r2 = pick({ name: 'Alice', role: 'Eng', departmentId: 'd', scorecards: null })
      expect(r2).toEqual({ ok: true, data: { name: 'Alice', role: 'Eng', departmentId: 'd' } })
    })

    it('runtime: relation FK scalar is still writable (departmentId on Hire)', () => {
      // The scalar `departmentId` is the FK that backs the `department`
      // relation. Clients that don't want to use Prisma's nested-write
      // shape can still set it directly — that path is what most simple
      // generated UIs will use.
      const pick = extractPickWritableFields(generateModelRoutes(HireModel)!.code)
      const r = pick({ name: 'Alice', role: 'Eng', departmentId: 'dept-42' })
      expect(r).toEqual({ ok: true, data: { name: 'Alice', role: 'Eng', departmentId: 'dept-42' } })
    })
  })
})
