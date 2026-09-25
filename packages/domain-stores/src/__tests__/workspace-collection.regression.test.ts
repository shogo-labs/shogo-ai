// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { expect, test } from "bun:test"
import { WorkspaceCollection } from "../workspace.collection"

const personal = {
  id: "ws-personal",
  name: "Personal",
  kind: "personal",
  slug: "personal",
  updatedAt: 1,
}

const team = {
  id: "ws-team",
  name: "Team",
  kind: "team",
  slug: "team",
  updatedAt: 1,
}

function makeCollection(get: (url: string) => Promise<unknown>) {
  return WorkspaceCollection.create(
    { items: {} },
    { http: { get } } as never,
  )
}

test("filtered workspace reloads do not prune the active team", async () => {
  const collection = makeCollection(async (url) => ({
    data: {
      ok: true,
      items: url.includes("userId=") ? [personal] : [personal, team],
    },
  }))

  await collection.loadAll()
  await collection.loadAll({ userId: "user-1" })

  expect(collection.all.map((workspace) => workspace.id)).toEqual([
    "ws-personal",
    "ws-team",
  ])
})

test("a stale workspace response cannot overwrite a newer load", async () => {
  let resolveFirst!: (value: unknown) => void
  const firstResponse = new Promise((resolve) => {
    resolveFirst = resolve
  })

  const collection = makeCollection(async (url) => {
    if (url === "/api/workspaces") return firstResponse
    return { data: { ok: true, items: [personal, team] } }
  })

  const first = collection.loadAll()
  const second = collection.loadAll({ userId: "user-1" })
  await second

  resolveFirst({ data: { ok: true, items: [personal] } })
  await first

  expect(collection.all.map((workspace) => workspace.id)).toEqual([
    "ws-personal",
    "ws-team",
  ])
})
