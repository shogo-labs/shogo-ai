/**
 * Deal Server Functions
 * 
 * Demonstrates using shogo.db (Prisma pass-through) for sales pipeline management.
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'

export type DealType = {
  id: string
  title: string
  value: number
  stage: string // lead, qualified, proposal, negotiation, won, lost
  contactId: string
  userId: string
  closedAt: Date | null
  createdAt: Date
  updatedAt: Date
  contact?: {
    id: string
    firstName: string
    lastName: string
    company?: {
      id: string
      name: string
    } | null
  }
}

export const DEAL_STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const

// Get deals with optional filtering
export const getDeals = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    userId: string
    stage?: string
    contactId?: string
  }) => data)
  .handler(async ({ data }) => {
    const where: Record<string, unknown> = { userId: data.userId }

    if (data.stage) {
      where.stage = data.stage
    }

    if (data.contactId) {
      where.contactId = data.contactId
    }

    const deals = await shogo.db.deal.findMany({
      where,
      include: {
        contact: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            company: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return deals as DealType[]
  })

// Create deal
export const createDeal = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    title: string
    value?: number
    stage?: string
    contactId: string
    userId: string
  }) => data)
  .handler(async ({ data }) => {
    // Verify contact ownership
    const contact = await shogo.db.contact.findFirst({
      where: { id: data.contactId, userId: data.userId },
    })
    if (!contact) {
      throw new Error('Contact not found')
    }

    const deal = await shogo.db.deal.create({
      data: {
        title: data.title,
        value: data.value ?? 0,
        stage: data.stage ?? 'lead',
        contactId: data.contactId,
        userId: data.userId,
      },
      include: {
        contact: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            company: { select: { id: true, name: true } },
          },
        },
      },
    })

    return deal as DealType
  })

// Update deal (including stage changes)
export const updateDeal = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    id: string
    userId: string
    title?: string
    value?: number
    stage?: string
  }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await shogo.db.deal.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Deal not found')
    }

    const { id, userId, ...updateData } = data

    // Set closedAt if moving to won or lost
    const closedAt = (data.stage === 'won' || data.stage === 'lost')
      ? new Date()
      : (data.stage && data.stage !== 'won' && data.stage !== 'lost')
        ? null
        : undefined

    const deal = await shogo.db.deal.update({
      where: { id },
      data: {
        ...updateData,
        ...(closedAt !== undefined && { closedAt }),
      },
      include: {
        contact: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            company: { select: { id: true, name: true } },
          },
        },
      },
    })

    return deal as DealType
  })

// Delete deal
export const deleteDeal = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await shogo.db.deal.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Deal not found')
    }

    await shogo.db.deal.delete({
      where: { id: data.id },
    })

    return { success: true }
  })

// Get deal pipeline summary
export const getDealPipeline = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string }) => data)
  .handler(async ({ data }) => {
    const deals = await shogo.db.deal.groupBy({
      by: ['stage'],
      where: { userId: data.userId },
      _count: true,
      _sum: { value: true },
    })

    const pipeline = DEAL_STAGES.map(stage => {
      const stageData = deals.find(d => d.stage === stage)
      return {
        stage,
        count: stageData?._count ?? 0,
        value: stageData?._sum.value ?? 0,
      }
    })

    const totalValue = pipeline
      .filter(p => p.stage !== 'lost')
      .reduce((sum, p) => sum + p.value, 0)

    const wonValue = pipeline.find(p => p.stage === 'won')?.value ?? 0

    return {
      pipeline,
      totalValue,
      wonValue,
    }
  })
