// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Seed the marketplace with realistic demo data so the new browse / detail /
 * creator surfaces have something to render in local mode.
 *
 * Creates (idempotent — safe to re-run):
 *   - 5 demo users + creator profiles spanning the 5 tiers
 *   - 1 demo workspace owned by the first user
 *   - 16 published listings spread across the 7 categories with mixed
 *     pricing models (free / one_time / subscription, including some with
 *     both monthly + annual prices), varied tags from the KNOWN_INTEGRATIONS
 *     map, screenshots, install counts, and ratings
 *   - 4 of those listings are editorially "Built for Shogo" (`featuredAt`)
 *   - A handful of installs + reviews against installs so the rating
 *     histogram and "Recent transactions" panel render
 *   - A few completed transactions per paid listing so the dashboard
 *     sparklines, deltas, and recent-transactions list have signal
 *   - A few badges per creator so the profile page shows the badge rail
 *
 * Usage (local mode / sqlite):
 *
 *   bun scripts/seed-marketplace.ts
 *
 * Hosted / Postgres dev DB:
 *
 *   DATABASE_URL=postgres://... bun scripts/seed-marketplace.ts
 *
 * Optional flags:
 *   --reset    Delete existing seed rows (anything created by this script,
 *              identified by the `[seed]` marker on the listing slug) before
 *              re-creating. Useful when iterating on the seed itself.
 */

import { prisma } from '../apps/api/src/lib/prisma'

// ─── Config ────────────────────────────────────────────────────────

const SEED_MARKER = 'seed-' // every demo listing slug starts with this

interface SeedCreator {
  email: string
  name: string
  displayName: string
  bio: string
  avatarSeed: string
  tier: 'newcomer' | 'builder' | 'craftsman' | 'expert' | 'master'
  reputationScore: number
  verified: boolean
  badges: Array<
    | 'first_agent'
    | 'popular_10'
    | 'popular_100'
    | 'popular_1000'
    | 'top_rated'
    | 'five_star'
    | 'prolific_builder'
    | 'master_builder'
    | 'active_maintainer'
    | 'streak_3'
    | 'streak_6'
    | 'streak_12'
    | 'multi_category'
    | 'early_adopter'
    | 'verified_creator'
  >
}

const CREATORS: SeedCreator[] = [
  {
    email: 'demo-creator-1@shogo.local',
    name: 'Maya Patel',
    displayName: 'Maya Patel',
    bio: 'Builds inbox + research agents. Ex-Notion, ex-Stripe.',
    avatarSeed: 'maya',
    tier: 'master',
    reputationScore: 9_840,
    verified: true,
    badges: [
      'first_agent',
      'popular_1000',
      'top_rated',
      'five_star',
      'master_builder',
      'streak_12',
      'verified_creator',
      'multi_category',
    ],
  },
  {
    email: 'demo-creator-2@shogo.local',
    name: 'Jonas Lindgren',
    displayName: 'Jonas Lindgren',
    bio: 'Indie builder shipping ops + sales tooling. Open-source maintainer.',
    avatarSeed: 'jonas',
    tier: 'expert',
    reputationScore: 5_210,
    verified: true,
    badges: ['first_agent', 'popular_100', 'top_rated', 'streak_6', 'verified_creator'],
  },
  {
    email: 'demo-creator-3@shogo.local',
    name: 'Alex Romero',
    displayName: 'Alex Romero',
    bio: 'Devtools nerd. Prefers Postgres to all other databases.',
    avatarSeed: 'alex',
    tier: 'craftsman',
    reputationScore: 1_910,
    verified: false,
    badges: ['first_agent', 'popular_100', 'streak_3'],
  },
  {
    email: 'demo-creator-4@shogo.local',
    name: 'Hana Kobayashi',
    displayName: 'Hana Kobayashi',
    bio: 'Designer-engineer building marketing agents.',
    avatarSeed: 'hana',
    tier: 'builder',
    reputationScore: 720,
    verified: false,
    badges: ['first_agent', 'popular_10'],
  },
  {
    email: 'demo-creator-5@shogo.local',
    name: 'Ravi Shah',
    displayName: 'Ravi Shah',
    bio: 'Just shipped my first agent — say hi!',
    avatarSeed: 'ravi',
    tier: 'newcomer',
    reputationScore: 80,
    verified: false,
    badges: ['first_agent', 'early_adopter'],
  },
]

