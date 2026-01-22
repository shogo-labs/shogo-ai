/**
 * Tag Server Functions
 * 
 * Demonstrates using shogo.db (Prisma pass-through) for many-to-many relations.
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'

export type TagType = {
  id: string
  name: string
  color: string
  userId: string
  createdAt: Date
  updatedAt: Date
  _count?: {
    contacts: number
  }
}

// Get all tags with contact counts
export const getTags = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string }) => data)
  .handler(async ({ data }) => {
    const tags = await shogo.db.tag.findMany({
      where: { userId: data.userId },
      include: {
        _count: { select: { contacts: true } },
      },
      orderBy: { name: 'asc' },
    })

    return tags as TagType[]
  })

// Create tag
export const createTag = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    name: string
    color?: string
    userId: string
  }) => data)
  .handler(async ({ data }) => {
    // Check for duplicate
    const existing = await shogo.db.tag.findFirst({
      where: { userId: data.userId, name: data.name },
    })
    if (existing) {
      throw new Error('Tag with this name already exists')
    }

    const tag = await shogo.db.tag.create({
      data,
      include: {
        _count: { select: { contacts: true } },
      },
    })

    return tag as TagType
  })

// Update tag
export const updateTag = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    id: string
    userId: string
    name?: string
    color?: string
  }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await shogo.db.tag.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Tag not found')
    }

    const { id, userId, ...updateData } = data

    const tag = await shogo.db.tag.update({
      where: { id },
      data: updateData,
      include: {
        _count: { select: { contacts: true } },
      },
    })

    return tag as TagType
  })

// Delete tag
export const deleteTag = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await shogo.db.tag.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Tag not found')
    }

    await shogo.db.tag.delete({
      where: { id: data.id },
    })

    return { success: true }
  })

// Add tag to contact (many-to-many operation)
export const addTagToContact = createServerFn({ method: 'POST' })
  .inputValidator((data: { contactId: string; tagId: string; userId: string }) => data)
  .handler(async ({ data }) => {
    // Verify ownership of both contact and tag
    const [contact, tag] = await Promise.all([
      shogo.db.contact.findFirst({ where: { id: data.contactId, userId: data.userId } }),
      shogo.db.tag.findFirst({ where: { id: data.tagId, userId: data.userId } }),
    ])

    if (!contact) throw new Error('Contact not found')
    if (!tag) throw new Error('Tag not found')

    // Check if already associated
    const existing = await shogo.db.contactTag.findUnique({
      where: {
        contactId_tagId: {
          contactId: data.contactId,
          tagId: data.tagId,
        },
      },
    })

    if (existing) {
      return { success: true, message: 'Tag already associated' }
    }

    await shogo.db.contactTag.create({
      data: {
        contactId: data.contactId,
        tagId: data.tagId,
      },
    })

    return { success: true }
  })

// Remove tag from contact
export const removeTagFromContact = createServerFn({ method: 'POST' })
  .inputValidator((data: { contactId: string; tagId: string; userId: string }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const contact = await shogo.db.contact.findFirst({
      where: { id: data.contactId, userId: data.userId },
    })
    if (!contact) throw new Error('Contact not found')

    await shogo.db.contactTag.deleteMany({
      where: {
        contactId: data.contactId,
        tagId: data.tagId,
      },
    })

    return { success: true }
  })
