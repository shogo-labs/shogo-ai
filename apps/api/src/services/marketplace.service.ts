// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { customAlphabet } from 'nanoid';

import {
  prisma,
  type CreatorProfile,
  type MarketplaceListing,
  type MarketplaceReview,
  type MarketplaceTransaction,
  type Prisma,
  PricingModel,
} from '../lib/prisma';

const slugSuffix = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 6);
const isSqlite = process.env.SHOGO_LOCAL_MODE === 'true';

export type CreateCreatorProfileData = Omit<
  Prisma.CreatorProfileUncheckedCreateInput,
  'userId' | 'id'
>;

export type UpdateCreatorProfileData = Omit<
  Prisma.CreatorProfileUncheckedUpdateInput,
  'id' | 'userId'
>;

export type CreateListingData = Pick<
  Prisma.MarketplaceListingUncheckedCreateInput,
  'title' | 'shortDescription'
> &
  Partial<
    Pick<
      Prisma.MarketplaceListingUncheckedCreateInput,
      | 'longDescription'
      | 'category'
      | 'tags'
      | 'iconUrl'
      | 'screenshotUrls'
      | 'pricingModel'
      | 'priceInCents'
      | 'monthlyPriceInCents'
      | 'annualPriceInCents'
      | 'installModel'
      | 'currentVersion'
      | 'stripePriceId'
      | 'stripeMonthlyPriceId'
      | 'stripeAnnualPriceId'
    >
  >;

export type UpdateListingData = Partial<
  Pick<
    Prisma.MarketplaceListingUncheckedUpdateInput,
    | 'slug'
    | 'title'
    | 'shortDescription'
    | 'longDescription'
    | 'category'
    | 'tags'
    | 'iconUrl'
    | 'screenshotUrls'
    | 'pricingModel'
    | 'priceInCents'
    | 'monthlyPriceInCents'
    | 'annualPriceInCents'
    | 'installModel'
    | 'currentVersion'
    | 'stripePriceId'
    | 'stripeMonthlyPriceId'
    | 'stripeAnnualPriceId'
    | 'status'
  >
>;

export type ListingSort = 'popular' | 'rating' | 'newest' | 'featured';

export interface BrowseListingsOptions {
  category?: string;
  pricingModel?: PricingModel;
  tags?: string[];
  sort?: ListingSort;
  page?: number;
  limit?: number;
}

export type SearchListingsOptions = BrowseListingsOptions;

