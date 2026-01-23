/**
 * Company Server Functions
 * 
 * Demonstrates using shogo.db (Prisma pass-through) for CRM companies.
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'

export type CompanyType = {
  id: string
  name: string
  website: string | null
  industry: string | null
  size: string | null
  address: string | null
  userId: string
  createdAt: Date
  updatedAt: Date
  _count?: {
    contacts: number
  }
}

// Get all companies
export const getCompanies = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string; search?: string }) => data)
  .handler(async ({ data }) => {
    const where: Record<string, unknown> = { userId: data.userId }

    if (data.search) {
      where.OR = [
        { name: { contains: data.search } },
        { industry: { contains: data.search } },
      ]
    }

    const companies = await shogo.db.company.findMany({
      where,
      include: {
        _count: { select: { contacts: true } },
      },
      orderBy: { name: 'asc' },
    })

    return companies as CompanyType[]
  })

// Create company
export const createCompany = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    name: string
    website?: string
    industry?: string
    size?: string
    address?: string
    userId: string
  }) => data)
  .handler(async ({ data }) => {
    const company = await shogo.db.company.create({
      data,
      include: {
        _count: { select: { contacts: true } },
      },
    })

    return company as CompanyType
  })

// Update company
export const updateCompany = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    id: string
    userId: string
    name?: string
    website?: string
    industry?: string
    size?: string
    address?: string
  }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await shogo.db.company.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Company not found')
    }

    const { id, userId, ...updateData } = data

    const company = await shogo.db.company.update({
      where: { id },
      data: updateData,
      include: {
        _count: { select: { contacts: true } },
      },
    })

    return company as CompanyType
  })

// Delete company
export const deleteCompany = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await shogo.db.company.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Company not found')
    }

    await shogo.db.company.delete({
      where: { id: data.id },
    })

    return { success: true }
  })