interface SeedListing {
  slugSuffix: string
  creator: number // index into CREATORS
  title: string
  shortDescription: string
  longDescription: string
  category:
    | 'personal'
    | 'development'
    | 'business'
    | 'research'
    | 'operations'
    | 'marketing'
    | 'sales'
  tags: string[]
  pricing:
    | { model: 'free' }
    | { model: 'one_time'; price: number }
    | {
        model: 'subscription'
        monthly?: number
        annual?: number
      }
  installs: number
  rating: number
  reviewCount: number
  featured?: boolean
  screenshots?: number // # of placeholder screenshots (0–4)
  publishedDaysAgo: number
}

const LISTINGS: SeedListing[] = [
  {
    slugSuffix: 'inbox-zen',
    creator: 0,
    title: 'Inbox Zen',
    shortDescription: 'Triages your Gmail, drafts replies in your voice, and clears the noise.',
    longDescription: `Inbox Zen reads incoming Gmail and applies a calm, opinionated triage so you only see what matters.

- Auto-labels by sender, intent, and urgency
- Drafts replies in your voice that you approve in one tap
- Surfaces the 3 most important threads each morning
- Snoozes anything that can wait until tomorrow
- Connects to Slack so you can triage from chat`,
    category: 'personal',
    tags: ['gmail', 'slack', 'email', 'productivity'],
    pricing: { model: 'subscription', monthly: 1200, annual: 11500 },
    installs: 12_840,
    rating: 4.8,
    reviewCount: 312,
    featured: true,
    screenshots: 3,
    publishedDaysAgo: 90,
  },
  {
    slugSuffix: 'pr-radar',
    creator: 0,
    title: 'PR Radar',
    shortDescription: 'Reviews GitHub pull requests with line-level feedback before your team does.',
    longDescription: `PR Radar reads diffs, runs static analysis, and writes precise inline review comments on every pull request.

- Catches null-checks, unsafe casts, and missing tests
- Suggests refactors with code blocks you can apply in one click
- Posts a single summary comment plus inline feedback
- Quiet mode skips trivial style nits
- Works with GitHub and GitLab`,
    category: 'development',
    tags: ['github', 'gitlab', 'web', 'http'],
    pricing: { model: 'subscription', monthly: 1900, annual: 18000 },
    installs: 6_120,
    rating: 4.7,
    reviewCount: 188,
    featured: true,
    screenshots: 2,
    publishedDaysAgo: 60,
  },
  {
    slugSuffix: 'meeting-scribe',
    creator: 1,
    title: 'Meeting Scribe',
    shortDescription: 'Summarizes meetings, extracts action items, and ships them to Linear.',
    longDescription: `Meeting Scribe joins meetings as a silent participant and turns the transcript into a concise summary plus a clean list of action items.

- One-paragraph summary at the top
- Bulleted action items grouped by owner
- Auto-creates Linear issues for owned items
- Posts highlights to Slack
- Works with Google Calendar`,
    category: 'operations',
    tags: ['linear', 'slack', 'google-calendar', 'calendar'],
    pricing: { model: 'subscription', monthly: 900 },
    installs: 4_410,
    rating: 4.6,
    reviewCount: 132,
    featured: true,
    screenshots: 3,
    publishedDaysAgo: 45,
  },
  {
    slugSuffix: 'pipeline-pal',
    creator: 1,
    title: 'Pipeline Pal',
    shortDescription: 'Keeps your CRM updated by reading email threads and meeting notes.',
    longDescription: `Pipeline Pal watches your sent mail and meeting notes, then quietly updates the right deal in HubSpot or Salesforce.

- Logs activities against the matching deal
- Suggests next-step tasks
- Flags deals that have gone quiet
- Works with HubSpot and Salesforce
- Connects to Gmail and your calendar`,
    category: 'sales',
    tags: ['hubspot', 'salesforce', 'gmail', 'calendar'],
    pricing: { model: 'one_time', price: 4900 },
    installs: 1_910,
    rating: 4.5,
    reviewCount: 64,
    screenshots: 2,
    publishedDaysAgo: 30,
  },
  {
    slugSuffix: 'doc-distiller',
    creator: 2,
    title: 'Doc Distiller',
    shortDescription: 'Reads long PDFs and Notion pages, returns the answer plus a citation.',
    longDescription: `Doc Distiller turns long documents into precise answers with citations.

- Handles PDFs, Notion pages, and Google Docs
- Always cites the source paragraph
- Asks a follow-up when the question is ambiguous
- Free for under 50 docs / month`,
    category: 'research',
    tags: ['notion', 'google-docs', 'web', 'search'],
    pricing: { model: 'free' },
    installs: 8_220,
    rating: 4.4,
    reviewCount: 240,
    featured: true,
    screenshots: 2,
    publishedDaysAgo: 75,
  },
  {
    slugSuffix: 'sql-pair',
    creator: 2,
    title: 'SQL Pair',
    shortDescription: 'A pair-programmer for Postgres queries that explains every plan.',
    longDescription: `SQL Pair helps you write correct, fast Postgres queries.

- Explains query plans in plain English
- Suggests missing indexes
- Flags accidentally unbounded queries
- Works with Postgres and MySQL
- Read-only by default, write access opt-in`,
    category: 'development',
    tags: ['postgres', 'mysql', 'http'],
    pricing: { model: 'subscription', monthly: 600, annual: 6000 },
    installs: 2_430,
    rating: 4.3,
    reviewCount: 81,
    screenshots: 2,
    publishedDaysAgo: 22,
  },
  {
    slugSuffix: 'launch-letter',
    creator: 3,
    title: 'Launch Letter',
    shortDescription: 'Drafts launch announcements + nurture sequences from a one-line brief.',
    longDescription: `Launch Letter expands a one-line product brief into a coherent launch sequence.

- Announcement post for X / LinkedIn
- 3-email nurture sequence
- Schedules through Mailchimp
- Edits stay in Notion so you keep control`,
    category: 'marketing',
    tags: ['mailchimp', 'notion'],
    pricing: { model: 'subscription', monthly: 1500 },
    installs: 1_120,
    rating: 4.5,
    reviewCount: 38,
    screenshots: 1,
    publishedDaysAgo: 18,
  },
  {
    slugSuffix: 'storefront-watcher',
    creator: 3,
    title: 'Storefront Watcher',
    shortDescription: 'Monitors Shopify orders and pings you when something looks off.',
    longDescription: `Storefront Watcher keeps an eye on your Shopify storefront so you can run the business, not the dashboard.

- Daily revenue + AOV summary
- Anomaly alerts (refund spikes, low stock)
- Reports through Slack
- Read-only by default`,
    category: 'business',
    tags: ['shopify', 'slack', 'stripe'],
    pricing: { model: 'one_time', price: 2900 },
    installs: 720,
    rating: 4.2,
    reviewCount: 19,
    screenshots: 1,
    publishedDaysAgo: 11,
  },
  {
    slugSuffix: 'kanban-keeper',
    creator: 1,
    title: 'Kanban Keeper',
    shortDescription: 'Cleans up stale tickets and triages new ones across Jira and Asana.',
    longDescription: `Kanban Keeper does the boring grooming work no one wants to do.

- Closes tickets that have been idle 30+ days
- Suggests assignees for unowned issues
- Posts a weekly digest
- Works with Jira, Asana, and Trello`,
    category: 'operations',
    tags: ['jira', 'asana', 'trello', 'slack'],
    pricing: { model: 'free' },
    installs: 3_310,
    rating: 4.1,
    reviewCount: 96,
    screenshots: 2,
    publishedDaysAgo: 50,
  },
  {
    slugSuffix: 'cal-coach',
    creator: 0,
    title: 'Cal Coach',
    shortDescription: 'Defends your focus time and routes meetings into batches.',
    longDescription: `Cal Coach learns your meeting patterns and protects your most-productive hours.

- Auto-blocks 2-hour focus windows
- Suggests rescheduling low-priority meetings
- Routes 1:1s into back-to-back batches
- Works with Google Calendar`,
    category: 'personal',
    tags: ['google-calendar', 'calendar', 'slack'],
    pricing: { model: 'free' },
    installs: 5_140,
    rating: 4.6,
    reviewCount: 174,
    screenshots: 2,
    publishedDaysAgo: 35,
  },
  {
    slugSuffix: 'bug-bot',
    creator: 2,
    title: 'Bug Bot',
    shortDescription: 'Scrubs Sentry / Linear backlogs and merges duplicate issues.',
    longDescription: `Bug Bot deduplicates and tags issues so the engineering backlog stays sane.

- Detects near-duplicate stack traces
- Merges with a clear audit trail
- Suggests severity based on volume + customer tier
- Works with Sentry-style stacks; integrates with Linear and Jira`,
    category: 'development',
    tags: ['linear', 'jira', 'github'],
    pricing: { model: 'subscription', monthly: 1200, annual: 12000 },
    installs: 940,
    rating: 4.0,
    reviewCount: 28,
    screenshots: 1,
    publishedDaysAgo: 8,
  },
  {
    slugSuffix: 'lit-search',
    creator: 0,
    title: 'Lit Search',
    shortDescription: 'Curates a literature review on any topic with citations.',
    longDescription: `Lit Search builds an annotated bibliography on any topic in minutes.

- Pulls from arxiv + the open web
- Returns a 1-paragraph summary per source
- Saves the bibliography to Notion or Google Docs
- Always cites; never invents`,
    category: 'research',
    tags: ['notion', 'google-docs', 'web', 'search'],
    pricing: { model: 'subscription', monthly: 800, annual: 7500 },
    installs: 2_010,
    rating: 4.7,
    reviewCount: 71,
    screenshots: 2,
    publishedDaysAgo: 28,
  },
  {
    slugSuffix: 'invoice-iq',
    creator: 3,
    title: 'Invoice IQ',
    shortDescription: 'Reads incoming invoices, extracts line items, posts to your books.',
    longDescription: `Invoice IQ takes the photo-of-a-receipt era and turns it into clean accounting data.

- OCRs PDFs and images
- Extracts vendor, line items, totals
- Pushes to your bookkeeping system
- Flags duplicates`,
    category: 'business',
    tags: ['stripe', 'http'],
    pricing: { model: 'one_time', price: 3900 },
    installs: 410,
    rating: 4.3,
    reviewCount: 12,
    screenshots: 1,
    publishedDaysAgo: 14,
  },
  {
    slugSuffix: 'lead-listener',
    creator: 1,
    title: 'Lead Listener',
    shortDescription: 'Watches inbound forms + Slack and routes hot leads to a rep.',
    longDescription: `Lead Listener triages inbound leads in real time so you never lose one to the void.

- Reads form submissions + Slack channels
- Scores leads on intent + ICP fit
- Notifies the right rep with full context
- Logs to HubSpot or Salesforce`,
    category: 'sales',
    tags: ['hubspot', 'salesforce', 'slack'],
    pricing: { model: 'subscription', monthly: 2500 },
    installs: 580,
    rating: 4.4,
    reviewCount: 16,
    screenshots: 1,
    publishedDaysAgo: 10,
  },
  {
    slugSuffix: 'site-sentry',
    creator: 4,
    title: 'Site Sentry',
    shortDescription: 'Pings you when your deployed site changes in unexpected ways.',
    longDescription: `Site Sentry runs visual diffs on your production pages and pings you when something shifts.

- Pixel + DOM diff
- Allow-list known dynamic regions
- Reports through Slack`,
    category: 'operations',
    tags: ['slack', 'web', 'vercel'],
    pricing: { model: 'free' },
    installs: 140,
    rating: 4.2,
    reviewCount: 5,
    screenshots: 1,
    publishedDaysAgo: 5,
  },
  {
    slugSuffix: 'thread-tracer',
    creator: 4,
    title: 'Thread Tracer',
    shortDescription: 'Finds the right Discord thread and summarizes the conversation.',
    longDescription: `Thread Tracer makes long Discord communities navigable.

- Searches by topic, not just keywords
- Summarizes a thread in 3 sentences
- Links to the original messages`,
    category: 'personal',
    tags: ['discord'],
    pricing: { model: 'free' },
    installs: 90,
    rating: 4.0,
    reviewCount: 3,
    screenshots: 0,
    publishedDaysAgo: 3,
  },
]

