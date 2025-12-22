/**
 * Favorites Module Exports Tests
 * Generated from TestSpecifications for task-fav-exports
 */

import { describe, test, expect } from "bun:test"

describe("index.ts exports FavoritesDomain scope", () => {
  test("FavoritesDomain is defined", async () => {
    const { FavoritesDomain } = await import("../index")
    expect(FavoritesDomain).toBeDefined()
  })

  test("FavoritesDomain has export() method for type access", async () => {
    const { FavoritesDomain } = await import("../index")
    expect(typeof FavoritesDomain.export).toBe("function")
  })
})

describe("index.ts exports favoritesDomain result", () => {
  test("favoritesDomain is defined", async () => {
    const { favoritesDomain } = await import("../index")
    expect(favoritesDomain).toBeDefined()
  })

  test("favoritesDomain.name equals 'favorites'", async () => {
    const { favoritesDomain } = await import("../index")
    expect(favoritesDomain.name).toBe("favorites")
  })

  test("favoritesDomain can create store instances", async () => {
    const { favoritesDomain } = await import("../index")
    const store = favoritesDomain.createStore()
    expect(store).toBeDefined()
    expect(store.favoriteCollection).toBeDefined()
  })
})

describe("Exports accessible via @shogo/state-api public API", () => {
  test("No import errors occur from favorites module", async () => {
    // This test verifies the module can be imported without errors
    const favorites = await import("../index")
    expect(favorites).toBeDefined()
    expect(favorites.FavoritesDomain).toBeDefined()
    expect(favorites.favoritesDomain).toBeDefined()
  })
})
