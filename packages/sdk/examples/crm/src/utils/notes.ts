/**
 * Note Server Functions
 * 
 * Demonstrates using shogo.db (Prisma pass-through) for activity logging.
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'

export type NoteType = {
  id: string
  content: string
  type: string // note, call, email, meeting
  contactId: string
  userId: string
  createdAt: Date
  updatedAt: Date
}

// Get notes for a contact (activity log)
export const getNotes = createServerFn({ method: 'POST' })
  .inputValidator((data: { contactId: string; userId: string }) => data)
  .handler(async ({ data }) => {
    // Verify contact ownership
    const contact = await shogo.db.contact.findFirst({
      where: { id: data.contactId, userId: data.userId },
    })
    if (!contact) {
      throw new Error('Contact not found')
    }

    const notes = await shogo.db.note.findMany({
      where: { contactId: data.contactId },
      orderBy: { createdAt: 'desc' },
    })

    return notes as NoteType[]
  })

// Create note (activity log entry)
export const createNote = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    content: string
    type?: string
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

    const note = await shogo.db.note.create({
      data: {
        content: data.content,
        type: data.type ?? 'note',
        contactId: data.contactId,
        userId: data.userId,
      },
    })

    // Update contact's updatedAt to reflect activity
    await shogo.db.contact.update({
      where: { id: data.contactId },
      data: { updatedAt: new Date() },
    })

    return note as NoteType
  })

// Update note
export const updateNote = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    id: string
    userId: string
    content?: string
    type?: string
  }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await shogo.db.note.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Note not found')
    }

    const { id, userId, ...updateData } = data

    const note = await shogo.db.note.update({
      where: { id },
      data: updateData,
    })

    return note as NoteType
  })

// Delete note
export const deleteNote = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    // Verify ownership
    const existing = await shogo.db.note.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Note not found')
    }

    await shogo.db.note.delete({
      where: { id: data.id },
    })

    return { success: true }
  })

// Get recent activity across all contacts
export const getRecentActivity = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string; limit?: number }) => data)
  .handler(async ({ data }) => {
    const notes = await shogo.db.note.findMany({
      where: { userId: data.userId },
      include: {
        contact: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: data.limit ?? 10,
    })

    return notes.map(note => ({
      ...note,
      contactName: `${note.contact.firstName} ${note.contact.lastName}`,
    }))
  })
