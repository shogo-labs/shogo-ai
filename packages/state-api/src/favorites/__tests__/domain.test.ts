/**
 * Favorites Domain Tests
 * Generated from TestSpecifications for task-fav-domain
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { FavoritesDomain, favoritesDomain } from "../domain"

describe("FavoritesDomain scope exports Favorite entity", () => {
  test("Type definition exists", () => {
    expect(FavoritesDomain).toBeDefined()
    // ArkType scope provides .export() method for type access
    expect(typeof FavoritesDomain.export).toBe("function")
  })
})

describe("Favorite entity has correct field types", () => {
  let store: any

  beforeEach(() => {
    store = favoritesDomain.createStore()
  })

  test("Favorite entity accepts valid data", () => {
    const favorite = store.favoriteCollection.add({
      id: crypto.randomUUID(),
      itemType: "schema",
      itemId: "test-123",
      createdAt: Date.now(),
    })

    expect(favorite.id).toBeDefined()
    expect(typeof favorite.itemType).toBe("string")
    expect(typeof favorite.itemId).toBe("string")
    expect(typeof favorite.createdAt).toBe("number")
  })
})

describe("favoritesDomain uses domain() API correctly", () => {
  test("favoritesDomain.name equals 'favorites'", () => {
    expect(favoritesDomain.name).toBe("favorites")
  })

  test("favoritesDomain.createStore is a function", () => {
    expect(typeof favoritesDomain.createStore).toBe("function")
  })

  test("favoritesDomain.enhancedSchema is defined", () => {
    expect(favoritesDomain.enhancedSchema).toBeDefined()
  })
})

describe("isFavorite returns correct status", () => {
  let store: any

  beforeEach(() => {
    store = favoritesDomain.createStore()
  })

  test("returns true for existing favorite", () => {
    store.favoriteCollection.add({
      id: crypto.randomUUID(),
      itemType: "schema",
      itemId: "test-123",
      createdAt: Date.now(),
    })

    expect(store.favoriteCollection.isFavorite("schema", "test-123")).toBe(true)
  })

  test("returns false for non-existing favorite", () => {
    expect(store.favoriteCollection.isFavorite("schema", "nonexistent")).toBe(false)
  })
})

describe("findByItemType filters favorites correctly", () => {
  let store: any

  beforeEach(() => {
    store = favoritesDomain.createStore()
    store.favoriteCollection.add({
      id: crypto.randomUUID(),
      itemType: "schema",
      itemId: "schema-1",
      createdAt: Date.now(),
    })
    store.favoriteCollection.add({
      id: crypto.randomUUID(),
      itemType: "session",
      itemId: "session-1",
      createdAt: Date.now(),
    })
    store.favoriteCollection.add({
      id: crypto.randomUUID(),
      itemType: "schema",
      itemId: "schema-2",
      createdAt: Date.now(),
    })
  })

  test("returns only favorites of specified type", () => {
    const schemaFavorites = store.favoriteCollection.findByItemType("schema")
    expect(schemaFavorites.length).toBe(2)
    expect(schemaFavorites.every((f: any) => f.itemType === "schema")).toBe(true)
  })

  test("does not include other types", () => {
    const schemaFavorites = store.favoriteCollection.findByItemType("schema")
    expect(schemaFavorites.some((f: any) => f.itemType === "session")).toBe(false)
  })
})

describe("toggleFavorite adds or removes favorite", () => {
  let store: any

  beforeEach(() => {
    store = favoritesDomain.createStore()
  })

  test("adds new favorite when not exists", () => {
    expect(store.favoriteCollection.isFavorite("schema", "new-item")).toBe(false)

    store.toggleFavorite("schema", "new-item")

    expect(store.favoriteCollection.isFavorite("schema", "new-item")).toBe(true)
    const favorites = store.favoriteCollection.all()
    const added = favorites.find((f: any) => f.itemId === "new-item")
    expect(added).toBeDefined()
    expect(added.itemType).toBe("schema")
    expect(typeof added.createdAt).toBe("number")
  })

  test("removes favorite when exists", () => {
    // First add the favorite
    store.favoriteCollection.add({
      id: crypto.randomUUID(),
      itemType: "schema",
      itemId: "existing-item",
      createdAt: Date.now(),
    })
    expect(store.favoriteCollection.isFavorite("schema", "existing-item")).toBe(true)

    // Toggle should remove it
    store.toggleFavorite("schema", "existing-item")

    expect(store.favoriteCollection.isFavorite("schema", "existing-item")).toBe(false)
  })
})

describe("CRUD operations work correctly", () => {
  let store: any

  beforeEach(() => {
    store = favoritesDomain.createStore()
  })

  test("add creates new favorite", () => {
    const favorite = store.favoriteCollection.add({
      id: crypto.randomUUID(),
      itemType: "product",
      itemId: "prod-123",
      createdAt: Date.now(),
    })

    expect(favorite).toBeDefined()
    expect(store.favoriteCollection.all().length).toBe(1)
  })

  test("all returns all favorites", () => {
    store.favoriteCollection.add({
      id: crypto.randomUUID(),
      itemType: "product",
      itemId: "prod-1",
      createdAt: Date.now(),
    })
    store.favoriteCollection.add({
      id: crypto.randomUUID(),
      itemType: "product",
      itemId: "prod-2",
      createdAt: Date.now(),
    })

    const all = store.favoriteCollection.all()
    expect(all.length).toBe(2)
  })

  test("remove removes favorite", () => {
    const favorite = store.favoriteCollection.add({
      id: crypto.randomUUID(),
      itemType: "product",
      itemId: "prod-delete",
      createdAt: Date.now(),
    })

    expect(store.favoriteCollection.all().length).toBe(1)
    store.favoriteCollection.remove(favorite.id)
    expect(store.favoriteCollection.all().length).toBe(0)
  })
})
