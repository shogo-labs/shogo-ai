/**
 * Submission Server Functions
 * 
 * Custom submission functions with business logic.
 * Basic CRUD operations are in ../generated/server-functions.ts
 * 
 * This file contains:
 * - Custom filtered listing
 * - Mark as read toggle
 * - Star toggle
 * - Statistics aggregation
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'
import type { SubmissionType } from '../generated/types'

// Re-export type
export type { SubmissionType }

export type SubmissionStats = {
  total: number
  unread: number
  starred: number
  averageRating: number
  byCategory: { category: string; count: number }[]
  byRating: { rating: number; count: number }[]
  recommendRate: number
}

// Get all submissions for a user with optional filter
export const getSubmissions = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string; filter?: 'all' | 'unread' | 'starred' }) => data)
  .handler(async ({ data }) => {
    const where: Record<string, unknown> = { userId: data.userId }
    
    if (data.filter === 'unread') {
      where.isRead = false
    } else if (data.filter === 'starred') {
      where.isStarred = true
    }

    const submissions = await shogo.db.submission.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })
    return submissions as SubmissionType[]
  })

// Mark submission as read/unread
export const markAsRead = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string; isRead: boolean }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await shogo.db.submission.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Submission not found')
    }

    const submission = await shogo.db.submission.update({
      where: { id: data.id },
      data: { isRead: data.isRead },
    })
    return submission as SubmissionType
  })

// Toggle star on submission
export const toggleStar = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string; isStarred: boolean }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await shogo.db.submission.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Submission not found')
    }

    const submission = await shogo.db.submission.update({
      where: { id: data.id },
      data: { isStarred: data.isStarred },
    })
    return submission as SubmissionType
  })

// Delete a submission
export const deleteSubmission = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await shogo.db.submission.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Submission not found')
    }

    await shogo.db.submission.delete({
      where: { id: data.id },
    })
    return { success: true }
  })

// Get submission statistics (aggregations)
export const getStats = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string }) => data)
  .handler(async ({ data }) => {
    // Get all submissions for aggregation
    const submissions = await shogo.db.submission.findMany({
      where: { userId: data.userId },
    })

    const total = submissions.length
    const unread = submissions.filter(s => !s.isRead).length
    const starred = submissions.filter(s => s.isStarred).length
    
    // Calculate average rating
    const averageRating = total > 0 
      ? submissions.reduce((sum, s) => sum + s.rating, 0) / total 
      : 0

    // Group by category
    const categoryMap = new Map<string, number>()
    submissions.forEach(s => {
      categoryMap.set(s.category, (categoryMap.get(s.category) || 0) + 1)
    })
    const byCategory = Array.from(categoryMap.entries()).map(([category, count]) => ({
      category,
      count,
    }))

    // Group by rating
    const ratingMap = new Map<number, number>()
    submissions.forEach(s => {
      ratingMap.set(s.rating, (ratingMap.get(s.rating) || 0) + 1)
    })
    const byRating = Array.from(ratingMap.entries())
      .map(([rating, count]) => ({ rating, count }))
      .sort((a, b) => a.rating - b.rating)

    // Calculate recommend rate
    const recommendCount = submissions.filter(s => s.wouldRecommend).length
    const recommendRate = total > 0 ? (recommendCount / total) * 100 : 0

    return {
      total,
      unread,
      starred,
      averageRating: Math.round(averageRating * 10) / 10,
      byCategory,
      byRating,
      recommendRate: Math.round(recommendRate),
    } as SubmissionStats
  })

// Create a submission (public - no auth required for respondent)
export const createSubmission = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    userId: string // The form owner's ID
    name: string
    email: string
    rating: number
    category: string
    message: string
    wouldRecommend: boolean
  }) => data)
  .handler(async ({ data }) => {
    // Verify the user (form owner) exists
    const user = await shogo.db.user.findUnique({
      where: { id: data.userId },
    })
    if (!user) {
      throw new Error('Form not found')
    }

    const submission = await shogo.db.submission.create({
      data: {
        name: data.name,
        email: data.email,
        rating: data.rating,
        category: data.category,
        message: data.message,
        wouldRecommend: data.wouldRecommend,
        userId: data.userId,
      },
    })
    return submission as SubmissionType
  })