// ─── Helpers ───────────────────────────────────────────────────────

function dicebearAvatar(seed: string): string {
  return `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(seed)}`
}

function placeholderScreenshot(slug: string, idx: number): string {
  // Stable placeholder images per slug+idx so reseeds don't flicker.
  const w = 1280
  const h = 720
  const seed = `${slug}-${idx}`
  return `https://picsum.photos/seed/${encodeURIComponent(seed)}/${w}/${h}`
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

function pickReviewBody(rating: number): { title: string; body: string } {
  if (rating >= 5) {
    return {
      title: 'Saves me hours every week',
      body: "I've tried half a dozen alternatives and this one actually feels designed for the way I work. Setup was 10 minutes and it has paid for itself many times over.",
    }
  }
  if (rating === 4) {
    return {
      title: 'Solid — minor rough edges',
      body: 'Does what it says on the tin. A few rough edges in the onboarding flow, but the creator is responsive and shipping fixes weekly.',
    }
  }
  if (rating === 3) {
    return {
      title: 'Useful but not life-changing',
      body: 'Works well for the obvious cases. Gets confused on edge cases and the integrations could be deeper.',
    }
  }
  if (rating === 2) {
    return {
      title: 'Promising but not there yet',
      body: "Concept is great, execution is hit-or-miss. I had to babysit it more than I'd like.",
    }
  }
  return {
    title: 'Not for me',
    body: "Couldn't get past the setup step on the first try. Will revisit when it's more polished.",
  }
}

const REVIEW_USERS_COUNT = 12

// ─── Main ──────────────────────────────────────────────────────────

async function ensureDemoUsers() {
  const users: Array<{ id: string; email: string; name: string }> = []
  for (const c of CREATORS) {
    const user = await prisma.user.upsert({
      where: { email: c.email },
      update: { name: c.name },
      create: { email: c.email, name: c.name, emailVerified: true },
    })
    users.push({ id: user.id, email: user.email, name: user.name ?? c.name })
  }
  // A small pool of "buyer" users so reviews and installs have realistic
  // userId variety without the schema noticing they're synthetic.
  for (let i = 0; i < REVIEW_USERS_COUNT; i++) {
    const email = `demo-buyer-${i}@shogo.local`
    await prisma.user.upsert({
      where: { email },
      update: {},
      create: { email, name: `Buyer ${i + 1}`, emailVerified: true },
    })
  }
  return users
}

async function ensureDemoWorkspace(ownerUserId: string) {
  const slug = 'shogo-marketplace-demo'
  let workspace = await prisma.workspace.findUnique({ where: { slug } })
  if (!workspace) {
    workspace = await prisma.workspace.create({
      data: {
        name: 'Marketplace Demo',
        slug,
        description: 'Demo workspace owned by the marketplace seed script.',
      },
    })
    // Owner membership so the workspace is reachable from the UI.
    const existingMember = await prisma.member
      .findFirst({
        where: { userId: ownerUserId, workspaceId: workspace.id },
      })
      .catch(() => null)
    if (!existingMember) {
      await prisma.member
        .create({
          data: {
            userId: ownerUserId,
            workspaceId: workspace.id,
            role: 'owner',
          },
        })
        .catch(() => undefined) // non-fatal if membership shape differs
    }
  }
  return workspace
}

async function ensureCreatorProfiles(
  users: Array<{ id: string; email: string }>,
) {
  const profiles: Array<{ id: string; userId: string; tier: SeedCreator['tier'] }> = []
  for (let i = 0; i < CREATORS.length; i++) {
    const c = CREATORS[i]
    const user = users[i]
    const existing = await prisma.creatorProfile.findUnique({
      where: { userId: user.id },
    })
    const data = {
      displayName: c.displayName,
      bio: c.bio,
      avatarUrl: dicebearAvatar(c.avatarSeed),
      verified: c.verified,
      creatorTier: c.tier,
      reputationScore: c.reputationScore,
      payoutStatus: c.tier === 'newcomer' ? ('not_setup' as const) : ('verified' as const),
    }
    let profile
    if (existing) {
      profile = await prisma.creatorProfile.update({
        where: { id: existing.id },
        data,
      })
    } else {
      profile = await prisma.creatorProfile.create({
        data: { userId: user.id, ...data },
      })
    }
    // Reset and re-create badges for this creator (idempotent).
    await prisma.creatorBadge.deleteMany({ where: { creatorId: profile.id } })
    if (c.badges.length > 0) {
      await prisma.creatorBadge.createMany({
        data: c.badges.map((b, idx) => ({
          creatorId: profile.id,
          badgeType: b,
          earnedAt: daysAgo(c.badges.length * 30 - idx * 7),
        })),
      })
    }
    profiles.push({ id: profile.id, userId: user.id, tier: c.tier })
  }
  return profiles
}

async function ensureProject(
  workspaceId: string,
  ownerUserId: string,
  title: string,
  description: string,
  slugSuffix: string,
): Promise<{ id: string }> {
  // Stable lookup: we tag the project's `templateId` field with the seed
  // marker so reseeds find the same project. (The field is unconstrained,
  // so this is safe.)
  const marker = `seed-marketplace:${slugSuffix}`
  const existing = await prisma.project.findFirst({
    where: { workspaceId, templateId: marker },
  })
  if (existing) {
    return { id: existing.id }
  }
  const project = await prisma.project.create({
    data: {
      name: title,
      description,
      workspaceId,
      status: 'published',
      createdBy: ownerUserId,
      templateId: marker,
    },
  })
  return { id: project.id }
}

async function seedListings(
  workspace: { id: string },
  ownerUserId: string,
  creators: Array<{ id: string }>,
) {
  for (const l of LISTINGS) {
    const slug = `${SEED_MARKER}${l.slugSuffix}`
    const creator = creators[l.creator]
    const project = await ensureProject(
      workspace.id,
      ownerUserId,
      l.title,
      l.shortDescription,
      l.slugSuffix,
    )

    const screenshotUrls = Array.from({ length: l.screenshots ?? 0 }, (_, i) =>
      placeholderScreenshot(slug, i),
    )

    const pricing = l.pricing
    const pricingFields =
      pricing.model === 'free'
        ? {
            pricingModel: 'free' as const,
            priceInCents: 0,
            monthlyPriceInCents: 0,
            annualPriceInCents: 0,
          }
        : pricing.model === 'one_time'
          ? {
              pricingModel: 'one_time' as const,
              priceInCents: pricing.price,
              monthlyPriceInCents: 0,
              annualPriceInCents: 0,
            }
          : {
              pricingModel: 'subscription' as const,
              priceInCents: 0,
              monthlyPriceInCents: pricing.monthly ?? 0,
              annualPriceInCents: pricing.annual ?? 0,
            }

    const publishedAt = daysAgo(l.publishedDaysAgo)
    const data = {
      slug,
      projectId: project.id,
      creatorId: creator.id,
      title: l.title,
      shortDescription: l.shortDescription,
      longDescription: l.longDescription,
      category: l.category,
      tags: l.tags,
      iconUrl: null,
      screenshotUrls,
      installCount: l.installs,
      averageRating: l.rating,
      reviewCount: l.reviewCount,
      installModel: 'fork' as const,
      currentVersion: '1.0.0',
      status: 'published' as const,
      publishedAt,
      featuredAt: l.featured ? daysAgo(Math.min(l.publishedDaysAgo - 1, 30)) : null,
      ...pricingFields,
    }

    const existing = await prisma.marketplaceListing.findUnique({ where: { slug } })
    let listing
    if (existing) {
      listing = await prisma.marketplaceListing.update({
        where: { slug },
        data: { ...data, projectId: existing.projectId }, // keep existing project link
      })
    } else {
      listing = await prisma.marketplaceListing.create({ data })
    }

    await seedReviewsForListing(listing.id, l.reviewCount, l.rating)
    if (pricing.model !== 'free') {
      await seedTransactionsForListing(
        listing.id,
        creator.id,
        pricing.model,
        pricingFields.priceInCents || pricingFields.monthlyPriceInCents,
        Math.min(20, l.reviewCount),
      )
    }
  }
}

async function seedReviewsForListing(
  listingId: string,
  reviewCount: number,
  averageRating: number,
) {
  // Wipe existing seed reviews so we can re-shape the histogram on reseed.
  await prisma.marketplaceReview.deleteMany({ where: { listingId } })
  await prisma.marketplaceInstall.deleteMany({ where: { listingId } })
  if (reviewCount === 0) return

  const buyerEmails = Array.from(
    { length: Math.min(reviewCount, REVIEW_USERS_COUNT) },
    (_, i) => `demo-buyer-${i}@shogo.local`,
  )
  const buyers = await prisma.user.findMany({
    where: { email: { in: buyerEmails } },
    select: { id: true, email: true },
  })

  // Build a star distribution that yields roughly the target average.
  // Skewed toward 5★ for high averages, more spread for lower.
  const distribution = (() => {
    if (averageRating >= 4.7) return [0.0, 0.02, 0.04, 0.14, 0.8]
    if (averageRating >= 4.4) return [0.02, 0.04, 0.08, 0.26, 0.6]
    if (averageRating >= 4.0) return [0.04, 0.06, 0.18, 0.32, 0.4]
    if (averageRating >= 3.5) return [0.08, 0.12, 0.32, 0.28, 0.2]
    return [0.2, 0.2, 0.3, 0.2, 0.1]
  })()

  const created: Array<{
    userId: string
    rating: number
    title: string
    body: string
    daysAgo: number
  }> = []
  for (let i = 0; i < buyers.length; i++) {
    // Pick a rating from the distribution deterministically.
    const r = (i + 0.5) / buyers.length
    let acc = 0
    let star = 5
    for (let s = 0; s < 5; s++) {
      acc += distribution[s]
      if (r <= acc) {
        star = s + 1
        break
      }
    }
    const copy = pickReviewBody(star)
    created.push({
      userId: buyers[i].id,
      rating: star,
      title: copy.title,
      body: copy.body,
      daysAgo: 1 + i * 2,
    })
  }

  // Fetch the listing's project + workspace once so installs can reference
  // them without per-row lookups. (Installs reuse the listing's source
  // project here purely as a foreign-key target — they're synthetic.)
  const listingProject = await prisma.marketplaceListing.findUnique({
    where: { id: listingId },
    select: { project: { select: { id: true, workspaceId: true } } },
  })
  if (!listingProject?.project) return

  for (const c of created) {
    const install = await prisma.marketplaceInstall.create({
      data: {
        listingId,
        userId: c.userId,
        projectId: listingProject.project.id,
        workspaceId: listingProject.project.workspaceId,
        installModel: 'fork',
        installedVersion: '1.0.0',
        status: 'active',
      },
    })
    await prisma.marketplaceReview.create({
      data: {
        listingId,
        installId: install.id,
        userId: c.userId,
        rating: c.rating,
        title: c.title,
        body: c.body,
        createdAt: daysAgo(c.daysAgo),
      },
    })
  }
}

async function seedTransactionsForListing(
  listingId: string,
  creatorId: string,
  pricingModel: 'one_time' | 'subscription',
  priceInCents: number,
  count: number,
) {
  await prisma.marketplaceTransaction.deleteMany({ where: { listingId } })
  if (count === 0 || priceInCents === 0) return

  // Fetch buyer ids.
  const buyers = await prisma.user.findMany({
    where: { email: { startsWith: 'demo-buyer-' } },
    select: { id: true },
    take: count,
  })

  const txnType =
    pricingModel === 'subscription' ? 'subscription_payment' : 'purchase'
  for (let i = 0; i < buyers.length; i++) {
    const platformFee = Math.floor(priceInCents * 0.15)
    const creatorAmount = priceInCents - platformFee
    await prisma.marketplaceTransaction.create({
      data: {
        listingId,
        creatorId,
        buyerUserId: buyers[i].id,
        type: txnType,
        amountInCents: priceInCents,
        platformFeeInCents: platformFee,
        creatorAmountInCents: creatorAmount,
        status: 'completed',
        currency: 'usd',
        createdAt: daysAgo(i * 2 + 1), // spread over the last ~40 days
      },
    })
  }
}

async function reset() {
  console.log('[seed-marketplace] resetting existing seed rows…')
  // Reviews + installs + transactions are cascaded from the listing delete.
  await prisma.marketplaceListing.deleteMany({
    where: { slug: { startsWith: SEED_MARKER } },
  })
  // Projects we created for the seed are tagged via templateId.
  await prisma.project.deleteMany({
    where: { templateId: { startsWith: 'seed-marketplace:' } },
  })
  // Creator profiles + their badges (cascade).
  await prisma.creatorProfile.deleteMany({
    where: {
      user: {
        email: { startsWith: 'demo-creator-' },
      },
    },
  })
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--reset')) {
    await reset()
    if (args.includes('--reset-only')) {
      console.log('[seed-marketplace] reset complete.')
      return
    }
  }

  console.log('[seed-marketplace] ensuring demo users…')
  const users = await ensureDemoUsers()

  console.log('[seed-marketplace] ensuring demo workspace…')
  const workspace = await ensureDemoWorkspace(users[0].id)

  console.log('[seed-marketplace] ensuring creator profiles…')
  const creators = await ensureCreatorProfiles(users)

  console.log(`[seed-marketplace] seeding ${LISTINGS.length} listings…`)
  await seedListings(workspace, users[0].id, creators)

  // Recompute creator stats so totalAgentsPublished / totalInstalls /
  // averageAgentRating match the listings we just seeded.
  for (const c of creators) {
    const listings = await prisma.marketplaceListing.findMany({
      where: { creatorId: c.id, status: 'published' },
      select: { installCount: true, averageRating: true, reviewCount: true },
    })
    const totalAgentsPublished = listings.length
    const totalInstalls = listings.reduce((s, l) => s + l.installCount, 0)
    const ratedListings = listings.filter((l) => l.reviewCount > 0)
    const avg =
      ratedListings.length > 0
        ? ratedListings.reduce((s, l) => s + l.averageRating, 0) /
          ratedListings.length
        : 0
    const earnings = await prisma.marketplaceTransaction.aggregate({
      where: { creatorId: c.id, status: 'completed' },
      _sum: { creatorAmountInCents: true },
    })
    await prisma.creatorProfile.update({
      where: { id: c.id },
      data: {
        totalAgentsPublished,
        totalInstalls,
        averageAgentRating: Number(avg.toFixed(2)),
        totalEarningsInCents: earnings._sum.creatorAmountInCents ?? 0,
      },
    })
  }

  console.log('[seed-marketplace] done.')
  console.log(`  · ${creators.length} creators (${creators.map((c) => c.tier).join(', ')})`)
  console.log(`  · ${LISTINGS.length} listings across 7 categories`)
  console.log(`  · workspace: ${workspace.id}`)
  console.log('')
  console.log('Open http://localhost:8081/(app)/marketplace to see them.')
}

main()
  .catch((err) => {
    console.error('[seed-marketplace] failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
