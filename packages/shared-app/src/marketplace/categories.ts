// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Category content map used across browse, category landing pages, and the
 * listing editor. Each category gets an icon (Lucide name), a one-line
 * value-prop, and a Notion-style accent color used for gradient headers.
 *
 * Slugs match the lowercase value used by `MarketplaceListing.category`
 * and the API's `?category=` query parameter.
 */
export interface MarketplaceCategory {
  /** URL slug — matches `MarketplaceListing.category`. */
  slug: string
  /** Display label shown in pills, headings, and detail pages. */
  label: string
  /** Lucide icon component name (resolved at the call site). */
  icon: string
  /** One-line value-prop shown under the heading on the landing page. */
  tagline: string
  /** Accent color (`#rrggbb`) used for gradient headers and category cards. */
  accent: string
}

export const MARKETPLACE_CATEGORIES: MarketplaceCategory[] = [
  {
    slug: 'personal',
    label: 'Personal',
    icon: 'User',
    tagline: 'Agents that help with everyday life',
    accent: '#8b5cf6',
  },
  {
    slug: 'development',
    label: 'Development',
    icon: 'Code',
    tagline: 'Coding companions, code review, and devops helpers',
    accent: '#06b6d4',
  },
  {
    slug: 'business',
    label: 'Business',
    icon: 'Briefcase',
    tagline: 'Operations, finance, and admin agents for your team',
    accent: '#22c55e',
  },
  {
    slug: 'research',
    label: 'Research',
    icon: 'Microscope',
    tagline: 'Deep research, summarization, and analysis',
    accent: '#3b82f6',
  },
  {
    slug: 'operations',
    label: 'Operations',
    icon: 'Wrench',
    tagline: 'Workflow automation and back-office tooling',
    accent: '#f97316',
  },
  {
    slug: 'marketing',
    label: 'Marketing',
    icon: 'Megaphone',
    tagline: 'Content, campaigns, and SEO agents',
    accent: '#ec4899',
  },
  {
    slug: 'sales',
    label: 'Sales',
    icon: 'TrendingUp',
    tagline: 'Outreach, pipeline, and CRM helpers',
    accent: '#eab308',
  },
]

const BY_SLUG = Object.fromEntries(
  MARKETPLACE_CATEGORIES.map((c) => [c.slug, c]),
) as Record<string, MarketplaceCategory>

export function findCategory(slug: string | null | undefined): MarketplaceCategory | null {
  if (!slug) return null
  return BY_SLUG[slug.toLowerCase()] ?? null
}

export function categoryLabel(slug: string | null | undefined): string {
  return findCategory(slug)?.label ?? (slug ?? 'Uncategorized')
}

export function categoryAccent(slug: string | null | undefined): string {
  return findCategory(slug)?.accent ?? '#71717a'
}
