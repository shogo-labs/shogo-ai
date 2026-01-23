/**
 * Field Server Functions
 * 
 * Demonstrates position ordering and JSON field storage for dynamic form fields.
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'
import type { FieldType } from './forms'

export type FieldOption = {
  value: string
  label: string
}

// Field types available
export const FIELD_TYPES = [
  { value: 'text', label: 'Short Text' },
  { value: 'textarea', label: 'Long Text' },
  { value: 'email', label: 'Email' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Dropdown' },
  { value: 'radio', label: 'Multiple Choice' },
  { value: 'checkbox', label: 'Checkboxes' },
  { value: 'rating', label: 'Rating' },
] as const

// Add a field to a form
export const addField = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    formId: string
    userId: string
    type: string
    label: string
    placeholder?: string
    helpText?: string
    isRequired?: boolean
    options?: FieldOption[]
  }) => data)
  .handler(async ({ data }) => {
    // Verify form ownership
    const form = await shogo.db.form.findFirst({
      where: { id: data.formId, userId: data.userId },
    })
    if (!form) {
      throw new Error('Form not found')
    }

    // Get max position
    const lastField = await shogo.db.field.findFirst({
      where: { formId: data.formId },
      orderBy: { position: 'desc' },
    })
    const position = lastField ? lastField.position + 1 : 0

    const field = await shogo.db.field.create({
      data: {
        formId: data.formId,
        type: data.type,
        label: data.label,
        placeholder: data.placeholder,
        helpText: data.helpText,
        isRequired: data.isRequired ?? false,
        options: data.options ? JSON.stringify(data.options) : null,
        position,
      },
    })
    return field as FieldType
  })

// Update a field
export const updateField = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    id: string
    userId: string
    label?: string
    placeholder?: string
    helpText?: string
    isRequired?: boolean
    options?: FieldOption[]
  }) => data)
  .handler(async ({ data }) => {
    const { id, userId, options, ...updateData } = data

    // Verify ownership through form
    const existing = await shogo.db.field.findUnique({
      where: { id },
      include: { form: true },
    })
    if (!existing || existing.form.userId !== userId) {
      throw new Error('Field not found')
    }

    const field = await shogo.db.field.update({
      where: { id },
      data: {
        ...updateData,
        options: options !== undefined ? JSON.stringify(options) : undefined,
      },
    })
    return field as FieldType
  })

// Delete a field
export const deleteField = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    // Verify ownership through form
    const existing = await shogo.db.field.findUnique({
      where: { id: data.id },
      include: { form: true },
    })
    if (!existing || existing.form.userId !== data.userId) {
      throw new Error('Field not found')
    }

    await shogo.db.field.delete({
      where: { id: data.id },
    })

    // Reorder remaining fields
    const remainingFields = await shogo.db.field.findMany({
      where: { formId: existing.formId },
      orderBy: { position: 'asc' },
    })

    for (let i = 0; i < remainingFields.length; i++) {
      await shogo.db.field.update({
        where: { id: remainingFields[i].id },
        data: { position: i },
      })
    }

    return { success: true }
  })

// Reorder fields (move field to new position)
export const reorderFields = createServerFn({ method: 'POST' })
  .inputValidator((data: { formId: string; userId: string; fieldIds: string[] }) => data)
  .handler(async ({ data }) => {
    // Verify form ownership
    const form = await shogo.db.form.findFirst({
      where: { id: data.formId, userId: data.userId },
    })
    if (!form) {
      throw new Error('Form not found')
    }

    // Update positions
    for (let i = 0; i < data.fieldIds.length; i++) {
      await shogo.db.field.update({
        where: { id: data.fieldIds[i] },
        data: { position: i },
      })
    }

    return { success: true }
  })

// Helper to parse options from JSON string
export function parseFieldOptions(optionsJson: string | null): FieldOption[] {
  if (!optionsJson) return []
  try {
    return JSON.parse(optionsJson)
  } catch {
    return []
  }
}
