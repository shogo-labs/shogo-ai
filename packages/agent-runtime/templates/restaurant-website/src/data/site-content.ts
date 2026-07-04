// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// ============================================================================
// SINGLE SOURCE OF TRUTH FOR EVERYTHING THE SITE SHOWS
// ============================================================================
//
// Every word, price, hour, and photo the visitor sees comes from this file.
// It ships EMPTY on purpose.
//
//   ⛔ DO NOT invent a business name, menu items, prices, opening hours,
//      address, phone number, or photos. Making any of that up is the #1
//      failure on this platform — users publish a site full of wrong details.
//
//   ✅ Fill this in ONLY with details the owner has given you (see the
//      `business-intake` skill / the "paste your real details" step).
//
//   ✅ Leave a field blank/empty if you don't have the real value yet. The
//      UI renders clean empty states and a setup banner until `configured`
//      is flipped to true.
//
// When you have collected the real details, edit the values below and set
// `configured: true`. Add or remove menu categories, items, and gallery
// photos as the real business requires.
// ============================================================================

export interface WeekdayHours {
  /** e.g. "Monday" */
  day: string
  /** Human label, e.g. "11:00 AM – 10:00 PM". Empty string = closed. */
  hours: string
}

export interface MenuItem {
  name: string
  description?: string
  /** Keep the currency the owner uses, e.g. "$14", "£9.50", "₹320". */
  price?: string
  /** Optional short tags, e.g. ["Vegan", "Gluten-free", "Chef's pick"]. */
  tags?: string[]
}

export interface MenuCategory {
  name: string
  description?: string
  items: MenuItem[]
}

export interface GalleryPhoto {
  /** A real, working image URL the owner supplied or uploaded. Never a guess. */
  url: string
  /** Describe the photo for accessibility, e.g. "Wood-fired margherita pizza". */
  alt: string
  caption?: string
}

export interface SocialLinks {
  instagram?: string
  facebook?: string
  tiktok?: string
  x?: string
  yelp?: string
  googleMaps?: string
}

export interface SiteContent {
  /**
   * Flip to `true` only after you have collected the REAL business details.
   * While false, the site shows a setup banner instead of pretending to be
   * a finished, published website.
   */
  configured: boolean

  business: {
    /** e.g. "Solaris Coffee", "Morito Bakery". */
    name: string
    /** One line under the name, e.g. "Neighbourhood coffee & brunch". */
    tagline: string
    /** restaurant | cafe | bakery | bar | barber | salon | service | other */
    type: string
    /** 2–4 sentences the owner approves. No invented history or awards. */
    about: string
    /** e.g. "Italian", "Third-wave coffee", "Artisan sourdough". Optional. */
    cuisine?: string
    /** e.g. "$$", "£", "₹₹". Optional. */
    priceRange?: string
  }

  contact: {
    phone?: string
    email?: string
    /** Full street address as one string. */
    address?: string
    /** Google Maps embed or share URL. */
    mapUrl?: string
  }

  hours: WeekdayHours[]

  menu: {
    /** Section title, e.g. "Menu", "Our Coffee", "Services". */
    heading: string
    categories: MenuCategory[]
  }

  gallery: GalleryPhoto[]

  booking: {
    /** Show the table-booking form? Turn off for businesses that don't take bookings. */
    enabled: boolean
    /** Label for the CTA button, e.g. "Book a table", "Reserve", "Request appointment". */
    ctaLabel: string
    /** Short note shown above the form, e.g. deposit policy or large-party guidance. */
    note?: string
  }

  social: SocialLinks
}

export const siteContent: SiteContent = {
  configured: false,

  business: {
    name: '',
    tagline: '',
    type: '',
    about: '',
    cuisine: '',
    priceRange: '',
  },

  contact: {
    phone: '',
    email: '',
    address: '',
    mapUrl: '',
  },

  // Seven days pre-listed so the owner just fills the times. Empty `hours`
  // renders as "Closed". Do not guess — ask the owner for real opening times.
  hours: [
    { day: 'Monday', hours: '' },
    { day: 'Tuesday', hours: '' },
    { day: 'Wednesday', hours: '' },
    { day: 'Thursday', hours: '' },
    { day: 'Friday', hours: '' },
    { day: 'Saturday', hours: '' },
    { day: 'Sunday', hours: '' },
  ],

  menu: {
    heading: 'Menu',
    // Add real categories + items here. Every price and description must come
    // from the owner. Leave empty until you have the real menu.
    categories: [],
  },

  // Real photos only — an owner upload or a URL they gave you. An empty
  // gallery renders a tasteful "photos coming soon" state; a made-up image
  // URL renders a broken image and looks worse than empty.
  gallery: [],

  booking: {
    enabled: true,
    ctaLabel: 'Book a table',
    note: '',
  },

  social: {},
}

/**
 * True once the essentials a visitor needs are present. Used by the UI to
 * decide whether to show the setup banner. This is deliberately strict: a
 * name alone is not a finished site.
 */
export function isSiteReady(c: SiteContent = siteContent): boolean {
  const hasName = c.business.name.trim().length > 0
  const hasContact = Boolean(c.contact.phone || c.contact.email || c.contact.address)
  const hasHours = c.hours.some((h) => h.hours.trim().length > 0)
  return c.configured && hasName && hasContact && hasHours
}
