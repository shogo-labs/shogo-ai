/**
 * Contact Server Functions
 * 
 * Demonstrates using shogo.db (Prisma pass-through) for CRM contacts.
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'

export type ContactType = {
  id: string
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  title: string | null
  status: string
  source: string | null
  companyId: string | null
  userId: string
  createdAt: Date
  updatedAt: Date
  company?: {
    id: string
    name: string
  } | null
  tags?: Array<{
    tag: {
      id: string
      name: string
      color: string
    }
  }>
  _count?: {
    notes: number
    deals: number
  }
}

export type ContactFilters = {
  userId: string
  search?: string
  status?: string
  companyId?: string
  tagId?: string
  source?: string
}

// Get contacts with filtering and search
export const getContacts = createServerFn({ method: 'POST' })
  .inputValidator((data: ContactFilters) => data)
  .handler(async ({ data }) => {
    const where: Record<string, unknown> = { userId: data.userId }

    // Status filter
    if (data.status) {
      where.status = data.status
    }

    // Company filter
    if (data.companyId) {
      where.companyId = data.companyId
    }

    // Source filter
    if (data.source) {
      where.source = data.source
    }

    // Tag filter (contacts that have this tag)
    if (data.tagId) {
      where.tags = {
        some: { tagId: data.tagId },
      }
    }

    // Search across multiple fields
    if (data.search) {
      where.OR = [
        { firstName: { contains: data.search } },
        { lastName: { contains: data.search } },
        { email: { contains: data.search } },
        { phone: { contains: data.search } },
        { company: { name: { contains: data.search } } },
      ]
    }

    const contacts = await shogo.db.contact.findMany({
      where,
      include: {
        company: { select: { id: true, name: true } },
        tags: {
          include: {
            tag: { select: { id: true, name: true, color: true } },
          },
        },
        _count: {
          select: { notes: true, deals: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    })

    return contacts as ContactType[]
  })

// Get single contact with full details
export const getContact = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    const contact = await shogo.db.contact.findFirst({
      where: { id: data.id, userId: data.userId },
      include: {
        company: { select: { id: true, name: true } },
        tags: {
          include: {
            tag: { select: { id: true, name: true, color: true } },
          },
        },
        _count: {
          select: { notes: true, deals: true },
        },
      },
    })
    return contact as ContactType | null
  })

// Create contact
export const createContact = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    firstName: string
    lastName: string
    email?: string
    phone?: string
    title?: string
    status?: string
    source?: string
    companyId?: string
    tagIds?: string[]
    userId: string
  }) => data)
  .handler(async ({ data }) => {
    const { tagIds, ...contactData } = data

    const contact = await shogo.db.contact.create({
      data: {
        ...contactData,
        // Create tag associations if provided
        tags: tagIds?.length ? {
          create: tagIds.map(tagId => ({ tagId })),
        } : undefined,
      },
      include: {
        company: { select: { id: true, name: true } },
        tags: {
          include: {
            tag: { select: { id: true, name: true, color: true } },
          },
        },
      },
    })

    return contact as ContactType
  })

// Update contact
export const updateContact = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    id: string
    userId: string
    firstName?: string
    lastName?: string
    email?: string
    phone?: string
    title?: string
    status?: string
    source?: string
    companyId?: string | null
    tagIds?: string[]
  }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await shogo.db.contact.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Contact not found')
    }

    const { id, userId, tagIds, ...updateData } = data

    // Handle tag updates: remove old, add new
    if (tagIds !== undefined) {
      await shogo.db.contactTag.deleteMany({
        where: { contactId: id },
      })
      if (tagIds.length > 0) {
        await shogo.db.contactTag.createMany({
          data: tagIds.map(tagId => ({ contactId: id, tagId })),
        })
      }
    }

    const contact = await shogo.db.contact.update({
      where: { id },
      data: updateData,
      include: {
        company: { select: { id: true, name: true } },
        tags: {
          include: {
            tag: { select: { id: true, name: true, color: true } },
          },
        },
      },
    })

    return contact as ContactType
  })

// Delete contact
export const deleteContact = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await shogo.db.contact.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Contact not found')
    }

    await shogo.db.contact.delete({
      where: { id: data.id },
    })

    return { success: true }
  })

// Get contact statistics
export const getContactStats = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string }) => data)
  .handler(async ({ data }) => {
    const [total, byStatus] = await Promise.all([
      shogo.db.contact.count({ where: { userId: data.userId } }),
      shogo.db.contact.groupBy({
        by: ['status'],
        where: { userId: data.userId },
        _count: true,
      }),
    ])

    const statusCounts = Object.fromEntries(
      byStatus.map(s => [s.status, s._count])
    )

    return {
      total,
      leads: statusCounts.lead ?? 0,
      prospects: statusCounts.prospect ?? 0,
      customers: statusCounts.customer ?? 0,
      churned: statusCounts.churned ?? 0,
    }
  })
