/**
 * Form Server Functions
 * 
 * Demonstrates CRUD operations with nested includes for forms and their fields.
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'

export type FieldType = {
  id: string
  formId: string
  type: string
  label: string
  placeholder: string | null
  helpText: string | null
  position: number
  isRequired: boolean
  options: string | null
  createdAt: Date
  updatedAt: Date
}

export type FormType = {
  id: string
  name: string
  description: string | null
  slug: string
  isPublished: boolean
  isAcceptingResponses: boolean
  primaryColor: string
  submitButtonText: string
  successMessage: string
  userId: string
  createdAt: Date
  updatedAt: Date
  fields?: FieldType[]
  _count?: {
    submissions: number
  }
}

// Generate a unique slug
function generateSlug(): string {
  return Math.random().toString(36).substring(2, 10)
}

// List all forms for a user
export const getForms = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string }) => data)
  .handler(async ({ data }) => {
    const forms = await shogo.db.form.findMany({
      where: { userId: data.userId },
      include: {
        _count: {
          select: { submissions: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
    return forms as FormType[]
  })

// Get a single form with fields
export const getForm = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    const form = await shogo.db.form.findFirst({
      where: { id: data.id, userId: data.userId },
      include: {
        fields: {
          orderBy: { position: 'asc' },
        },
        _count: {
          select: { submissions: true },
        },
      },
    })
    return form as FormType | null
  })

// Get form by slug (public access)
export const getFormBySlug = createServerFn({ method: 'POST' })
  .inputValidator((data: { slug: string }) => data)
  .handler(async ({ data }) => {
    const form = await shogo.db.form.findUnique({
      where: { slug: data.slug },
      include: {
        fields: {
          orderBy: { position: 'asc' },
        },
        user: {
          select: { name: true, email: true },
        },
      },
    })
    return form as (FormType & { user: { name: string | null; email: string } }) | null
  })

// Create a new form
export const createForm = createServerFn({ method: 'POST' })
  .inputValidator((data: { userId: string; name: string; description?: string }) => data)
  .handler(async ({ data }) => {
    // Generate unique slug
    let slug = generateSlug()
    let exists = await shogo.db.form.findUnique({ where: { slug } })
    while (exists) {
      slug = generateSlug()
      exists = await shogo.db.form.findUnique({ where: { slug } })
    }

    const form = await shogo.db.form.create({
      data: {
        name: data.name,
        description: data.description,
        slug,
        userId: data.userId,
      },
      include: {
        fields: true,
      },
    })
    return form as FormType
  })

// Update form settings
export const updateForm = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    id: string
    userId: string
    name?: string
    description?: string
    isPublished?: boolean
    isAcceptingResponses?: boolean
    primaryColor?: string
    submitButtonText?: string
    successMessage?: string
  }) => data)
  .handler(async ({ data }) => {
    const { id, userId, ...updateData } = data

    // Verify ownership
    const existing = await shogo.db.form.findFirst({
      where: { id, userId },
    })
    if (!existing) {
      throw new Error('Form not found')
    }

    const form = await shogo.db.form.update({
      where: { id },
      data: updateData,
      include: {
        fields: {
          orderBy: { position: 'asc' },
        },
      },
    })
    return form as FormType
  })

// Delete a form
export const deleteForm = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    const existing = await shogo.db.form.findFirst({
      where: { id: data.id, userId: data.userId },
    })
    if (!existing) {
      throw new Error('Form not found')
    }

    await shogo.db.form.delete({
      where: { id: data.id },
    })
    return { success: true }
  })
