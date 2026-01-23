/**
 * Submission Server Functions
 * 
 * Demonstrates nested creates and aggregations for form responses.
 */

import { createServerFn } from '@tanstack/react-start'
import { shogo } from '../lib/shogo'

export type ResponseType = {
  id: string
  submissionId: string
  fieldId: string
  value: string
  createdAt: Date
  field?: {
    id: string
    label: string
    type: string
  }
}

export type SubmissionType = {
  id: string
  formId: string
  respondentEmail: string | null
  isRead: boolean
  createdAt: Date
  updatedAt: Date
  responses?: ResponseType[]
}

export type FormStats = {
  total: number
  unread: number
  today: number
}

// Get submissions for a form
export const getSubmissions = createServerFn({ method: 'POST' })
  .inputValidator((data: { formId: string; userId: string }) => data)
  .handler(async ({ data }) => {
    // Verify form ownership
    const form = await shogo.db.form.findFirst({
      where: { id: data.formId, userId: data.userId },
    })
    if (!form) {
      throw new Error('Form not found')
    }

    const submissions = await shogo.db.submission.findMany({
      where: { formId: data.formId },
      include: {
        responses: {
          include: {
            field: {
              select: { id: true, label: true, type: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
    return submissions as SubmissionType[]
  })

// Get a single submission
export const getSubmission = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    const submission = await shogo.db.submission.findUnique({
      where: { id: data.id },
      include: {
        responses: {
          include: {
            field: {
              select: { id: true, label: true, type: true },
            },
          },
        },
        form: {
          select: { userId: true, name: true },
        },
      },
    })

    if (!submission || submission.form.userId !== data.userId) {
      throw new Error('Submission not found')
    }

    return submission as SubmissionType & { form: { name: string } }
  })

// Create a submission (public)
export const createSubmission = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    formId: string
    respondentEmail?: string
    responses: { fieldId: string; value: string }[]
  }) => data)
  .handler(async ({ data }) => {
    // Check form exists and is accepting responses
    const form = await shogo.db.form.findUnique({
      where: { id: data.formId },
      include: { fields: true },
    })

    if (!form) {
      throw new Error('Form not found')
    }

    if (!form.isPublished) {
      throw new Error('Form is not published')
    }

    if (!form.isAcceptingResponses) {
      throw new Error('Form is not accepting responses')
    }

    // Validate required fields
    const requiredFieldIds = form.fields
      .filter(f => f.isRequired)
      .map(f => f.id)

    for (const fieldId of requiredFieldIds) {
      const response = data.responses.find(r => r.fieldId === fieldId)
      if (!response || !response.value.trim()) {
        const field = form.fields.find(f => f.id === fieldId)
        throw new Error(`${field?.label || 'Field'} is required`)
      }
    }

    // Create submission with responses
    const submission = await shogo.db.submission.create({
      data: {
        formId: data.formId,
        respondentEmail: data.respondentEmail,
        responses: {
          create: data.responses.map(r => ({
            fieldId: r.fieldId,
            value: r.value,
          })),
        },
      },
      include: {
        responses: true,
      },
    })

    return submission as SubmissionType
  })

// Mark submission as read
export const markAsRead = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string; isRead: boolean }) => data)
  .handler(async ({ data }) => {
    // Verify ownership through form
    const submission = await shogo.db.submission.findUnique({
      where: { id: data.id },
      include: { form: true },
    })

    if (!submission || submission.form.userId !== data.userId) {
      throw new Error('Submission not found')
    }

    const updated = await shogo.db.submission.update({
      where: { id: data.id },
      data: { isRead: data.isRead },
    })

    return updated as SubmissionType
  })

// Delete a submission
export const deleteSubmission = createServerFn({ method: 'POST' })
  .inputValidator((data: { id: string; userId: string }) => data)
  .handler(async ({ data }) => {
    // Verify ownership through form
    const submission = await shogo.db.submission.findUnique({
      where: { id: data.id },
      include: { form: true },
    })

    if (!submission || submission.form.userId !== data.userId) {
      throw new Error('Submission not found')
    }

    await shogo.db.submission.delete({
      where: { id: data.id },
    })

    return { success: true }
  })

// Get form stats
export const getFormStats = createServerFn({ method: 'POST' })
  .inputValidator((data: { formId: string; userId: string }) => data)
  .handler(async ({ data }) => {
    // Verify form ownership
    const form = await shogo.db.form.findFirst({
      where: { id: data.formId, userId: data.userId },
    })
    if (!form) {
      throw new Error('Form not found')
    }

    const submissions = await shogo.db.submission.findMany({
      where: { formId: data.formId },
    })

    const today = new Date()
    today.setHours(0, 0, 0, 0)

    return {
      total: submissions.length,
      unread: submissions.filter(s => !s.isRead).length,
      today: submissions.filter(s => new Date(s.createdAt) >= today).length,
    } as FormStats
  })