export interface PaginatedListingsResult {
  items: MarketplaceListing[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface PaginatedReviewsResult {
  items: MarketplaceReview[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface PaginatedTransactionsResult {
  items: MarketplaceTransaction[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export type ListingWithCreator = Prisma.MarketplaceListingGetPayload<{
  include: { creator: true };
}>;

export interface CreateReviewData {
  rating: number;
  title?: string | null;
  body?: string | null;
}

export interface CreatorDashboardListingStats {
  id: string;
  slug: string;
  title: string;
  status: MarketplaceListing['status'];
  installCount: number;
  averageRating: number;
  reviewCount: number;
  totalEarningsInCents: number;
}

export interface CreatorDashboardResult {
  profile: CreatorProfile;
  totalReviews: number;
  listings: CreatorDashboardListingStats[];
}

function slugifyTitle(title: string): string {
  const s = title
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s.length > 0 ? s : 'listing';
}

export async function generateSlug(title: string): Promise<string> {
  const base = slugifyTitle(title);
  let candidate = base;
  const taken = async (slug: string) =>
    (await prisma.marketplaceListing.findUnique({ where: { slug } })) != null;
  if (!(await taken(candidate))) return candidate;
  for (let i = 0; i < 32; i++) {
    candidate = `${base}-${slugSuffix()}`;
    if (!(await taken(candidate))) return candidate;
  }
  throw new Error('Could not generate a unique listing slug');
}

function normalizePagination(page?: number, limit?: number): { page: number; limit: number; skip: number } {
  const p = Math.max(1, page ?? 1);
  const l = Math.min(100, Math.max(1, limit ?? 20));
  return { page: p, limit: l, skip: (p - 1) * l };
}

function publishedListingBaseWhere(
  extra: Prisma.MarketplaceListingWhereInput = {}
): Prisma.MarketplaceListingWhereInput {
  return { status: 'published', ...extra };
}

function browseFilters(options: BrowseListingsOptions): Prisma.MarketplaceListingWhereInput {
  const where: Prisma.MarketplaceListingWhereInput = {};
  if (options.category != null && options.category !== '') {
    where.category = options.category;
  }
  if (options.pricingModel != null) {
    where.pricingModel = options.pricingModel;
  }
  if (options.tags != null && options.tags.length > 0) {
    if (isSqlite) {
      where.AND = options.tags.map((t) => ({ tags: { contains: t } }));
    } else {
      where.tags = { hasEvery: options.tags } as any;
    }
  }
  return where;
}

function listingOrderBy(sort: ListingSort | undefined): Prisma.MarketplaceListingOrderByWithRelationInput[] {
  switch (sort ?? 'newest') {
    case 'popular':
      return [{ installCount: 'desc' }, { publishedAt: 'desc' }];
    case 'rating':
      return [{ averageRating: 'desc' }, { reviewCount: 'desc' }, { publishedAt: 'desc' }];
    case 'featured':
      if (isSqlite) {
        return [{ featuredAt: 'desc' }, { publishedAt: 'desc' }];
      }
      return [
        { featuredAt: { sort: 'desc', nulls: 'last' } },
        { publishedAt: 'desc' },
      ];
    case 'newest':
    default:
      return [{ publishedAt: 'desc' }];
  }
}

export async function createCreatorProfile(
  userId: string,
  data: CreateCreatorProfileData
): Promise<CreatorProfile> {
  return prisma.creatorProfile.create({
    data: { ...data, userId },
  });
}

export async function getCreatorProfile(userId: string): Promise<CreatorProfile | null> {
  return prisma.creatorProfile.findUnique({ where: { userId } });
}

export async function getCreatorProfileById(id: string): Promise<CreatorProfile | null> {
  return prisma.creatorProfile.findUnique({ where: { id } });
}

export async function updateCreatorProfile(
  userId: string,
  data: UpdateCreatorProfileData
): Promise<CreatorProfile> {
  return prisma.creatorProfile.update({
    where: { userId },
    data,
  });
}

export async function createListing(
  creatorId: string,
  projectId: string,
  data: CreateListingData
): Promise<MarketplaceListing> {
  const slug = await generateSlug(data.title);
  return prisma.marketplaceListing.create({
    data: {
      creatorId,
      projectId,
      slug,
      title: data.title,
      shortDescription: data.shortDescription,
      longDescription: data.longDescription ?? undefined,
      category: data.category ?? undefined,
      tags: data.tags ?? undefined,
      iconUrl: data.iconUrl ?? undefined,
      screenshotUrls: data.screenshotUrls ?? undefined,
      pricingModel: data.pricingModel ?? undefined,
      priceInCents: data.priceInCents ?? undefined,
      monthlyPriceInCents: data.monthlyPriceInCents ?? undefined,
      annualPriceInCents: data.annualPriceInCents ?? undefined,
      installModel: data.installModel ?? undefined,
      currentVersion: data.currentVersion ?? undefined,
      stripePriceId: data.stripePriceId ?? undefined,
      stripeMonthlyPriceId: data.stripeMonthlyPriceId ?? undefined,
      stripeAnnualPriceId: data.stripeAnnualPriceId ?? undefined,
      status: 'draft',
    },
  });
}

export async function updateListing(
  listingId: string,
  creatorId: string,
  data: UpdateListingData
): Promise<MarketplaceListing> {
  const existing = await prisma.marketplaceListing.findFirst({
    where: { id: listingId, creatorId },
  });
  if (!existing) {
    throw new Error('Listing not found or not owned by this creator');
  }
  return prisma.marketplaceListing.update({
    where: { id: listingId },
    data,
  });
}

export async function publishListing(listingId: string, creatorId: string): Promise<MarketplaceListing> {
  const existing = await prisma.marketplaceListing.findFirst({
    where: { id: listingId, creatorId },
  });
  if (!existing) {
    throw new Error('Listing not found or not owned by this creator');
  }
  if (existing.status !== 'draft' && existing.status !== 'in_review') {
    throw new Error('Only draft or in-review listings can be published');
  }
  const now = new Date();
  return prisma.marketplaceListing.update({
    where: { id: listingId },
    data: {
      status: 'published',
      publishedAt: now,
    },
  });
}

export async function unpublishListing(listingId: string, creatorId: string): Promise<MarketplaceListing> {
  const existing = await prisma.marketplaceListing.findFirst({
    where: { id: listingId, creatorId },
  });
  if (!existing) {
    throw new Error('Listing not found or not owned by this creator');
  }
  return prisma.marketplaceListing.update({
    where: { id: listingId },
    data: { status: 'archived' },
  });
}

export async function getListingBySlug(slug: string): Promise<ListingWithCreator | null> {
  return prisma.marketplaceListing.findFirst({
    where: { slug, status: 'published' },
    include: { creator: true },
  });
}

export async function getListingById(id: string): Promise<MarketplaceListing | null> {
  return prisma.marketplaceListing.findUnique({ where: { id } });
}

export async function getCreatorListings(creatorId: string): Promise<MarketplaceListing[]> {
  return prisma.marketplaceListing.findMany({
    where: { creatorId },
    orderBy: { updatedAt: 'desc' },
  });
}

export async function browseListings(options: BrowseListingsOptions = {}): Promise<PaginatedListingsResult> {
  const { page, limit, skip } = normalizePagination(options.page, options.limit);
  const where = publishedListingBaseWhere(browseFilters(options));
  const orderBy = listingOrderBy(options.sort);
  const [items, total] = await Promise.all([
    prisma.marketplaceListing.findMany({
      where,
      orderBy,
      skip,
      take: limit,
    }),
    prisma.marketplaceListing.count({ where }),
  ]);
  return {
    items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

export async function searchListings(
  query: string,
  options: SearchListingsOptions = {}
): Promise<PaginatedListingsResult> {
  const q = query.trim();
  if (q === '') {
    return browseListings(options);
  }
  const tokens = q.split(/\s+/).filter(Boolean);
  const { page, limit, skip } = normalizePagination(options.page, options.limit);
  const filter = browseFilters(options);
  const containsOpt = isSqlite
    ? (v: string) => ({ contains: v } as any)
    : (v: string) => ({ contains: v, mode: 'insensitive' } as any);

  const searchOr: Prisma.MarketplaceListingWhereInput[] = [
    { title: containsOpt(q) },
    { shortDescription: containsOpt(q) },
  ];
  if (tokens.length > 0) {
    if (isSqlite) {
      searchOr.push(...tokens.map((t) => ({ tags: { contains: t } } as Prisma.MarketplaceListingWhereInput)));
    } else {
      searchOr.push({ tags: { hasSome: tokens } } as any);
    }
  }
  const where: Prisma.MarketplaceListingWhereInput = {
    ...publishedListingBaseWhere(),
    ...filter,
    OR: searchOr,
  };
  const orderBy = listingOrderBy(options.sort);
  const [items, total] = await Promise.all([
    prisma.marketplaceListing.findMany({
      where,
      orderBy,
      skip,
      take: limit,
    }),
    prisma.marketplaceListing.count({ where }),
  ]);
  return {
    items,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

export async function getFeaturedListings(limit = 12): Promise<MarketplaceListing[]> {
  const take = Math.min(100, Math.max(1, limit));
  return prisma.marketplaceListing.findMany({
    where: publishedListingBaseWhere({
      featuredAt: { not: null },
    }),
    orderBy: [{ featuredAt: 'desc' }, { publishedAt: 'desc' }],
    take,
  });
}

export async function createReview(
  listingId: string,
  userId: string,
  installId: string,
  data: CreateReviewData
): Promise<MarketplaceReview> {
  const { rating, title, body } = data;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error('Rating must be an integer from 1 to 5');
  }
  const install = await prisma.marketplaceInstall.findFirst({
    where: { id: installId, userId, listingId },
  });
  if (!install) {
    throw new Error('Install not found for this user and listing');
  }
  return prisma.$transaction(async (tx) => {
    const review = await tx.marketplaceReview.create({
      data: {
        listingId,
        userId,
        installId,
        rating,
        title: title ?? undefined,
        body: body ?? undefined,
      },
    });
    const agg = await tx.marketplaceReview.aggregate({
      where: { listingId },
      _avg: { rating: true },
      _count: { _all: true },
    });
    await tx.marketplaceListing.update({
      where: { id: listingId },
      data: {
        averageRating: agg._avg.rating ?? 0,
        reviewCount: agg._count._all,
      },
    });
    return review;
  });
}

export async function getReviews(
  listingId: string,
  page?: number,
  limit?: number
): Promise<PaginatedReviewsResult> {
  const { page: p, limit: l, skip } = normalizePagination(page, limit);
  const where = { listingId };
  const [items, total] = await Promise.all([
    prisma.marketplaceReview.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: l,
    }),
    prisma.marketplaceReview.count({ where }),
  ]);
  return {
    items,
    total,
    page: p,
    limit: l,
    totalPages: Math.ceil(total / l) || 1,
  };
}

export async function getUserReview(
  listingId: string,
  userId: string
): Promise<MarketplaceReview | null> {
  return prisma.marketplaceReview.findUnique({
    where: { listingId_userId: { listingId, userId } },
  });
}

export async function getCreatorDashboard(creatorId: string): Promise<CreatorDashboardResult | null> {
  const profile = await prisma.creatorProfile.findUnique({ where: { id: creatorId } });
  if (!profile) return null;
  const listings = await prisma.marketplaceListing.findMany({
    where: { creatorId },
    select: {
      id: true,
      slug: true,
      title: true,
      status: true,
      installCount: true,
      averageRating: true,
      reviewCount: true,
    },
    orderBy: { updatedAt: 'desc' },
  });
  const totalReviews = await prisma.marketplaceReview.count({
    where: { listing: { creatorId } },
  });
  const earningsByListing = await prisma.marketplaceTransaction.groupBy({
    by: ['listingId'],
    where: {
      creatorId,
      status: 'completed',
    },
    _sum: { creatorAmountInCents: true },
  });
  const earningsMap = new Map(
    earningsByListing.map((row) => [row.listingId, row._sum.creatorAmountInCents ?? 0])
  );
  const listingStats: CreatorDashboardListingStats[] = listings.map((L) => ({
    id: L.id,
    slug: L.slug,
    title: L.title,
    status: L.status,
    installCount: L.installCount,
    averageRating: L.averageRating,
    reviewCount: L.reviewCount,
    totalEarningsInCents: earningsMap.get(L.id) ?? 0,
  }));
  return { profile, totalReviews, listings: listingStats };
}

export async function getCreatorTransactions(
  creatorId: string,
  page?: number,
  limit?: number
): Promise<PaginatedTransactionsResult> {
  const { page: p, limit: l, skip } = normalizePagination(page, limit);
  const where = { creatorId };
  const [items, total] = await Promise.all([
    prisma.marketplaceTransaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: l,
    }),
    prisma.marketplaceTransaction.count({ where }),
  ]);
  return {
    items,
    total,
    page: p,
    limit: l,
    totalPages: Math.ceil(total / l) || 1,
  };
}
