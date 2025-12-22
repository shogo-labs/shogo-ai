/**
 * Favorites Domain Store
 *
 * Uses the domain() composition API to define Favorite entity with
 * enhancement hooks for collection queries (isFavorite, findByItemType)
 * and rootStore actions (toggleFavorite).
 *
 * CollectionPersistable is auto-composed by domain().
 */

import { scope } from "arktype"
import { domain } from "../domain"

// ============================================================
// 1. DOMAIN SCHEMA (ArkType)
// ============================================================

export const FavoritesDomain = scope({
  Favorite: {
    id: "string.uuid",
    itemType: "string", // Type of favorited item (e.g., "schema", "session", "product")
    itemId: "string", // ID of the favorited item
    createdAt: "number",
  },
})

// ============================================================
// 2. DOMAIN DEFINITION WITH ENHANCEMENTS
// ============================================================

/**
 * Favorites domain with all enhancements.
 * Registered in enhancement registry for meta-store integration.
 */
export const favoritesDomain = domain({
  name: "favorites",
  from: FavoritesDomain,
  enhancements: {
    // --------------------------------------------------------
    // collections: Add query methods (CollectionPersistable auto-composed)
    // --------------------------------------------------------
    collections: (collections) => ({
      ...collections,

      FavoriteCollection: collections.FavoriteCollection.views((self: any) => ({
        /**
         * Check if an item is favorited
         */
        isFavorite(itemType: string, itemId: string): boolean {
          return self.all().some(
            (f: any) => f.itemType === itemType && f.itemId === itemId
          )
        },

        /**
         * Find all favorites of a specific type
         */
        findByItemType(itemType: string): any[] {
          return self.all().filter((f: any) => f.itemType === itemType)
        },
      })),
    }),

    // --------------------------------------------------------
    // rootStore: Add domain actions
    // --------------------------------------------------------
    rootStore: (store) =>
      store.actions((self: any) => ({
        /**
         * Toggle favorite status for an item.
         * If favorited, removes it. If not, adds it.
         */
        toggleFavorite(itemType: string, itemId: string): void {
          const existing = self.favoriteCollection
            .all()
            .find((f: any) => f.itemType === itemType && f.itemId === itemId)

          if (existing) {
            self.favoriteCollection.remove(existing.id)
          } else {
            self.favoriteCollection.add({
              id: crypto.randomUUID(),
              itemType,
              itemId,
              createdAt: Date.now(),
            })
          }
        },
      })),
  },
})
