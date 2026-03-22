import { Hono } from "hono"
import { PrismaClient } from "./prisma/client"
import type { SavedQueryHooks } from "./savedquery.hooks"

let prisma: PrismaClient | null = null
let hooks: SavedQueryHooks = {}

export function setPrisma(client: PrismaClient) { prisma = client }
export function setSavedQueryHooks(h: SavedQueryHooks) { hooks = h }

function getPrisma(): PrismaClient {
  if (!prisma) throw new Error("Prisma client not set.")
  return prisma
}

function buildContext(c: any, body?: any) {
  return { body: body || {}, params: c.req.param() || {}, query: Object.fromEntries(new URL(c.req.url).searchParams), userId: c.get("auth")?.userId, prisma: getPrisma() }
}

export function createSavedQueryRoutes(): Hono {
  const router = new Hono()

  router.get("/", async (c) => {
    try {
      const ctx = buildContext(c); const p = getPrisma(); const query = ctx.query
      const reserved = ["limit", "offset", "include", "orderBy"]
      let where: any = {}
      for (const [key, value] of Object.entries(query)) {
        if (!reserved.includes(key) && value !== undefined && value !== null && value !== "") {
          let parsed: any = value; if (value === "true") parsed = true; else if (value === "false") parsed = false; else if (!isNaN(Number(value)) && value !== "") parsed = Number(value)
          where[key] = parsed
        }
      }
      let include: any = undefined
      if (hooks.beforeList) { const r = await hooks.beforeList(ctx); if (r && !r.ok) return c.json({ error: r.error }, 400); if (r?.data) { where = r.data.where || where; include = r.data.include || include } }
      const items = await p.savedQuery.findMany({ where, include, take: query.limit ? parseInt(query.limit) : undefined, skip: query.offset ? parseInt(query.offset) : undefined })
      return c.json({ ok: true, items })
    } catch (error: any) { return c.json({ error: { code: "list_failed", message: error.message } }, 500) }
  })

  router.get("/:id", async (c) => {
    try {
      const id = c.req.param("id"); const p = getPrisma(); const ctx = buildContext(c)
      if (hooks.beforeGet) { const r = await hooks.beforeGet(id, ctx); if (r && !r.ok) return c.json({ error: r.error }, 400) }
      const item = await p.savedQuery.findUnique({ where: { id } })
      if (!item) return c.json({ error: { code: "not_found", message: "SavedQuery not found" } }, 404)
      return c.json({ ok: true, data: item })
    } catch (error: any) { return c.json({ error: { code: "get_failed", message: error.message } }, 500) }
  })

  router.post("/", async (c) => {
    try {
      let body = await c.req.json(); const ctx = buildContext(c, body); const p = getPrisma()
      if (hooks.beforeCreate) { const r = await hooks.beforeCreate(body, ctx); if (r && !r.ok) return c.json({ error: r.error }, 400); if (r?.data) body = r.data }
      const item = await p.savedQuery.create({ data: body })
      if (hooks.afterCreate) await hooks.afterCreate(item, ctx)
      return c.json({ ok: true, data: item }, 201)
    } catch (error: any) { return c.json({ error: { code: "create_failed", message: error.message } }, 500) }
  })

  router.patch("/:id", async (c) => {
    try {
      const id = c.req.param("id"); let body = await c.req.json(); const ctx = buildContext(c, body); const p = getPrisma()
      if (hooks.beforeUpdate) { const r = await hooks.beforeUpdate(id, body, ctx); if (r && !r.ok) return c.json({ error: r.error }, 400); if (r?.data) body = r.data }
      const item = await p.savedQuery.update({ where: { id }, data: body })
      if (hooks.afterUpdate) await hooks.afterUpdate(item, ctx)
      return c.json({ ok: true, data: item })
    } catch (error: any) { return c.json({ error: { code: "update_failed", message: error.message } }, 500) }
  })

  router.delete("/:id", async (c) => {
    try {
      const id = c.req.param("id"); const ctx = buildContext(c); const p = getPrisma()
      if (hooks.beforeDelete) { const r = await hooks.beforeDelete(id, ctx); if (r && !r.ok) return c.json({ error: r.error }, 400) }
      await p.savedQuery.delete({ where: { id } })
      if (hooks.afterDelete) await hooks.afterDelete(id, ctx)
      return c.json({ ok: true })
    } catch (error: any) { return c.json({ error: { code: "delete_failed", message: error.message } }, 500) }
  })

  return router
}
