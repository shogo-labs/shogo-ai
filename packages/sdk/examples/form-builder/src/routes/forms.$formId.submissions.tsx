/**
 * Form Submissions List
 * 
 * Shows all responses to a form.
 */

import { createFileRoute, useRouter, Link } from '@tanstack/react-router'
import { getForm, type FormType } from '../utils/forms'
import { getSubmissions, markAsRead, deleteSubmission, type SubmissionType } from '../utils/submissions'
import { parseFieldOptions } from '../utils/fields'

export const Route = createFileRoute('/forms/$formId/submissions')({
  loader: async ({ params, context }) => {
    if (!context.user) {
      return { form: null, submissions: [] }
    }
    const [form, submissions] = await Promise.all([
      getForm({ data: { id: params.formId, userId: context.user.id } }),
      getSubmissions({ data: { formId: params.formId, userId: context.user.id } }),
    ])
    return { form, submissions }
  },
  component: SubmissionsList,
})

function SubmissionsList() {
  const { user } = Route.useRouteContext()
  const { form, submissions } = Route.useLoaderData()
  const router = useRouter()
  const { formId } = Route.useParams()

  if (!user || !form) {
    return (
      <article style={{ textAlign: 'center', padding: '3rem' }}>
        <h1>Form Not Found</h1>
        <Link to="/">Back to Dashboard</Link>
      </article>
    )
  }

  const handleMarkRead = async (id: string, isRead: boolean) => {
    await markAsRead({ data: { id, userId: user.id, isRead } })
    router.invalidate()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this submission?')) return
    await deleteSubmission({ data: { id, userId: user.id } })
    router.invalidate()
  }

  // Build a map of field labels
  const fieldMap = new Map(form.fields?.map((f) => [f.id, f]) || [])

  return (
    <article>
      <header style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <Link to="/forms/$formId" params={{ formId }} style={{ color: '#6b7280', textDecoration: 'none' }}>
            ← Back to {form.name}
          </Link>
        </div>
        <h1>Submissions</h1>
        <p style={{ color: '#666' }}>{submissions.length} total responses</p>
      </header>

      {submissions.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: '#666', background: '#f9fafb', borderRadius: '0.5rem' }}>
          <p>No submissions yet.</p>
          {form.isPublished ? (
            <p>Share your form link to start collecting responses!</p>
          ) : (
            <p>Publish your form to start collecting responses.</p>
          )}
        </div>
      ) : (
        <div style={{ border: '1px solid #e5e7eb', borderRadius: '0.5rem' }}>
          {submissions.map((submission) => (
            <div key={submission.id} className={`submission-row ${!submission.isRead ? 'unread' : ''}`}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <strong style={{ fontWeight: submission.isRead ? 400 : 600 }}>
                    {submission.respondentEmail || 'Anonymous'}
                  </strong>
                  {!submission.isRead && (
                    <span style={{ background: '#3b82f6', color: 'white', padding: '0.125rem 0.375rem', borderRadius: '9999px', fontSize: '0.625rem' }}>
                      NEW
                    </span>
                  )}
                </div>

                {/* Show first few responses */}
                <div style={{ fontSize: '0.875rem', color: '#4b5563' }}>
                  {submission.responses?.slice(0, 2).map((response) => {
                    const field = fieldMap.get(response.fieldId)
                    return (
                      <div key={response.id} style={{ marginBottom: '0.25rem' }}>
                        <span style={{ color: '#9ca3af' }}>{field?.label || 'Field'}:</span>{' '}
                        {response.value.length > 50 ? response.value.slice(0, 50) + '...' : response.value}
                      </div>
                    )
                  })}
                  {(submission.responses?.length || 0) > 2 && (
                    <span style={{ color: '#9ca3af' }}>
                      +{(submission.responses?.length || 0) - 2} more fields
                    </span>
                  )}
                </div>

                <p style={{ fontSize: '0.75rem', color: '#9ca3af', margin: '0.5rem 0 0' }}>
                  {new Date(submission.createdAt).toLocaleString()}
                </p>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  className="outline secondary"
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                  onClick={() => handleMarkRead(submission.id, !submission.isRead)}
                >
                  {submission.isRead ? 'Mark Unread' : 'Mark Read'}
                </button>
                <button
                  className="outline secondary"
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                  onClick={() => handleDelete(submission.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  )
}
