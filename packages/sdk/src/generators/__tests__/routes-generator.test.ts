// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Routes Generator Tests
 *
 * Tests that the generated route code properly handles query parameters
 */

import { describe, it, expect } from 'bun:test'
import { generateModelRoutes, generateModelHooks, generateRoutes, generateRoutesIndex } from '../routes-generator'
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
        expect(result!.code).toContain('return c.json({ error: result.error }, 400)')
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

        expect(result!.code).toContain('await prisma.project.findMany({')
        expect(result!.code).toContain('where,')
        expect(result!.code).toContain('include,')
        expect(result!.code).toContain('orderBy,')
      })

      it('should support pagination', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('take: query.limit ? parseInt(query.limit) : undefined,')
        expect(result!.code).toContain('skip: query.offset ? parseInt(query.offset) : undefined,')
      })

      it('should return items in response', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('return c.json({ ok: true, items })')
      })

      it('should include error handling', () => {
        const result = generateModelRoutes(mockProjectModel)

        expect(result!.code).toContain('} catch (error: any) {')
        expect(result!.code).toContain('console.error("[Project] List error:", error)')
        expect(result!.code).toContain('return c.json({ error: { code: "list_failed", message: error.message } }, 500)')
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
        expect(result!.code).toContain('return c.json({ error: { code: "not_found", message: "Project not found" } }, 404)')
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

        expect(result!.code).toContain('return c.json({ ok: true, data: item }, 201)')
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
        expect(result!.code).toContain('return {')
        expect(result!.code).toContain('body: body || {},')
        expect(result!.code).toContain('params: c.req.param() || {},')
        expect(result!.code).toContain('query: Object.fromEntries(new URL(c.req.url).searchParams),')
        expect(result!.code).toContain('userId: c.get("auth")?.userId,')
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
  })
})
