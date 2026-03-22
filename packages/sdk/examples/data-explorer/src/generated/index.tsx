import { Hono } from "hono"
import { PrismaClient } from "./prisma/client"

import { createUserRoutes, setPrisma as setPrismaUser, setUserHooks } from "./user.routes"
import { createDatasetRoutes, setPrisma as setPrismaDataset, setDatasetHooks } from "./dataset.routes"
import { createSavedQueryRoutes, setPrisma as setPrismaSavedQuery, setSavedQueryHooks } from "./savedquery.routes"

import { userHooks } from "./user.hooks"
import { datasetHooks } from "./dataset.hooks"
import { savedQueryHooks } from "./savedquery.hooks"

export function createAllRoutes(prisma: PrismaClient): Hono {
  const app = new Hono()

  setPrismaUser(prisma)
  setPrismaDataset(prisma)
  setPrismaSavedQuery(prisma)

  setUserHooks(userHooks)
  setDatasetHooks(datasetHooks)
  setSavedQueryHooks(savedQueryHooks)

  app.route("/users", createUserRoutes())
  app.route("/datasets", createDatasetRoutes())
  app.route("/saved-queries", createSavedQueryRoutes())

  return app
}

export * from "./user.types"
export * from "./dataset.types"
export * from "./savedquery.types"
