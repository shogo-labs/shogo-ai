// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// ============================================================================
// SINGLE SOURCE OF TRUTH FOR THE STORE
// ============================================================================
//
// Every product, price, and word the shopper sees comes from this file. It
// ships EMPTY on purpose.
//
//   ⛔ DO NOT invent products, prices, descriptions, a store name, or photos.
//      Publishing a store full of made-up products is the #1 failure on this
//      platform.
//
//   ✅ Fill this in ONLY with products the owner gave you (see the
//      `store-intake` skill / the "paste your real products" step).
//
//   ✅ Prices are INTEGER minor units — cents/pence/paise. £9.50 -> 950,
//      $14 -> 1400, ₹320 -> 32000. This avoids float rounding bugs and keeps
//      the number the customer pays identical to what Stripe charges.
//
//   ✅ Leave arrays empty if you don't have the real data yet. The store shows
//      clean empty states and a setup banner until `configured` is true.
// ============================================================================

export interface Product {
  /** Stable slug/id, e.g. "house-blend-250g". Used in the cart and orders. */
  id: string
  name: string
  description?: string
  /** Price in MINOR units (cents/pence/paise). Never a decimal. */
  priceMinor: number
  /** A real, working image URL the owner supplied. Never a guess/stock photo. */
  image?: string
  /** Optional grouping label, e.g. "Coffee", "Merch", "Gift sets". */
  category?: string
  /** Optional badges, e.g. ["New", "Best seller", "Low stock"]. */
  tags?: string[]
  /** Set false to show the product as sold out (still visible, not buyable). */
  available?: boolean
}

export interface StoreContent {
  /**
   * Flip to `true` only after you have added the owner's REAL products and
   * store details. While false, a setup banner shows instead of pretending to
   * be a finished, published store.
   */
  configured: boolean

  store: {
    /** e.g. "Solaris Coffee Roasters". */
    name: string
    /** One line under the name, e.g. "Small-batch coffee, shipped fresh". */
    tagline: string
    /** 1–3 sentences the owner approves. No invented history or claims. */
    about: string
    /** Lowercase ISO currency the store prices in: "usd", "gbp", "eur", "inr". */
    currency: string
    /** Currency symbol shown in the UI, e.g. "$", "£", "₹". */
    currencySymbol: string
  }

  contact: {
    email?: string
    phone?: string
    /** Where things ship from / are collected, if relevant. */
    address?: string
  }

  /** Free-text shipping/collection note shown at checkout, e.g. "Free UK shipping over £30". */
  shippingNote?: string

  products: Product[]

  social: {
    instagram?: string
    facebook?: string
    tiktok?: string
    website?: string
  }
}

export const storeContent: StoreContent = {
  configured: false,

  store: {
    name: '',
    tagline: '',
    about: '',
    currency: 'usd',
    currencySymbol: '$',
  },

  contact: {
    email: '',
    phone: '',
    address: '',
  },

  shippingNote: '',

  // Add real products here. Every price is in minor units and every photo is
  // a real URL the owner gave you. Leave empty until you have the real catalog.
  products: [],

  social: {},
}

/**
 * True once the store has a name and at least one real product. Used by the UI
 * to decide whether to show the setup banner. Deliberately strict — a name
 * with no products is not a finished store.
 */
export function isStoreReady(c: StoreContent = storeContent): boolean {
  return c.configured && c.store.name.trim().length > 0 && c.products.length > 0
}
